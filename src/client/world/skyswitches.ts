// ⚙️ Settings' Rain and Lightning switches, as the sky in the browser keeps them (see server/sky.ts, which keeps
// rain and storms out of the weather it sends). The weather eases from one spell to the next, so without these a
// switch turned off mid-storm would leave the rain falling and the storm striking for a while yet.
import type { SkyState } from '../../shared/protocol';

/** How hard it's raining and how stormy it is, eased: a switch that's off ends its part at once. */
export function letIn(s: Pick<SkyState, 'rain' | 'lightning'>, eased: { rain: number; storm: number }): { rain: number; storm: number } {
  return { rain: s.rain ? eased.rain : 0, storm: s.lightning ? eased.storm : 0 };
}

/** Whether lightning may strike now: only with ⚙️ Lightning on, in a storm well under way. */
export function mayStrike(s: Pick<SkyState, 'lightning'>, storm: number): boolean {
  return !!s.lightning && storm > 0.5;
}
