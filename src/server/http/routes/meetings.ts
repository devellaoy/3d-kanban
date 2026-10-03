// The earlier meetings: the list, one meeting's notes files and one file's text (see meeting-files.ts).
// Not for visitors (multiplayer/paths.ts doesn't list these, so a visitor's request gets a 403).
import { listMeetingFiles, listMeetings, readMeetingFile } from '../../meeting-files.js';
import { send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

/** Notes are the floor's own: shown as they are, never sniffed into anything else, never kept. */
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export const meetingRoutes = {
  archive: {
    method: 'GET',
    prefix: '/api/meetings',
    auth: 'session',
    async handle(ctx, { res, url, path: p }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' }, HEADERS);
      const root = floor.meetings.archiveDir();
      if (p === '/api/meetings') return send(res, 200, await listMeetings(root, floor.meetings.pastRecords(), floor.meetings.finished()), HEADERS);
      const m = /^\/api\/meetings\/([^/]+)\/(files|file)$/.exec(p);
      if (!m) return send(res, 404, { error: 'Not found' }, HEADERS);
      const r = m[2] === 'files' ? await listMeetingFiles(root, m[1]) : await readMeetingFile(root, m[1], url.searchParams.get('name') ?? '');
      return 'error' in r ? send(res, r.status, { error: r.error }, HEADERS) : send(res, 200, r, HEADERS);
    },
  },
} satisfies Record<string, Route>;
