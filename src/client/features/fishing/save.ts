import { emptyJournal, parseJournal, type Journal } from './journal';

// The one place the journal meets the browser's storage. It's this browser's (single-player for now):
// the key is per feature, and nothing else reads it.

const KEY = 'office.game.fishing';

export function loadJournal(): Journal {
  try {
    return parseJournal(localStorage.getItem(KEY));
  } catch {
    return emptyJournal();
  }
}

export function saveJournal(j: Journal): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(j));
  } catch {
    // private window or storage full: it's only for this visit then
  }
}
