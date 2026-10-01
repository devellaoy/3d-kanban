// The appearances of the pages (⚙️ Settings → You → Theme): which there are, which one this browser
// has chosen, and putting it on the page. Pure: no three.js and nothing touched at load, so the 2D
// view, the sign-in pages and the tests can all use it. ("Theme" elsewhere means the holiday
// decorations; this is the look of the windows, the HUD, the kanban and the 2D view.)

export interface Appearance {
  id: string;
  label: string;
  icon: string;
  /** What the browser's own controls (scrollbars, form fields) should look like. */
  colorScheme: 'light' | 'dark';
  /** The installed app's title bar colour, kept in `<meta name="theme-color">`. */
  themeColor: string;
  blurb: string;
}

/** Every appearance. A new one is also a file `themes/<id>.css` and its `@import` in `themes/index.css`. */
export const APPEARANCES = [
  { id: 'default', label: 'Office', icon: '🧡', colorScheme: 'light', themeColor: '#fff1de', blurb: 'The warm, toy-like look the office has always had.' },
  { id: 'dark', label: 'Dark', icon: '🌙', colorScheme: 'dark', themeColor: '#212121', blurb: 'Dark grey surfaces and soft contrast, easy on the eyes at night.' },
  { id: 'glossy', label: 'Glossy', icon: '✨', colorScheme: 'light', themeColor: '#f5f5f7', blurb: 'Light, airy and rounded, with frosted glass and soft shadows.' },
] as const satisfies readonly Appearance[];

export type AppearanceId = (typeof APPEARANCES)[number]['id'];

/** Where this browser keeps its choice (the pages' head scripts read the same key). */
export const APPEARANCE_KEY = 'agent-office.appearance';

/** What the page has until a choice is made. */
const FALLBACK: AppearanceId = 'default';

/** The appearance an id names; anything unknown is the default. */
export function parseAppearance(raw: unknown): AppearanceId {
  return APPEARANCES.find((a) => a.id === raw)?.id ?? FALLBACK;
}

export function appearanceOf(id: AppearanceId): (typeof APPEARANCES)[number] {
  return APPEARANCES.find((a) => a.id === id) ?? APPEARANCES[0];
}

/** This browser's choice. */
export function loadAppearance(): AppearanceId {
  try {
    return parseAppearance(localStorage.getItem(APPEARANCE_KEY));
  } catch {
    return FALLBACK;
  }
}

export function saveAppearance(id: AppearanceId): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, id);
  } catch {
    // Private mode or storage blocked: the choice lasts until the page closes.
  }
}

/**
 * Puts an appearance on the page: `data-theme` and the installed app's colour (each theme's sheet sets
 * its own `color-scheme`). Does nothing when the page already shows it; the head script sets `data-theme`
 * before this runs, so the colour is checked too.
 */
export function applyAppearance(id: AppearanceId): void {
  const a = appearanceOf(id);
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (root.dataset.theme === a.id && (!meta || meta.getAttribute('content') === a.themeColor)) return;
  root.dataset.theme = a.id;
  meta?.setAttribute('content', a.themeColor);
  window.dispatchEvent(new CustomEvent('appearancechange', { detail: a.id }));
}

/** Chooses an appearance: keeps it, and shows it. */
export function setAppearance(id: AppearanceId): void {
  saveAppearance(id);
  applyAppearance(id);
}

let watching = false;

/** Follows a change made in another tab (the kanban and the office are separate pages). */
export function watchAppearance(): void {
  if (watching) return;
  watching = true;
  window.addEventListener('storage', (e) => {
    if (e.key === APPEARANCE_KEY || e.key === null) applyAppearance(loadAppearance());
  });
}

/** What every page's entry point calls: shows this browser's choice and follows it across tabs. */
export function initAppearance(): void {
  applyAppearance(loadAppearance());
  watchAppearance();
}
