# Testing

Run `npm run typecheck`, `npm test` and `npm run build` from the repository root.

The kanban fixtures provide Windows batch launchers for their fake Claude and Codex agents.
DSH fixtures use a native Node executable on Windows and a shell launcher on POSIX systems.
Fixture cleanup waits for DSH child processes to stop before deleting their working directories.

Settings and upload behavior is tested on every platform. Exact Unix permission-bit assertions
run only on POSIX systems; Windows file modes do not represent those permissions.

Path-escape tests use directory junctions on Windows without needing administrator privileges.
The Codex file-symlink subtest runs when symlink creation is available. If Windows returns
`EPERM`, only that subtest is explicitly skipped; its other path-validation checks still run.
Enable Windows Developer Mode or run with symlink privileges to exercise that subtest too.

Optional model-generated task labels fall back to prompt text if the naming executable cannot
be launched. Tests cover synchronous launch failures as well as asynchronous process errors.
