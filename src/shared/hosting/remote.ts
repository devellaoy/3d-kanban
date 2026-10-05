// Where a repository is hosted, from its git remote or a pull request's URL: GitHub, Azure DevOps
// (Azure Repos) or Bitbucket (Cloud, or a Bitbucket Server / Data Center host the office is told
// about). Pure, shared by the server and the pages.
//
// A repository is named by one string everywhere the office keeps one (ProjectRepo.remote,
// GhPull.repo, KanbanPrLink.repo): GitHub's stays `owner/name`, exactly as before, and every other
// host's is qualified with its kind, so they can never be taken for each other:
//   azure:org/project/repo   bitbucket:workspace/repo   bitbucket-server:host/PROJECT/repo

import { normalizeRepo } from '../floors.js';

export type HostKind = 'github' | 'azure' | 'bitbucket' | 'bitbucket-server';

/** The hosts other than GitHub, which the office reaches over their REST APIs (src/server/hosting/). */
export type OtherHost = Exclude<HostKind, 'github'>;

export const OTHER_HOSTS: readonly OtherHost[] = ['azure', 'bitbucket', 'bitbucket-server'];

export interface RepoRef {
  host: HostKind;
  /** The office's name for it (see above). */
  id: string;
  /** Its page on the host. */
  web: string;
  /** GitHub's owner, Azure DevOps' organization, Bitbucket's workspace (or a Server host's project key). */
  owner: string;
  /** Azure DevOps' project. */
  project?: string;
  /** The repository's own name. */
  name: string;
  /** A Bitbucket Server host (host[:port]). */
  server?: string;
}

const LABELS: Record<HostKind, string> = { github: 'GitHub', azure: 'Azure DevOps', bitbucket: 'Bitbucket', 'bitbucket-server': 'Bitbucket Server' };

/** The host's name, for "Open on …" and messages. */
export function hostLabel(kind: HostKind | undefined): string {
  return LABELS[kind ?? 'github'];
}

const OWNER = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const NAME = /^[a-zA-Z0-9_.-]{1,100}$/;
/** Azure DevOps names: organizations are plain, projects and repositories may have spaces and more. */
const AZ_ORG = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/;
const AZ_NAME = /^[^/\\#?:*"<>|;+=&%\p{C}]{1,64}$/u;
const BB_NAME = /^[a-zA-Z0-9_.-]{1,128}$/;
const HOSTNAME = /^[a-zA-Z0-9.-]{1,253}(?::\d{1,5})?$/;

function decode(s: string): string | undefined {
  try {
    return decodeURIComponent(s).trim();
  } catch {
    return undefined;
  }
}

const azName = (s: string | undefined) => (s && AZ_NAME.test(s) && s !== '.' && s !== '..' ? s : undefined);

function github(owner: string, name: string): RepoRef | undefined {
  name = name.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return undefined;
  return { host: 'github', id: `${owner}/${name}`, web: `https://github.com/${owner}/${name}`, owner, name };
}

function azure(org: string, project: string | undefined, name: string | undefined): RepoRef | undefined {
  const p = azName(project && decode(project));
  const n = azName(name && decode(name)?.replace(/\.git$/i, ''));
  if (!AZ_ORG.test(org) || !p || !n) return undefined;
  const web = `https://dev.azure.com/${org}/${encodeURIComponent(p)}/_git/${encodeURIComponent(n)}`;
  return { host: 'azure', id: `azure:${org}/${p}/${n}`, web, owner: org, project: p, name: n };
}

function bitbucket(ws: string, name: string): RepoRef | undefined {
  name = name.replace(/\.git$/i, '');
  if (!BB_NAME.test(ws) || !BB_NAME.test(name) || name === '.' || name === '..') return undefined;
  return { host: 'bitbucket', id: `bitbucket:${ws.toLowerCase()}/${name.toLowerCase()}`, web: `https://bitbucket.org/${ws.toLowerCase()}/${name.toLowerCase()}`, owner: ws.toLowerCase(), name: name.toLowerCase() };
}

function bitbucketServer(server: string, project: string, name: string): RepoRef | undefined {
  name = name.replace(/\.git$/i, '');
  if (!HOSTNAME.test(server) || !BB_NAME.test(project.replace(/^~/, '')) || !BB_NAME.test(name)) return undefined;
  const key = project.toUpperCase();
  const web = project.startsWith('~') ? `https://${server}/users/${project.slice(1)}/repos/${name}` : `https://${server}/projects/${key}/repos/${name}`;
  return { host: 'bitbucket-server', id: `bitbucket-server:${server.toLowerCase()}/${key}/${name.toLowerCase()}`, web, owner: key, name: name.toLowerCase(), server: server.toLowerCase() };
}

/** host[:port] without the port, lower-cased. */
const bare = (host: string) => host.toLowerCase().replace(/:\d+$/, '');

/**
 * Where a git remote URL points: https, ssh:// or scp-like (git@host:path), with or without a user,
 * a port or `.git`. `serverHosts` are the Bitbucket Server / Data Center hosts the office knows of.
 * Undefined for anything else (a local path, an unknown host).
 */
export function parseRemote(url: unknown, serverHosts: readonly string[] = []): RepoRef | undefined {
  if (typeof url !== 'string') return undefined;
  const s = url.trim();
  if (!s || s.length > 500) return undefined;
  let host: string;
  let pathPart: string;
  let port = '';
  const scheme = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.*)$/i.exec(s);
  const scp = scheme ? null : /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(s);
  if (scheme) [, host, port = '', pathPart] = scheme;
  else if (scp) [, host, pathPart] = scp;
  else return undefined;
  host = host.toLowerCase();
  const parts = pathPart.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (host === 'github.com' || host === 'www.github.com') return parts.length >= 2 ? github(parts[0], parts[1]) : undefined;
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    // git@ssh.dev.azure.com:v3/org/project/repo
    const at = parts[0] === 'v3' ? 1 : 0;
    return parts.length >= at + 3 ? azure(parts[at], parts[at + 1], parts[at + 2]) : undefined;
  }
  if (host === 'dev.azure.com') {
    // https://dev.azure.com/org/project/_git/repo (the project may be left out when it's named like the repo)
    const git = parts.indexOf('_git');
    if (git < 1 || git + 1 >= parts.length) return undefined;
    return azure(parts[0], git >= 2 ? parts[1] : parts[git + 1], parts[git + 1]);
  }
  const vs = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/.exec(host);
  if (vs) {
    // https://org.visualstudio.com/[DefaultCollection/]project/_git/repo
    const rest = parts[0]?.toLowerCase() === 'defaultcollection' ? parts.slice(1) : parts;
    const git = rest.indexOf('_git');
    if (git < 0 || git + 1 >= rest.length) return undefined;
    return azure(vs[1], git >= 1 ? rest[0] : rest[git + 1], rest[git + 1]);
  }
  if (host === 'bitbucket.org' || host === 'www.bitbucket.org') return parts.length >= 2 ? bitbucket(parts[0], parts[1]) : undefined;
  const server = serverHosts.find((h) => bare(h) === host);
  if (server) {
    // https://host/scm/PROJECT/repo.git, ssh://git@host:7999/PROJECT/repo.git, https://host/projects/P/repos/r
    const named = server.includes(':') ? server.toLowerCase() : port && !scheme?.[0].startsWith('ssh') ? `${host}:${port}` : host;
    if (parts[0] === 'projects' && parts[2] === 'repos' && parts.length >= 4) return bitbucketServer(named, parts[1], parts[3]);
    if (parts[0] === 'users' && parts[2] === 'repos' && parts.length >= 4) return bitbucketServer(named, `~${parts[1]}`, parts[3]);
    const p = parts[0] === 'scm' ? parts.slice(1) : parts;
    return p.length >= 2 ? bitbucketServer(named, p[0], p[1]) : undefined;
  }
  return undefined;
}

/** The host an office repository name (see above) is on. */
export function hostOf(id: string | undefined): HostKind {
  const m = /^(azure|bitbucket|bitbucket-server):/.exec(id ?? '');
  return (m?.[1] as HostKind | undefined) ?? 'github';
}

/** An office repository name (see above) back as a RepoRef; undefined when it isn't one. */
export function repoRefOf(id: string | undefined): RepoRef | undefined {
  if (!id) return undefined;
  const kind = hostOf(id);
  const rest = id.slice(kind === 'github' ? 0 : kind.length + 1);
  const p = rest.split('/');
  if (kind === 'github') return p.length === 2 ? github(p[0], p[1]) : undefined;
  if (kind === 'azure') return p.length === 3 ? azure(p[0], encodeURIComponent(p[1]), encodeURIComponent(p[2])) : undefined;
  if (kind === 'bitbucket') return p.length === 2 ? bitbucket(p[0], p[1]) : undefined;
  return p.length === 3 ? bitbucketServer(p[0], p[1], p[2]) : undefined;
}

/** A pull request's page on its host. */
export function prWebUrl(repo: RepoRef, n: number): string {
  if (repo.host === 'github') return `${repo.web}/pull/${n}`;
  if (repo.host === 'azure') return `${repo.web}/pullrequest/${n}`;
  return `${repo.web}/pull-requests/${n}`;
}

/**
 * A pull request's URL taken apart: its repository and number, for GitHub (…/pull/12), Azure DevOps
 * (…/_git/repo/pullrequest/12, on dev.azure.com or *.visualstudio.com) and Bitbucket
 * (…/pull-requests/12). Undefined for anything else.
 */
export function parsePrUrl(url: unknown, serverHosts: readonly string[] = []): { repo: RepoRef; number: number; url: string } | undefined {
  if (typeof url !== 'string' || url.length > 500) return undefined;
  const m = /^(https?:\/\/[^?#]+?)\/(?:pull|pullrequest|pull-requests)\/(\d{1,9})(?:[/?#].*)?$/i.exec(url.trim());
  if (!m) return undefined;
  const repo = parseRemote(m[1], serverHosts);
  const number = Number(m[2]);
  if (!repo || !number) return undefined;
  const kind = /\/(pull|pullrequest|pull-requests)\/\d/i.exec(url)![1].toLowerCase();
  const expected = repo.host === 'github' ? 'pull' : repo.host === 'azure' ? 'pullrequest' : 'pull-requests';
  if (kind !== expected) return undefined;
  return { repo, number, url: prWebUrl(repo, number) };
}

/** The host a pull request's (or any) URL is on, by its address alone; undefined when it's none the office knows. */
export function hostOfUrl(url: string | undefined, serverHosts: readonly string[] = []): HostKind | undefined {
  const m = /^https?:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url ?? '');
  if (!m) return undefined;
  const h = m[1].toLowerCase();
  if (h === 'github.com' || h === 'www.github.com') return 'github';
  if (h === 'dev.azure.com' || h.endsWith('.visualstudio.com')) return 'azure';
  if (h === 'bitbucket.org' || h === 'www.bitbucket.org') return 'bitbucket';
  return serverHosts.some((s) => bare(s) === h) ? 'bitbucket-server' : undefined;
}

/**
 * A repository as someone typed or pasted it (or as it was saved): GitHub's owner/name or URL as
 * normalizeRepo has it, or another host's URL or office name. Undefined for anything else.
 */
export function normalizeRemote(value: unknown, serverHosts: readonly string[] = []): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  const other = hostOf(s) !== 'github' ? repoRefOf(s) : parseRemote(s, serverHosts);
  if (other && other.host !== 'github') return other.id;
  return normalizeRepo(s);
}

/** How a repository's name reads for a person or an agent: GitHub's owner/name, another host's name and page. */
export function remoteLabel(id: string): string {
  const r = hostOf(id) === 'github' ? undefined : repoRefOf(id);
  return r ? `${hostLabel(r.host)}: ${r.web}` : id;
}
