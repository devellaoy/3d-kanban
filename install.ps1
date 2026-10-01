# Install the latest 3d-kanban release (Agent Office with a kanban on top) on Windows and start it, no
# clone needed. In PowerShell:
#
#   irm https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.ps1 | iex
#
# To pass the office options, run it as a script block instead:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/devellaoy/3d-kanban/main/install.ps1))) --port 4700
#
# The first time the office starts it asks where to clone your projects, signs the GitHub CLI in if
# it isn't, and lets you pick your first repository to clone as a floor.
#
# Releases go in %LOCALAPPDATA%\3d-kanban and a `kanban3d` command in %LOCALAPPDATA%\3d-kanban\bin,
# which is added to your user PATH, so afterwards `kanban3d` starts it too, in PowerShell, cmd and
# Git Bash alike. Run the irm line
# again to update to the newest release. It works in Windows PowerShell 5.1 and PowerShell 7.
# (Its own install folder and command, so it sits beside an upstream agent-office install.
# The office itself still reads the AGENT_OFFICE_* variables and keeps its data in ~\agent-office.)
#
# Environment:
#   AGENT_OFFICE_VERSION       install this release (a tag like v0.1.68) instead of the newest
#   AGENT_OFFICE_INSTALL_DIR   where releases go (default %LOCALAPPDATA%\3d-kanban)
#   AGENT_OFFICE_BIN_DIR       where the `kanban3d` command goes (default <install dir>\bin; none: no command)
#   AGENT_OFFICE_NO_MODIFY_PATH  1: write the `kanban3d` command, but leave your user PATH alone
#   AGENT_OFFICE_INSTALL_ONLY  1: install, but don't start the office
#   AGENT_OFFICE_TARBALL       install this release tarball (a local file) instead of downloading one
#
# Everything runs inside a script block so that `irm | iex` leaves nothing behind in your session but
# the PATH addition, and errors throw instead of calling `exit`, which would close the PowerShell window
# it was pasted into.

& {
  param([string[]]$Passed)

  function Install-AgentOffice {
    param([string[]]$OfficeArgs = @())

    $ErrorActionPreference = 'Stop'
    # Windows PowerShell's progress bar makes downloads many times slower.
    $ProgressPreference = 'SilentlyContinue'
    # Windows PowerShell 5.1 may not offer TLS 1.2 by default, and GitHub requires it.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = 'devellaoy/3d-kanban'
    # The install folder and the release asset (3d-kanban.tgz).
    $name = '3d-kanban'
    # The command: it starts with a letter, so PowerShell runs it bare (a leading digit would parse as a number).
    $cmd = 'kanban3d'
    $marker = "$cmd launcher, written by install.ps1"
    $run = $cmd
    $installDir = if ($env:AGENT_OFFICE_INSTALL_DIR) { $env:AGENT_OFFICE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA $name }
    # Windows can't hold an empty environment variable (setting one to '' deletes it), so where
    # install.sh takes an empty AGENT_OFFICE_BIN_DIR for no launcher, this takes `none`.
    $binDir = if ($env:AGENT_OFFICE_BIN_DIR -eq 'none') { '' } elseif ($env:AGENT_OFFICE_BIN_DIR) { $env:AGENT_OFFICE_BIN_DIR } else { Join-Path $installDir 'bin' }
    # Absolute paths, resolved the way PowerShell does (~, the current location), since the .NET calls
    # below and the PATH entry would otherwise resolve them differently.
    $installDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($installDir)
    $versions = Join-Path $installDir 'versions'
    if ($binDir) { $binDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($binDir) }
    $utf8 = New-Object System.Text.UTF8Encoding($false)

    function Step([string]$msg) { Write-Host '==> ' -ForegroundColor Cyan -NoNewline; Write-Host $msg }
    function Warn([string]$msg) { Write-Host 'warning: ' -ForegroundColor Yellow -NoNewline; Write-Host $msg }
    function Have([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
    function ValidTag([string]$tag) { $tag -match '^v[0-9][0-9A-Za-z._+-]*$' }

    # Windows' own tar (bsdtar). A GNU tar from Git for Windows earlier on the PATH would read the
    # C: in a path as a remote host.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'

    # npm.cmd (nvm-windows, fnm, the Node installer) or npm.exe (Volta's shim), never npm.ps1, which the
    # execution policy may block, nor the extensionless sh script next to npm.cmd.
    $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue |
      Where-Object { $_.Source -match '\.(cmd|bat|exe)$' } | Select-Object -First 1 | ForEach-Object { $_.Source }

    function Check-Requirements {
      # Node.js 22, which the kanban's database module (better-sqlite3) needs.
      if (-not (Have 'node')) { throw '3d-kanban needs Node.js 22 or newer. Get it from https://nodejs.org (or nvm-windows), then run this again.' }
      # No quotes in the expression: Windows PowerShell 5.1 strips them from native command arguments.
      $major = [int](& node -p 'parseInt(process.versions.node)')
      if ($major -lt 22) { throw "3d-kanban needs Node.js 22 or newer, and this is $(& node -v). Update it, then run this again." }
      if (-not $npm) { throw "3d-kanban needs npm, which comes with Node.js." }
      if (-not (Test-Path -LiteralPath $tar)) { throw "this needs Windows' tar.exe (Windows 10 1803 or newer)." }
      if (-not (Have 'git')) { Warn "git isn't installed. The office needs it for projects and worker worktrees." }
      if (-not ((Have 'claude') -or (Have 'opencode') -or (Have 'codex') -or (Have 'dsh'))) {
        Warn 'no Claude Code, OpenCode, Codex or DeepSeek Harness CLI found on your PATH. Workers need one of them, e.g.'
        Warn '  irm https://claude.ai/install.ps1 | iex'
      }
    }

    # The newest release's tag, from where github.com/<repo>/releases/latest redirects (no API rate limit).
    function Latest-Tag {
      try {
        $req = [Net.HttpWebRequest]::Create("https://github.com/$repo/releases/latest")
        $req.Method = 'HEAD'
        $req.AllowAutoRedirect = $false
        $res = $req.GetResponse()
        try { $location = $res.Headers['Location'] } finally { $res.Close() }
        if ($location -match '/releases/tag/([^/?#]+)$') { return $Matches[1] }
      } catch {}
      return ''
    }

    # Unpacks a release tarball into <versions>\<tag> and installs its dependencies. Everything happens in
    # a scratch directory first, so a failed or interrupted install never leaves a broken version behind.
    # Returns the tag (read from the tarball when it isn't known yet).
    function Install-Release([string]$tag, [string]$tarball) {
      [IO.Directory]::CreateDirectory($versions) | Out-Null
      $stage = Join-Path $versions ('.install.' + [IO.Path]::GetRandomFileName())
      [IO.Directory]::CreateDirectory($stage) | Out-Null
      try {
        $tgz = Join-Path $stage "$name.tgz"
        if ($tarball) {
          Copy-Item -LiteralPath $tarball -Destination $tgz
        } else {
          Step "Downloading 3d-kanban $tag"
          try {
            try {
              Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/download/$tag/$name.tgz" -OutFile $tgz
            } catch {
              # The fork's first release (v0.1.3) still carried upstream's asset name, agent-office.tgz.
              Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/download/$tag/agent-office.tgz" -OutFile $tgz
            }
          } catch {
            throw "couldn't download release $tag (is that a release of https://github.com/$repo/releases ?): $($_.Exception.Message)"
          }
        }
        & $tar -xzf $tgz -C $stage | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "that isn't a release tarball" }
        $pkg = Join-Path $stage 'package'
        # The entry point keeps upstream's file name.
        if (-not (Test-Path -LiteralPath (Join-Path $pkg 'bin\agent-office.js'))) { throw "that release tarball doesn't contain 3d-kanban" }
        if (-not $tag) { $tag = 'v' + (& node -p 'require(process.argv[1]).version' (Join-Path $pkg 'package.json')) }
        if (-not (ValidTag $tag)) { throw "not a release version: $tag" }
        $dest = Join-Path $versions $tag
        $isInstalled = { Test-Path -LiteralPath (Join-Path $dest '.installed') }
        if (-not (& $isInstalled)) {
          # Say so before the install rather than after it. On Windows a half-removed version (a file
          # still open when it was pruned) is the usual cause.
          if (Test-Path -LiteralPath $dest) { throw "$dest is in the way; remove it and run this again" }
          Step "Installing 3d-kanban $tag"
          # Exactly the dependency versions the release was tested with (its npm-shrinkwrap.json).
          Push-Location -LiteralPath $pkg
          # Out-Host, or npm's output would become part of this function's return value.
          try { & $npm ci --omit=dev --no-audit --no-fund --loglevel=error | Out-Host } finally { Pop-Location }
          if ($LASTEXITCODE -ne 0) { throw "npm couldn't install 3d-kanban's dependencies (see above). Its database module needs Python 3 and Visual Studio's C++ build tools to install (tick 'Tools for Native Modules' in the Node.js installer, or install Visual Studio Build Tools with 'Desktop development with C++')." }
          [IO.File]::WriteAllText((Join-Path $pkg '.installed'), '')
          # Another run may have installed the same version meanwhile; either copy will do.
          if (-not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $pkg -Destination $dest }
          elseif (-not (& $isInstalled)) { throw "$dest is in the way; remove it and run this again" }
        }
        return $tag
      } finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
      }
    }

    # Removes the versions this install replaced, except any still running: an office, or the terminal
    # host that keeps its workers alive across office restarts.
    function Prune-Versions([string]$keep) {
      $running = @()
      # With slashes turned around, since the Git Bash launcher starts node with a C:/... path.
      try { $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object { "$($_.CommandLine)" -replace '/', '\' }) } catch { return }
      Get-ChildItem -LiteralPath $versions -Directory -Filter 'v*' | Where-Object { $_.Name -ne $keep } | ForEach-Object {
        $dir = $_.FullName + '\'
        if ($running | Where-Object { $_ -and $_.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) { return }
        # Windows won't delete files a process still has open; leave those for next time.
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      }
      # Scratch directories an earlier run couldn't remove (antivirus still scanning, or a hard kill).
      # Only old ones, in case another install is running right now.
      Get-ChildItem -LiteralPath $versions -Directory -Force -Filter '.install.*' |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }

    # Puts a `kanban3d` command on the PATH that starts this version: a .cmd for PowerShell and cmd,
    # and a sh script for Git Bash. Returns what to type to start it.
    function Write-Launcher([string]$tag, [string]$entry) {
      if (-not $binDir) { return '' }
      $cmdFile = Join-Path $binDir "$cmd.cmd"
      $shFile = Join-Path $binDir $cmd
      foreach ($f in @($cmdFile, $shFile)) {
        if ((Test-Path -LiteralPath $f) -and -not (Select-String -LiteralPath $f -SimpleMatch $marker -Quiet)) {
          Warn "left $f alone: this script didn't write it"
          return ''
        }
      }
      [IO.Directory]::CreateDirectory($binDir) | Out-Null
      $update = "irm https://raw.githubusercontent.com/$repo/main/install.ps1 | iex"
      # cmd reads a batch file in the console's code page, not UTF-8, so non-ASCII letters in a user name
      # would come out garbled. Under the default %LOCALAPPDATA% the path is written with the variable,
      # which cmd expands intact; anywhere else the file is written in that code page. A % in a path is
      # doubled, or cmd would take it for a variable.
      $local = $env:LOCALAPPDATA.TrimEnd('\') + '\'
      $cmdEntry = if ($entry.StartsWith($local, [StringComparison]::OrdinalIgnoreCase)) {
        '%LOCALAPPDATA%\' + ($entry.Substring($local.Length) -replace '%', '%%')
      } else { $entry -replace '%', '%%' }
      $oem = $utf8
      try { $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage) } catch {}
      [IO.File]::WriteAllText($cmdFile, (@(
        '@echo off',
        "rem $marker (https://github.com/$repo).",
        "rem Starts 3d-kanban $tag. To update, run the install command again in PowerShell:",
        "rem   $update",
        "node `"$cmdEntry`" %*"
      ) -join "`r`n") + "`r`n", $oem)
      $shEntry = $entry -replace '\\', '/' -replace "'", "'\''"
      [IO.File]::WriteAllText($shFile, (@(
        '#!/bin/sh',
        "# $marker (https://github.com/$repo).",
        "# Starts 3d-kanban $tag. To update, run the install command again in PowerShell:",
        "#   $update",
        "exec node '$shEntry' `"`$@`""
      ) -join "`n") + "`n", $utf8)

      $onPath = { param($list) [bool](($list -split ';') | Where-Object { $_ -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $binDir.TrimEnd('\') }) }
      if ($env:AGENT_OFFICE_NO_MODIFY_PATH -eq '1') {
        if (& $onPath $env:Path) { return $run }
        Warn "$binDir isn't on your PATH. Add it to run $run directly next time."
        return $cmdFile
      }
      # Through the registry, not [Environment]::SetEnvironmentVariable: that one would write back the
      # expanded PATH, turning entries like %USERPROFILE%\... into fixed paths.
      $added = $false
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      try {
        $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (-not (& $onPath $userPath)) {
          $key.SetValue('Path', ((@(($userPath -split ';') | Where-Object { $_ }) + $binDir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
          $added = $true
        }
      } finally { $key.Close() }
      if ($added) {
        # Setting and clearing a variable this way tells Explorer to reload the environment, so new
        # terminals see the new PATH.
        [Environment]::SetEnvironmentVariable('AGENT_OFFICE_INSTALL_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('AGENT_OFFICE_INSTALL_REFRESH', $null, 'User')
        Step "Added $binDir to your user PATH. Open a new terminal to run $run there."
      }
      if (-not (& $onPath $env:Path)) { $env:Path = "$env:Path;$binDir" }
      return $run
    }

    Check-Requirements

    $tag = ''
    $tarball = $env:AGENT_OFFICE_TARBALL
    $currentFile = Join-Path $installDir 'current'
    $installed = if (Test-Path -LiteralPath $currentFile) { "$(Get-Content -LiteralPath $currentFile -TotalCount 1)".Trim() } else { '' }
    if ($tarball) {
      if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) { throw "no such file: $tarball" }
      $tarball = (Resolve-Path -LiteralPath $tarball).Path
    } elseif ($env:AGENT_OFFICE_VERSION) {
      $tag = 'v' + $env:AGENT_OFFICE_VERSION.TrimStart('v')
    } else {
      $tag = Latest-Tag
      if (-not $tag) {
        if ($installed -and (Test-Path -LiteralPath (Join-Path $versions "$installed\.installed"))) {
          Warn "couldn't reach GitHub to look for a newer release; starting the installed $installed"
          $tag = $installed
        } else {
          throw "couldn't find the latest release at https://github.com/$repo/releases"
        }
      }
    }
    if ($tag -and -not (ValidTag $tag)) { throw "not a release version: $tag" }

    if ($tarball -or -not (Test-Path -LiteralPath (Join-Path $versions "$tag\.installed"))) {
      $tag = Install-Release $tag $tarball
    }
    [IO.File]::WriteAllText($currentFile, "$tag`n", $utf8)
    Prune-Versions $tag

    $entry = Join-Path $versions "$tag\bin\agent-office.js"
    $launcher = Write-Launcher $tag $entry

    if ($env:AGENT_OFFICE_INSTALL_ONLY -eq '1') {
      $start = if ($launcher) { $launcher } else { "node `"$entry`"" }
      Step "3d-kanban $tag is installed. Start it with: $start"
      return
    }
    Step "Starting 3d-kanban $tag"
    # Before PowerShell 7.3, an argument with a space and a trailing backslash (a tab-completed folder,
    # 'C:\My Project\') is quoted so that the backslash escapes the closing quote, and it swallows every
    # argument after it. Doubling the trailing backslashes gets it through intact.
    if ($PSVersionTable.PSVersion -lt [version]'7.3') {
      $OfficeArgs = @($OfficeArgs | ForEach-Object { if ($_ -match '\s' -and $_ -match '\\$') { $_ -replace '(\\+)$', '$1$1' } else { $_ } })
    }
    & node $entry @OfficeArgs
  }

  Install-AgentOffice -OfficeArgs $Passed
} $args
