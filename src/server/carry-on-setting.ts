import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CarryOnState } from '../shared/protocol.js';

/**
 * Whether workers that were mid-turn when the office was stopped carry on by themselves when it starts
 * again, picked in ⚙️ Settings by anyone and kept in .agent-office/carry-on.json. The same on every floor;
 * on until someone turns it off.
 */
export class CarryOnSetting {
  private saved?: Required<CarryOnState>;
  private path: string;

  constructor(
    dataDir: string,
    private onState: (state: CarryOnState) => void,
  ) {
    this.path = path.join(dataDir, 'carry-on.json');
    this.restore();
  }

  get on(): boolean {
    return this.saved?.on ?? true;
  }

  state(): CarryOnState {
    return this.saved ? { ...this.saved } : { on: true };
  }

  set(on: boolean, by: string) {
    this.saved = { on, by, at: Date.now() };
    this.persist();
    this.onState(this.state());
  }

  private restore() {
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CarryOnState>;
      if (typeof s.on === 'boolean') this.saved = { on: s.on, by: typeof s.by === 'string' ? s.by : 'someone', at: typeof s.at === 'number' ? s.at : 0 };
    } catch {
      // never set: workers carry on
    }
  }

  private persist() {
    try {
      writeFileSync(this.path, JSON.stringify(this.saved ?? {}, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
