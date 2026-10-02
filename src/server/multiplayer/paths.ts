// The only HTTP a visitor's office may ask of the owner's: read-only GETs for what the windows of a
// shared floor show (a PR or issue, a task's changes, an attachment, a whiteboard picture, a wall
// picture). The router enforces this for every visitor request (ahead of the routes), and the
// tunnel (httpgate.ts) checks the path again before it even makes the request.
const ALLOWED = [
  /^\/api\/gh\/(pull|issue|labels|pull\/diff)$/,
  /^\/api\/kanban\/tasks\/\d{1,12}\/(changes|commits|commit|uncommitted|reports)$/,
  /^\/api\/kanban\/tasks\/\d{1,12}\/reports\/[^/]{1,200}$/,
  /^\/api\/kanban\/attachments\/[A-Za-z0-9_-]{1,64}$/,
  /^\/api\/whiteboard\/file$/,
  /^\/api\/image$/,
];

/** Whether a visitor may make this request (`pathname` decoded). */
export const visitorPath = (method: string | undefined, pathname: string): boolean => method === 'GET' && ALLOWED.some((re) => re.test(pathname));
