import { analyzeLevel, wallHeight } from './analysis';
import { centerOfMass, planDimensions, wallDirection } from './geometry';
import { relativeRigidity } from './rigidity';
import type { BuildingSettings, Direction, Outline, Point, Wall } from './types';

const EPS = 1e-4; // ft; scanline offset either side of a wall line
const TOL = 1e-6;

export interface OptimizeOptions {
  /** Longest a wall may grow to, ft. */
  maxLength: number;
  /** Shortest a wall may shrink to, ft (only used when shortening is allowed). */
  minLength: number;
  allowShortening: boolean;
  /** Length increment, ft. */
  step?: number;
  /** Walls that must not change length or be removed. */
  locked?: Set<string>;
  /** Max gap between a wall end and another wall for them to count as connected, ft. */
  junctionTol?: number;
  /** Let the optimizer drop walls when lengthening alone can't balance the plan. */
  allowRemoval?: boolean;
  /** Range for the single thickness used by every wall, ft. Omit to keep the current thickness. */
  thickness?: { min: number; max: number };
  /**
   * e/L at which a direction counts as balanced (default 0.5%). Walls are only removed if
   * lengths alone can't get below this, so a wall is never dropped for a fraction of a percent.
   */
  tolerance?: number;
}

export interface OptimizeResult {
  /** Kept walls, all at the chosen thickness. */
  walls: Wall[];
  removed: string[];
  thickness: number;
  /** Total stiffness in each direction relative to the original layout. */
  stiffness: Point;
  /** True if even the max thickness can't restore the original stiffness. */
  stiffnessShort: boolean;
  before: Point;
  after: Point;
  lengths: Record<string, { from: number; to: number }>;
}

type Interval = [number, number];

/**
 * Parts of the line v = c (perpendicular coordinate) that lie on the slab, as intervals in the
 * along-wall coordinate u. Even-odd rule, so holes are excluded automatically.
 */
function scan(rings: Point[][], dir: Direction, c: number): Interval[] {
  const us: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const [pu, pv, qu, qv] = dir === 'X' ? [p.x, p.y, q.x, q.y] : [p.y, p.x, q.y, q.x];
      if (pv > c !== qv > c) us.push(pu + ((c - pv) * (qu - pu)) / (qv - pv));
    }
  }
  us.sort((a, b) => a - b);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < us.length; i += 2) out.push([us[i], us[i + 1]]);
  return out;
}

/** Union of scans just either side of c, so walls on slab or void edges count as on the slab. */
function slabIntervals(rings: Point[][], dir: Direction, c: number): Interval[] {
  const all = [...scan(rings, dir, c - EPS), ...scan(rings, dir, c + EPS)].sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const iv of all) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + TOL) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  return merged;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** How a wall grows: about its center, or away from an end connected to another wall. */
type Growth = 'center' | 'fromLow' | 'fromHigh';

interface Item {
  wall: Wall;
  dir: Direction;
  /** Perpendicular coordinate (fixed). */
  v: number;
  /** Along-wall extent, lo < hi. */
  lo: number;
  hi: number;
  growth: Growth;
  D0: number;
  Dmin: number;
  Dmax: number;
  D: number;
  movable: boolean;
  locked: boolean;
}

const INCH = 1 / 12;
/** Cap on subsets tried per removal count, to bound run time on large plans. */
const MAX_SUBSETS = 5000;

/**
 * Change wall lengths (never positions), and optionally remove walls, so the COR lands on the
 * COM; then pick the uniform wall thickness.
 *
 * X_CR depends only on Y walls and Y_CR only on X walls, so each direction is balanced
 * independently: drive S = Σ R_j·u_j to zero, with u_j the wall's offset from the COM.
 * The minimum-change step in rigidity is ΔR_j = −S·u_j / Σu², clamped to each wall's
 * [R(Dmin), R(Dmax)]; clamped walls are held and the rest of S goes to the others. Rigidities
 * are then mapped back to lengths, rounded to the step, and polished with a local search.
 */
export function optimizeLayout(
  outline: Outline,
  walls: Wall[],
  settings: BuildingSettings,
  opts: OptimizeOptions,
): OptimizeResult {
  const step = opts.step ?? 0.5;
  const locked = opts.locked ?? new Set<string>();
  const jtol = opts.junctionTol ?? Math.max(1, settings.wallThickness);
  const rings = [outline.outer, ...outline.holes];
  const cm = centerOfMass(outline);
  const H = wallHeight(settings);
  const R = (D: number, t: number) => relativeRigidity(H, D, t, settings.fixity);
  const before = analyzeLevel(outline, walls, settings).eRatio;

  const items: Item[] = walls.map((wall) => {
    const dir = wallDirection(wall);
    const [su, eu] = dir === 'X' ? [wall.start.x, wall.end.x] : [wall.start.y, wall.end.y];
    const v = dir === 'X' ? wall.start.y : wall.start.x;
    const lo = Math.min(su, eu);
    const hi = Math.max(su, eu);
    const D0 = hi - lo;
    const at = (u: number): Point => (dir === 'X' ? { x: u, y: v } : { x: v, y: u });
    const joined = (p: Point) => walls.some((o) => o !== wall && distToSegment(p, o.start, o.end) <= jtol);
    const loJoined = joined(at(lo));
    const hiJoined = joined(at(hi));
    const growth: Growth = loJoined && !hiJoined ? 'fromLow' : hiJoined && !loJoined ? 'fromHigh' : 'center';

    // Room on the slab along the wall's line, measured from its anchor.
    const anchor = growth === 'fromLow' ? lo : growth === 'fromHigh' ? hi : (lo + hi) / 2;
    const iv = slabIntervals(rings, dir, v).find(([p, q]) => p - TOL <= anchor && anchor <= q + TOL);
    const room = !iv
      ? D0
      : growth === 'fromLow'
        ? iv[1] - lo
        : growth === 'fromHigh'
          ? hi - iv[0]
          : 2 * Math.min(anchor - iv[0], iv[1] - anchor);

    const fixedLength = locked.has(wall.id) || (loJoined && hiJoined);
    if (wall.t !== settings.wallThickness) throw new Error('All walls must use the same thickness');
    const Dmax = fixedLength ? D0 : Math.max(D0, Math.min(opts.maxLength, room));
    const Dmin = fixedLength || !opts.allowShortening ? D0 : Math.min(D0, opts.minLength);
    const isLocked = locked.has(wall.id);
    return { wall, dir, v, lo, hi, growth, D0, Dmin, Dmax, D: D0, movable: Dmax - Dmin > TOL, locked: isLocked };
  });

  const { Lx, Ly } = planDimensions(outline);
  const solve = { step, R, minWalls: settings.minWallsPerDirection, allowRemoval: !!opts.allowRemoval, tol: opts.tolerance ?? 0.005 };
  const removedY = solveDirection(items.filter((it) => it.dir === 'Y'), cm.x, Lx, solve);
  const removedX = solveDirection(items.filter((it) => it.dir === 'X'), cm.y, Ly, solve);
  const removed = new Set([...removedX, ...removedY]);
  const kept = items.filter((it) => !removed.has(it));

  // Uniform thickness scales every wall's R equally, so it can't change the COR. Use it to keep
  // total stiffness per direction at least at the original layout's: smallest t in range that does.
  const t0 = settings.wallThickness;
  const sumR = (list: Item[], dir: Direction, useD0: boolean) =>
    list.filter((it) => it.dir === dir).reduce((s, it) => s + R(useD0 ? it.D0 : it.D, t0), 0);
  const ratio = (dir: Direction) => sumR(kept, dir, false) / sumR(items, dir, true);
  const range = opts.thickness ?? { min: t0, max: t0 };
  const need = t0 / Math.min(ratio('X'), ratio('Y'));
  const t = Math.min(range.max, Math.max(range.min, Math.ceil(need / INCH - 1e-9) * INCH));

  const lengths: Record<string, { from: number; to: number }> = {};
  const out = kept.map((it): Wall => {
    const { wall, D, dir, v } = it;
    lengths[wall.id] = { from: it.D0, to: D };
    const [a, b] =
      it.growth === 'fromLow' ? [it.lo, it.lo + D] : it.growth === 'fromHigh' ? [it.hi - D, it.hi] : [(it.lo + it.hi - D) / 2, (it.lo + it.hi + D) / 2];
    const forward = dir === 'X' ? wall.end.x >= wall.start.x : wall.end.y >= wall.start.y;
    const [ua, ub] = forward ? [a, b] : [b, a];
    return dir === 'X'
      ? { ...wall, t, start: { x: ua, y: v }, end: { x: ub, y: v } }
      : { ...wall, t, start: { x: v, y: ua }, end: { x: v, y: ub } };
  });

  return {
    walls: out,
    removed: [...removed].map((it) => it.wall.id),
    thickness: t,
    stiffness: { x: (ratio('X') * t) / t0, y: (ratio('Y') * t) / t0 },
    stiffnessShort: need > range.max + 1e-9,
    before,
    after: analyzeLevel(outline, out, { ...settings, wallThickness: t }).eRatio,
    lengths,
  };
}

interface SolveParams {
  step: number;
  R: (D: number, t: number) => number;
  minWalls: number;
  allowRemoval: boolean;
  tol: number;
}

/**
 * Balance one direction: first by lengths alone, then (if allowed and still above tolerance)
 * by also removing 1, 2, … unlocked walls. Prefers the lowest eccentricity, then the fewest
 * removals, then the least total length change. Returns the removed walls.
 */
function solveDirection(items: Item[], target: number, L: number, p: SolveParams): Item[] {
  if (!items.length) return [];
  const removable = items.filter((it) => !it.locked);
  const maxK = p.allowRemoval ? Math.max(0, items.length - p.minWalls) : 0;
  let best: { e: number; k: number; change: number; removed: Item[]; D: Map<Item, number> } | null = null;

  for (let k = 0; k <= maxK; k++) {
    let tried = 0;
    for (const combo of combinations(removable, k)) {
      if (++tried > MAX_SUBSETS) break;
      const active = items.filter((it) => !combo.includes(it));
      if (active.length < Math.min(p.minWalls, items.length) || distinctLines(active) < Math.min(2, distinctLines(items))) continue;
      for (const it of active) it.D = it.D0;
      balance(active, target, p.step, p.R);
      const sumR = active.reduce((s, it) => s + p.R(it.D, it.wall.t), 0);
      const e = Math.abs(active.reduce((s, it) => s + p.R(it.D, it.wall.t) * (it.v - target), 0)) / sumR / L;
      const change = active.reduce((s, it) => s + Math.abs(it.D - it.D0), 0);
      const better =
        !best ||
        (e <= p.tol && best.e <= p.tol
          ? k < best.k || (k === best.k && change < best.change - TOL)
          : e < best.e - TOL);
      if (better) best = { e, k, change, removed: combo, D: new Map(active.map((it) => [it, it.D])) };
    }
    if (best && best.e <= p.tol) break;
  }

  for (const it of items) it.D = best?.D.get(it) ?? it.D0;
  return best?.removed ?? [];
}

function distinctLines(items: Item[]): number {
  const vs: number[] = [];
  for (const it of items) if (!vs.some((v) => Math.abs(v - it.v) < 0.01)) vs.push(it.v);
  return vs.length;
}

function* combinations<T>(list: T[], k: number, start = 0): Generator<T[]> {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = start; i <= list.length - k; i++) {
    for (const rest of combinations(list, k - 1, i + 1)) yield [list[i], ...rest];
  }
}

function balance(items: Item[], target: number, step: number, R: (D: number, t: number) => number) {
  if (!items.length) return;
  const u = (it: Item) => it.v - target;
  const S = () => items.reduce((s, it) => s + R(it.D, it.wall.t) * u(it), 0);
  const scale = items.reduce((s, it) => s + R(it.D, it.wall.t) * Math.max(Math.abs(u(it)), 1), 0);
  const done = (s: number) => Math.abs(s) <= TOL * scale;

  // 1. Continuous minimum-change solve in rigidity space.
  const r = new Map(items.map((it) => [it, R(it.D0, it.wall.t)]));
  const rS = () => items.reduce((s, it) => s + r.get(it)! * u(it), 0);
  let free = items.filter((it) => it.movable && Math.abs(u(it)) > TOL);
  for (let iter = 0; iter <= items.length && free.length && !done(rS()); iter++) {
    const s = rS();
    const denom = free.reduce((acc, it) => acc + u(it) ** 2, 0);
    const next: Item[] = [];
    for (const it of free) {
      const lo = R(it.Dmin, it.wall.t);
      const hi = R(it.Dmax, it.wall.t);
      const want = r.get(it)! - (s * u(it)) / denom;
      r.set(it, Math.min(hi, Math.max(lo, want)));
      if (want > lo && want < hi) next.push(it);
    }
    if (next.length === free.length) break;
    free = next;
  }

  // 2. Back to lengths (R is monotonic in D), rounded to the step from the drawn length.
  for (const it of items) {
    if (!it.movable) continue;
    let a = it.Dmin;
    let b = it.Dmax;
    for (let k = 0; k < 60; k++) {
      const m = (a + b) / 2;
      if (R(m, it.wall.t) < r.get(it)!) a = m;
      else b = m;
    }
    const D = it.D0 + Math.round(((a + b) / 2 - it.D0) / step) * step;
    it.D = Math.min(it.Dmax, Math.max(it.Dmin, D));
  }

  // 3. Local search on the rounded lengths.
  for (let pass = 0; pass < 50; pass++) {
    let improved = false;
    for (const it of items) {
      if (!it.movable) continue;
      for (const d of [-step, step]) {
        const prev = it.D;
        const s0 = Math.abs(S());
        it.D = Math.min(it.Dmax, Math.max(it.Dmin, prev + d));
        if (Math.abs(S()) < s0 - TOL * scale) improved = true;
        else it.D = prev;
      }
    }
    if (!improved) break;
  }
}

/** Is the whole wall on the slab (edges allowed) and clear of voids? */
export function wallOnSlab(outline: Outline, wall: Wall): boolean {
  const dir = wallDirection(wall);
  const [v, su, eu] = dir === 'X' ? [wall.start.y, wall.start.x, wall.end.x] : [wall.start.x, wall.start.y, wall.end.y];
  const a = Math.min(su, eu);
  const b = Math.max(su, eu);
  return slabIntervals([outline.outer, ...outline.holes], dir, v).some(([p, q]) => p <= a + 1e-6 && b <= q + 1e-6);
}
