// Where a repository is hosted, from its remote or a pull request's URL (shared/hosting/remote.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostLabel, hostOf, hostOfUrl, parsePrUrl, parseRemote, prWebUrl, repoRefOf } from '../src/shared/hosting/remote.ts';
import { normalizeRepo } from '../src/shared/floors.ts';

test('GitHub remotes keep the owner/name the office always used', () => {
  for (const url of ['https://github.com/devellaoy/3d-kanban.git', 'https://github.com/devellaoy/3d-kanban', 'git@github.com:devellaoy/3d-kanban.git', 'ssh://git@github.com/devellaoy/3d-kanban.git', 'https://user@github.com/devellaoy/3d-kanban/']) {
    const r = parseRemote(url);
    assert.equal(r?.host, 'github', url);
    assert.equal(r?.id, 'devellaoy/3d-kanban', url);
    assert.equal(r?.id, normalizeRepo(url), url);
    assert.equal(r?.web, 'https://github.com/devellaoy/3d-kanban');
  }
  assert.equal(hostOf('devellaoy/3d-kanban'), 'github');
});

test('Azure DevOps remotes: dev.azure.com, ssh.dev.azure.com and *.visualstudio.com', () => {
  const want = { host: 'azure', id: 'azure:contoso/Fabrikam Web/web app', owner: 'contoso', project: 'Fabrikam Web', name: 'web app' };
  for (const url of [
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web%20app',
    'https://contoso@dev.azure.com/contoso/Fabrikam%20Web/_git/web%20app',
    'git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web%20app',
    'ssh://git@ssh.dev.azure.com:22/v3/contoso/Fabrikam%20Web/web%20app',
    'https://contoso.visualstudio.com/Fabrikam%20Web/_git/web%20app',
    'https://contoso.visualstudio.com/DefaultCollection/Fabrikam%20Web/_git/web%20app',
    'contoso@vs-ssh.visualstudio.com:v3/contoso/Fabrikam%20Web/web%20app',
  ]) {
    const r = parseRemote(url);
    assert.deepEqual(r && { host: r.host, id: r.id, owner: r.owner, project: r.project, name: r.name }, want, url);
  }
  assert.equal(parseRemote('https://dev.azure.com/contoso/Web/_git/Web')?.web, 'https://dev.azure.com/contoso/Web/_git/Web');
  // The project may be left out when it's named like the repository.
  assert.equal(parseRemote('https://dev.azure.com/contoso/_git/Web')?.id, 'azure:contoso/Web/Web');
  assert.equal(hostOf('azure:contoso/Web/Web'), 'azure');
});

test('Bitbucket Cloud remotes, and Bitbucket Server only for a host the office knows', () => {
  for (const url of ['https://bitbucket.org/Acme/Widget.git', 'https://jane@bitbucket.org/acme/widget.git', 'git@bitbucket.org:acme/widget.git']) {
    const r = parseRemote(url);
    assert.equal(r?.id, 'bitbucket:acme/widget', url);
    assert.equal(r?.web, 'https://bitbucket.org/acme/widget');
  }
  assert.equal(parseRemote('https://git.example.com/scm/PROJ/widget.git'), undefined);
  const servers = ['git.example.com'];
  for (const url of ['https://git.example.com/scm/proj/widget.git', 'ssh://git@git.example.com:7999/proj/widget.git', 'https://git.example.com/projects/PROJ/repos/widget/browse']) {
    const r = parseRemote(url, servers);
    assert.equal(r?.host, 'bitbucket-server', url);
    assert.equal(r?.id, 'bitbucket-server:git.example.com/PROJ/widget', url);
  }
});

test('anything else is no repository the office knows', () => {
  for (const url of ['', '/srv/git/repo.git', 'file:///srv/repo', 'https://gitlab.com/a/b.git', 'https://github.com/only-owner', 'https://dev.azure.com/org/project', 'https://github.com/../x', 'not a url', 42]) assert.equal(parseRemote(url), undefined, String(url));
});

test('repoRefOf turns the office name back into the repository', () => {
  for (const url of ['https://github.com/o/r', 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web%20app', 'git@bitbucket.org:acme/widget.git']) {
    const r = parseRemote(url)!;
    assert.deepEqual(repoRefOf(r.id), r);
  }
  assert.equal(repoRefOf('azure:only/two'), undefined);
  assert.equal(repoRefOf(undefined), undefined);
});

test('pull request URLs on each host', () => {
  assert.deepEqual(parsePrUrl('https://github.com/o/r/pull/12/files'), { repo: parseRemote('https://github.com/o/r'), number: 12, url: 'https://github.com/o/r/pull/12' });
  const az = parsePrUrl('https://dev.azure.com/contoso/Fabrikam%20Web/_git/web%20app/pullrequest/7?_a=overview');
  assert.equal(az?.repo.id, 'azure:contoso/Fabrikam Web/web app');
  assert.equal(az?.number, 7);
  assert.equal(az?.url, 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web%20app/pullrequest/7');
  assert.equal(parsePrUrl('https://contoso.visualstudio.com/Web/_git/api/pullrequest/3')?.url, 'https://dev.azure.com/contoso/Web/_git/api/pullrequest/3');
  const bb = parsePrUrl('https://bitbucket.org/acme/widget/pull-requests/5/diff');
  assert.equal(bb?.repo.id, 'bitbucket:acme/widget');
  assert.equal(bb?.url, 'https://bitbucket.org/acme/widget/pull-requests/5');
  // The path has to be the host's own.
  assert.equal(parsePrUrl('https://github.com/o/r/pull-requests/5'), undefined);
  assert.equal(parsePrUrl('https://bitbucket.org/acme/widget/pull/5'), undefined);
  assert.equal(parsePrUrl('https://example.com/o/r/pull/5'), undefined);
  assert.equal(prWebUrl(parseRemote('git@bitbucket.org:acme/widget.git')!, 9), 'https://bitbucket.org/acme/widget/pull-requests/9');
});

test('hostOfUrl and hostLabel', () => {
  assert.equal(hostOfUrl('https://github.com/o/r/pull/1'), 'github');
  assert.equal(hostOfUrl('https://dev.azure.com/o/p/_git/r/pullrequest/1'), 'azure');
  assert.equal(hostOfUrl('https://org.visualstudio.com/p/_git/r'), 'azure');
  assert.equal(hostOfUrl('https://bitbucket.org/a/b'), 'bitbucket');
  assert.equal(hostOfUrl('https://git.example.com/projects/P'), undefined);
  assert.equal(hostOfUrl('https://git.example.com/projects/P', ['git.example.com']), 'bitbucket-server');
  assert.equal(hostLabel('azure'), 'Azure DevOps');
  assert.equal(hostLabel(undefined), 'GitHub');
});
