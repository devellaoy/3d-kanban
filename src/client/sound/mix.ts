// The kinds of office sound that each have a volume of their own in ⚙️ Settings, under the master.
// No imports, so the settings (and the kanban page that shares them) can read it without the audio.

/** Each kind of sound, in the order Settings lists them (see AudioCore.mix for what goes where). */
export const MIXES = ['background', 'rain', 'thumps', 'steps', 'typing', 'effects', 'alerts'] as const;
export type Mix = (typeof MIXES)[number];

/** One kind's level, 0–1, and its mute, which keeps the level. */
export interface MixLevel {
  volume: number;
  muted: boolean;
}

export type MixLevels = Record<Mix, MixLevel>;

/** Every kind at full, so the master alone sets how loud the office is until you change one. */
export function mixDefaults(): MixLevels {
  return Object.fromEntries(MIXES.map((k) => [k, { volume: 1, muted: false }])) as MixLevels;
}

/** What was saved, read back: each kind's level clamped to 0–1, and the defaults for anything missing or broken. */
export function cleanMix(saved: unknown): MixLevels {
  const out = mixDefaults();
  if (!saved || typeof saved !== 'object') return out;
  for (const k of MIXES) {
    const v = (saved as Record<string, Partial<MixLevel> | undefined>)[k];
    if (typeof v?.volume === 'number' && Number.isFinite(v.volume)) out[k].volume = Math.max(0, Math.min(1, v.volume));
    if (typeof v?.muted === 'boolean') out[k].muted = v.muted;
  }
  return out;
}

/** The gain a level plays at: squared, like the master, so the slider feels even to the ear. */
export function mixGain(l: MixLevel): number {
  return l.muted ? 0 : l.volume * l.volume;
}
