import type { Accounts } from '../accounts.js';
import type { Me } from '../../shared/protocol.js';
import type { Ctx, People } from './context.js';
import type { Client } from './client.js';

/** WebSocket close code for a session that stopped counting: the account was revoked, or the shared password switched off. */
const SIGNED_OUT = 4001;

/** Who the people in the office are signed in as, and telling them when that changes. */
export function people(ctx: Ctx): People {
  /** Who a connection is: its account's current name and role, or an admin guest on the shared password. */
  const meOf = (accountId: string | undefined): Me => {
    const a = ctx.accounts.get(accountId);
    return a ? { account: { name: a.name, role: a.role }, admin: a.role === 'admin' } : { admin: !accountId };
  };
  /** Like meOf, for a connection: a visitor is never an admin (they have no account here to look up). */
  const meOfClient = (c: Client): Me => (c.visitor ? { ...meOf(c.accountId), admin: false, visitor: true } : meOf(c.accountId));
  /** Still signed in: the account wasn't revoked, and the shared password wasn't switched off. */
  const stillIn = (c: Client) => (c.accountId ? !!ctx.accounts.get(c.accountId) : ctx.accounts.sharedPassword);
  const signOut = (c: Client) => {
    c.out = true;
    c.ws.close(SIGNED_OUT, 'Signed out');
  };
  const onlineAccounts = () => new Set([...ctx.clients.values()].map((c) => c.accountId).filter((id): id is string => !!id));
  /** Tells each admin what the accounts are now, and everyone whether they're (still) an admin. */
  const accountsChanged = () => {
    let state: ReturnType<Accounts['state']> | undefined;
    for (const c of ctx.clients.values()) {
      // A visitor is the other office's guest: not one of our accounts, so there is nothing to sign out or tell.
      if (c.out || c.visitor) continue;
      if (!stillIn(c)) {
        signOut(c);
        continue;
      }
      const me = meOf(c.accountId);
      if (me.admin !== c.admin) {
        c.admin = me.admin;
        ctx.sendTo(c, { t: 'me', me });
      }
      if (me.admin) ctx.sendTo(c, { t: 'accounts', state: (state ??= ctx.accounts.state(onlineAccounts())) });
    }
  };
  return { meOf, meOfClient, stillIn, signOut, onlineAccounts, accountsChanged };
}
