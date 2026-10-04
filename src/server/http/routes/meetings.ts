// The earlier meetings: the list, one meeting in full, one meeting's notes files and one file's text (see meeting-files.ts).
// Not for visitors (multiplayer/paths.ts doesn't list these, so a visitor's request gets a 403).
import { listMeetingFiles, listMeetings, meetingRecordOf, readMeetingFile } from '../../meeting-files.js';
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
      const past = floor.meetings.pastRecords();
      const finished = floor.meetings.finished();
      if (p === '/api/meetings') return send(res, 200, await listMeetings(root, past, finished), HEADERS);
      const one = /^\/api\/meetings\/([^/]+)$/.exec(p);
      if (one) {
        const r = await meetingRecordOf(root, one[1], past, finished);
        return 'error' in r ? send(res, r.status, { error: r.error }, HEADERS) : send(res, 200, r, HEADERS);
      }
      const m = /^\/api\/meetings\/([^/]+)\/(files|file)$/.exec(p);
      if (!m) return send(res, 404, { error: 'Not found' }, HEADERS);
      let r;
      if (m[2] === 'file') r = await readMeetingFile(root, m[1], url.searchParams.get('name') ?? '');
      else {
        // The record's output says which file is the output: agents' notes are merged into the same folder.
        const known = await meetingRecordOf(root, m[1], past, finished);
        r = await listMeetingFiles(root, m[1], 'error' in known || known.orphan ? undefined : known.output);
      }
      return 'error' in r ? send(res, r.status, { error: r.error }, HEADERS) : send(res, 200, r, HEADERS);
    },
  },
} satisfies Record<string, Route>;
