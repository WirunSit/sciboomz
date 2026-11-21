import { Rng } from './rng';

export const WORLD_WIDTH = 2000;
export const WORLD_HEIGHT = 720;

/**
 * Map shapes:
 * hills   = rolling ground from edge to edge (only craters open holes)
 * islands = floating islands with open sky between them
 * canyon  = two cliffs with a deep canyon in the middle
 */
export type MapStyle = 'hills' | 'islands' | 'canyon';
export const MAP_STYLES: MapStyle[] = ['hills', 'islands', 'canyon'];
/** Thai names for the map shapes (shown at the start of a match) */
export const MAP_STYLE_NAMES: Record<MapStyle, string> = { hills: 'เนินเขา', islands: 'เกาะลอยฟ้า', canyon: 'หุบเหว' };

/**
 * Destructible ground stored as a 1-byte-per-pixel mask (1 = solid).
 * Pure data — the client draws it, the server only needs the mask.
 */
export class Terrain {
  readonly width: number;
  readonly height: number;
  readonly mask: Uint8Array;

  constructor(width = WORLD_WIDTH, height = WORLD_HEIGHT) {
    this.width = width;
    this.height = height;
    this.mask = new Uint8Array(width * height);
  }

  /** A map of the given shape (see MapStyle), shaped by the seed */
  static generate(seed: number, style: MapStyle = 'hills', width = WORLD_WIDTH, height = WORLD_HEIGHT): Terrain {
    if (style === 'islands') return Terrain.islands(seed, width, height);
    if (style === 'canyon') return Terrain.canyon(seed, width, height);
    return Terrain.hills(seed, width, height);
  }

  /**
   * Floating islands with open sky between them: fall through a gap (or get
   * pushed/blown off an edge) and you're out. The two outer islands are wide
   * enough to stand on and fight from; the middle ones sit higher.
   */
  private static islands(seed: number, width: number, height: number): Terrain {
    const t = new Terrain(width, height);
    const rng = new Rng(seed);
    const s = width / WORLD_WIDTH;
    const plan = [
      { cx: rng.range(250, 330), hw: rng.range(170, 210), top: rng.range(440, 500) },
      { cx: rng.range(640, 720), hw: rng.range(95, 130), top: rng.range(360, 450) },
      { cx: rng.range(960, 1040), hw: rng.range(110, 150), top: rng.range(250, 330) },
      { cx: rng.range(1280, 1360), hw: rng.range(95, 130), top: rng.range(360, 450) },
      { cx: rng.range(1670, 1750), hw: rng.range(170, 210), top: rng.range(440, 500) },
    ];
    for (const p of plan) {
      const wobble = { amp: rng.range(6, 16), freq: rng.range(0.012, 0.03), phase: rng.range(0, Math.PI * 2) };
      const thick = Math.min(rng.range(110, 170), p.hw * 1.05);
      const cx = p.cx * s;
      const hw = p.hw * s;
      for (let x = Math.max(0, Math.floor(cx - hw)); x <= Math.min(width - 1, Math.ceil(cx + hw)); x++) {
        const u = (x - cx) / hw;
        if (Math.abs(u) >= 1) continue;
        // Gently domed top with round shoulders; a rocky underside narrowing to a point
        const top = p.top - 18 * (1 - u * u) + Math.sin(x * wobble.freq + wobble.phase) * wobble.amp + 40 * Math.pow(Math.abs(u), 6);
        const bottom = p.top + thick * Math.pow(1 - u * u, 0.7) + Math.sin(x * 0.05 + wobble.phase) * 8;
        t.fillColumn(x, Math.round(top), Math.round(bottom));
      }
    }
    return t;
  }

  /**
   * Two cliffs with a deep canyon between them (a couple of stepping-stone
   * rocks floating in it). Shots must arc over; the edges are dangerous.
   */
  private static canyon(seed: number, width: number, height: number): Terrain {
    const t = new Terrain(width, height);
    const rng = new Rng(seed);
    const s = width / WORLD_WIDTH;
    const gapL = rng.range(760, 830) * s;
    const gapR = rng.range(1170, 1240) * s;
    const waves = Array.from({ length: 3 }, (_, i) => ({
      amp: rng.range(14, 36) / (i + 1),
      freq: rng.range(0.6, 1.4) * (i + 1) * 0.004,
      phase: rng.range(0, Math.PI * 2),
    }));
    // The cliffs lean up towards the canyon so its rim is the high ground
    for (let x = 0; x < width; x++) {
      if (x > gapL && x < gapR) continue;
      const toRim = x <= gapL ? x / gapL : (width - x) / (width - gapR);
      let y = height * 0.7 - 70 * toRim * toRim;
      for (const w of waves) y += Math.sin(x * w.freq + w.phase) * w.amp;
      t.fillColumn(x, Math.round(Math.max(150, y)), height - 1);
    }
    // Stepping stones
    const stones = rng.int(1, 2);
    for (let k = 0; k < stones; k++) {
      const cx = gapL + ((k + 1) / (stones + 1)) * (gapR - gapL);
      const hw = rng.range(45, 70) * s;
      const top = rng.range(330, 420);
      for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) {
        const u = (x - cx) / hw;
        if (Math.abs(u) >= 1) continue;
        t.fillColumn(x, Math.round(top + 10 * u * u), Math.round(top + 70 * Math.pow(1 - u * u, 0.6)));
      }
    }
    return t;
  }

  /** Make a column solid from y0 down to y1 (inclusive) */
  private fillColumn(x: number, y0: number, y1: number) {
    for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) this.mask[y * this.width + x] = 1;
  }

  /** Solid stretches of a column, top to bottom: [top, bottom] pairs (bottom inclusive) */
  columnRuns(x: number): [number, number][] {
    const runs: [number, number][] = [];
    const xi = Math.floor(x);
    if (xi < 0 || xi >= this.width) return runs;
    let start = -1;
    for (let y = 0; y < this.height; y++) {
      const solid = this.mask[y * this.width + xi] === 1;
      if (solid && start < 0) start = y;
      if (!solid && start >= 0) {
        runs.push([start, y - 1]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start, this.height - 1]);
    return runs;
  }

  /**
   * A safe place to stand near `x` (searching up to `range` px either way):
   * ground with room on both sides, so nobody starts on the edge of a cliff.
   */
  standX(x: number, range = 200): number {
    const footing = (cx: number) => {
      const g = this.groundBelow(cx, 0);
      if (g === null) return false;
      // Solid under both feet a little way out, at about the same height
      for (const dx of [-36, -18, 18, 36]) {
        const side = this.groundBelow(cx + dx, g - 30);
        if (side === null || Math.abs(side - g) > 28) return false;
      }
      return true;
    };
    for (let d = 0; d <= range; d += 4) {
      if (footing(x + d)) return x + d;
      if (footing(x - d)) return x - d;
    }
    return x;
  }

  /** Rolling hills from edge to edge, shaped by the seed (blasts can still dig holes to fall through) */
  private static hills(seed: number, width: number, height: number): Terrain {
    const t = new Terrain(width, height);
    const rng = new Rng(seed);
    const waves = Array.from({ length: 4 }, (_, i) => ({
      amp: rng.range(18, 55) / (i + 1),
      freq: rng.range(0.6, 1.4) * (i + 1) * 0.0035,
      phase: rng.range(0, Math.PI * 2),
    }));
    const base = height * 0.68;
    for (let x = 0; x < width; x++) {
      let y = base;
      for (const w of waves) y += Math.sin(x * w.freq + w.phase) * w.amp;
      // A raised hill in the middle so straight shots are blocked
      const mid = (x - width / 2) / (width * 0.12);
      y -= 110 * Math.exp(-mid * mid);
      const top = Math.max(120, Math.min(height - 60, Math.round(y)));
      for (let yy = top; yy < height; yy++) t.mask[yy * width + x] = 1;
    }
    return t;
  }

  /** Independent copy (battle rules simulate on a copy, the screen catches up later) */
  clone(): Terrain {
    const t = new Terrain(this.width, this.height);
    t.mask.set(this.mask);
    return t;
  }

  /**
   * Run-length encoding of the mask: alternating counts of empty and solid
   * pixels, row by row. A fresh map is ~3 KB of JSON; it lets the PvP server
   * send the exact same ground to both players.
   */
  encode(): number[] {
    const runs: number[] = [];
    let value = 0;
    let count = 0;
    for (let i = 0; i < this.mask.length; i++) {
      if (this.mask[i] === value) count++;
      else {
        runs.push(count);
        value = this.mask[i];
        count = 1;
      }
    }
    runs.push(count);
    return runs;
  }

  static decode(runs: number[], width = WORLD_WIDTH, height = WORLD_HEIGHT): Terrain {
    const t = new Terrain(width, height);
    let i = 0;
    runs.forEach((n, k) => {
      if (k % 2 === 1) t.mask.fill(1, i, i + n);
      i += n;
    });
    return t;
  }

  isSolid(x: number, y: number): boolean {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || xi >= this.width || yi < 0 || yi >= this.height) return false;
    return this.mask[yi * this.width + xi] === 1;
  }

  /** First solid pixel at or below fromY in column x, or null if it's a bottomless drop */
  groundBelow(x: number, fromY: number): number | null {
    const xi = Math.floor(x);
    if (xi < 0 || xi >= this.width) return null;
    for (let y = Math.max(0, Math.floor(fromY)); y < this.height; y++) {
      if (this.mask[y * this.width + xi]) return y;
    }
    return null;
  }

  /** Remove a circle of ground (an explosion crater) */
  carve(cx: number, cy: number, radius: number): void {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) this.mask[y * this.width + x] = 0;
      }
    }
  }
}
