// 3d-kanban: a YouTube video's title from YouTube's oEmbed (no API key), for the TV and the hint bar.

const TIMEOUT_MS = 4000;

/** How a title is looked up; tests swap `fetch` for one that never leaves the machine. */
export const youtubeTitles = {
  /** The title of what `url` (a youtube.com link) plays, or undefined when YouTube won't say. */
  async fetch(url: string): Promise<string | undefined> {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; 3d-kanban; +https://github.com/devellaoy/3d-kanban)' },
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        return undefined;
      }
      const body = (await res.json()) as { title?: unknown };
      return typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
    } catch {
      return undefined;
    }
  },
};
