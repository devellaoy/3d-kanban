// Azure DevOps and Bitbucket tokens: your own (accounts), and the office's own (admins, and an office
// on the shared password). See hosting/credentials.ts; a token goes in and never comes back out.
import type { HostingClientMsg } from '../../../shared/protocol/hosting.js';
import { OTHER_HOSTS, type OtherHost } from '../../../shared/hosting/remote.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { str } from '../../office/input.js';
import { hostCredentials } from '../../hosting/index.js';
import type { HandlerMap } from './types.js';

const kindOf = (v: unknown): OtherHost | undefined => OTHER_HOSTS.find((k) => k === v);

/** Whose tokens a message is about: the office's (admins only) or the asker's account; a string is why not. */
function scopeOf(ctx: Ctx, c: Client, office: unknown): string | null | { error: string } {
  const me = ctx.meOfClient(c);
  if (office === true || !c.accountId) return me.admin ? null : { error: "Only an admin sets the office's own tokens" };
  return c.accountId;
}

const send = (ctx: Ctx, c: Client) => {
  const creds = hostCredentials();
  if (creds) ctx.sendTo(c, { t: 'hosting', state: creds.state(c.accountId, ctx.meOfClient(c).admin) });
};

export const hostingHandlers = {
  'hosting.get'(ctx, c) {
    send(ctx, c);
  },
  'hosting.set'(ctx, c, msg) {
    const kind = kindOf(msg.kind);
    const creds = hostCredentials();
    if (!kind || !creds) return;
    const scope = scopeOf(ctx, c, msg.office);
    if (scope !== null && typeof scope === 'object') return ctx.sendTo(c, { t: 'hosting.saved', kind, error: scope.error });
    void creds.set(scope, { kind, token: str(msg.token, 600), ...(msg.email ? { email: str(msg.email, 320) } : {}), ...(msg.org ? { org: str(msg.org, 200) } : {}) }).then((error) => {
      ctx.sendTo(c, { t: 'hosting.saved', kind, ...(error ? { error } : {}) });
      send(ctx, c);
    });
  },
  'hosting.clear'(ctx, c, msg) {
    const kind = kindOf(msg.kind);
    const creds = hostCredentials();
    if (!kind || !creds) return;
    const scope = scopeOf(ctx, c, msg.office);
    if (scope !== null && typeof scope === 'object') return ctx.sendTo(c, { t: 'hosting.saved', kind, error: scope.error });
    creds.clear(scope, kind);
    ctx.sendTo(c, { t: 'hosting.saved', kind });
    send(ctx, c);
  },
  'hosting.servers'(ctx, c, msg) {
    const creds = hostCredentials();
    if (!creds) return;
    if (!ctx.meOfClient(c).admin) return ctx.sendTo(c, { t: 'hosting.saved', kind: 'servers', error: 'Only an admin sets the Bitbucket Server hosts' });
    const error = creds.setServerHosts(msg.hosts);
    ctx.sendTo(c, { t: 'hosting.saved', kind: 'servers', ...(error ? { error } : {}) });
    send(ctx, c);
  },
} satisfies HandlerMap<HostingClientMsg>;
