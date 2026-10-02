// The date side of "hold until": a <input type=date> value to the start of that local day (ms) and back,
// pure so it can be tested. The server accepts any whole number of ms from a day ago to two years ahead.

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-15" as an <input type=date> has it, for the day `ms` falls on in the viewer's time zone. */
export function dateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The start of the local day a date input's value names (ms); undefined for an empty or invalid value. */
export function dayStartMs(value: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  // new Date(2026, 1, 31) rolls over to March: not a real day.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  return date.getTime();
}

/** Whether a hold's "until" day has gone (the start of today counts as not yet). */
export function holdPassed(until: number | undefined, now: number): boolean {
  return until !== undefined && until < now;
}
