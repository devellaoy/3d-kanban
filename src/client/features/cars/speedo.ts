import './speedo.css';
import { driveOf, gearOf, type CarKind } from '../../../shared/garage';
import { h } from '../../ui/dom';

// The dash while you drive: a gauge that sweeps round to the speed (in km/h), the gear, the nitro
// meter and a flag for a slide. Drawn in the corner of the screen, only behind the wheel.

const NS = 'http://www.w3.org/2000/svg';
/** The gauge sweeps 240 degrees, from the lower left round to the lower right, to this many km/h. */
const fullOf = (kind: CarKind) => Math.round(driveOf(kind).boostTop * 3.6 + 10);
const R = 78;
const START = 150;
const SWEEP = 240;

const point = (deg: number, r = R) => [100 + r * Math.cos((deg * Math.PI) / 180), 100 + r * Math.sin((deg * Math.PI) / 180)];

function arc(from: number, to: number, r = R): string {
  const [x0, y0] = point(from, r);
  const [x1, y1] = point(to, r);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** What the dash shows. */
export interface Dash {
  /** m/s along the nose (negative in reverse), and the sideways slide on top of it. */
  speed: number;
  slip: number;
  /** The nitro meter (0 to 1), and whether it's burning. */
  nitro: number;
  boost: boolean;
  /** Off the pavement. */
  rough: boolean;
  /** The kind of car: its dial, its top speed and its gearbox. */
  kind: CarKind;
}

export class Speedo {
  readonly el: HTMLElement;
  private fill: SVGPathElement;
  private num: HTMLElement;
  private gear: HTMLElement;
  private bar: HTMLElement;
  private flag: HTMLElement;
  private shown = '';
  private len: number;
  /** The ticks and numbers round the gauge, for the kind of car's top speed. */
  private scale: SVGGElement;
  private kind: CarKind | null = null;
  private full = fullOf('lambo');

  /** The gauge for a `kind` of car: its scale runs to that car's nitro top speed, and "over" lights above its top speed. */
  private setKind(kind: CarKind) {
    if (this.kind === kind) return;
    this.kind = kind;
    this.full = fullOf(kind);
    this.scale.replaceChildren();
    // A tick and a number every 50 km/h.
    for (let k = 0; k <= this.full; k += 50) {
      const deg = START + (k / this.full) * SWEEP;
      const [x0, y0] = point(deg, R + 7);
      const [x1, y1] = point(deg, R - 8);
      this.scale.append(svg('line', { x1: String(x0), y1: String(y0), x2: String(x1), y2: String(y1), class: 'sp-tick' }));
      const [tx, ty] = point(deg, R - 20);
      const label = svg('text', { x: tx.toFixed(1), y: (ty + 3).toFixed(1), class: 'sp-label' });
      label.textContent = String(k);
      this.scale.append(label);
    }
    this.shown = '';
  }

  constructor() {
    const g = svg('svg', { viewBox: '0 0 200 170', class: 'sp-gauge' });
    g.append(svg('path', { d: arc(START, START + SWEEP), class: 'sp-track' }));
    this.fill = svg('path', { d: arc(START, START + SWEEP), class: 'sp-fill' });
    g.append(this.fill);
    this.scale = svg('g', {});
    g.append(this.scale);
    this.setKind('lambo');
    this.len = this.fill.getTotalLength?.() || 330;
    this.num = h('div.sp-num', {}, '0');
    this.gear = h('div.sp-gear', {}, 'N');
    this.flag = h('div.sp-flag', {}, 'DRIFT');
    this.bar = h('div.sp-nitro-fill');
    this.el = h('div.speedo', { hidden: true }, g, h('div.sp-read', {}, this.num, h('div.sp-unit', {}, 'km/h'), this.gear), this.flag, h('div.sp-nitro', {}, h('span', {}, 'NITRO'), h('div.sp-nitro-bar', {}, this.bar)));
    document.body.append(this.el);
  }

  show(on: boolean) {
    if (this.el.hidden === !on) return;
    this.el.hidden = !on;
    this.shown = '';
  }

  update(d: Dash) {
    this.setKind(d.kind);
    const mps = Math.hypot(d.speed, d.slip);
    const kmh = Math.round(mps * 3.6);
    const gear = d.speed < -0.5 ? 'R' : mps < 0.8 ? 'N' : String(gearOf(mps, d.kind));
    const nitro = Math.round(d.nitro * 50);
    const drift = Math.abs(d.slip) > 3.2 && mps > 8;
    const key = `${kmh}|${gear}|${nitro}|${d.boost}|${drift}|${d.rough}`;
    if (key === this.shown) return;
    this.shown = key;
    const f = Math.min(1, kmh / this.full);
    this.fill.style.strokeDasharray = String(this.len);
    this.fill.style.strokeDashoffset = String(this.len * (1 - f));
    this.num.textContent = String(kmh);
    this.gear.textContent = gear;
    this.bar.style.width = `${nitro * 2}%`;
    this.flag.classList.toggle('on', drift);
    this.el.classList.toggle('boost', d.boost);
    this.el.classList.toggle('rough', d.rough);
    this.el.classList.toggle('over', kmh > driveOf(d.kind).top * 3.6);
  }
}
