import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  optimizeLayout,
  wallLength,
  wallOnSlab,
  type OptimizeOptions,
  type Outline,
  type Point,
  type Wall,
} from './index';

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const xWall = (id: string, y: number, x0: number, x1: number): Wall => ({ id, start: { x: x0, y }, end: { x: x1, y }, t: 1.5 });
const yWall = (id: string, x: number, y0: number, y1: number): Wall => ({ id, start: { x, y: y0 }, end: { x, y: y1 }, t: 1.5 });

const settings = DEFAULT_SETTINGS;
const box: Outline = { outer: rect(0, 0, 100, 50), holes: [] };
const opts: OptimizeOptions = { maxLength: 40, minLength: 6, allowShortening: false };

/** Perpendicular line of a wall: it must never change. */
const line = (w: Wall) => (Math.abs(w.end.y - w.start.y) < 1e-9 ? `y=${w.start.y}` : `x=${w.start.x}`);

describe('optimizeLayout (lengths only)', () => {
  // Y walls at x = 10 and x = 80, both 10 ft → X_CR = 45, COM at 50.
  const walls = [xWall('C', 50, 45, 55), xWall('D', 0, 45, 55), yWall('A', 10, 20, 30), yWall('B', 80, 20, 30)];

  it('balances by lengthening the light side, without moving any wall', () => {
    const res = optimizeLayout(box, walls, settings, opts);
    expect(Math.abs(res.before.x)).toBeGreaterThan(0.04);
    expect(Math.abs(res.after.x)).toBeLessThan(0.002);
    res.walls.forEach((w, i) => {
      expect(line(w)).toBe(line(walls[i]));
      expect(wallOnSlab(box, w)).toBe(true);
    });
    expect(res.lengths.A.to).toBe(10);
    expect(res.lengths.B.to).toBeGreaterThan(10);
    // Free wall grows about its center.
    const B = res.walls[3];
    expect((B.start.y + B.end.y) / 2).toBeCloseTo(25, 9);
  });

  it('never shortens walls unless allowed', () => {
    const res = optimizeLayout(box, walls, settings, opts);
    for (const id of Object.keys(res.lengths)) expect(res.lengths[id].to).toBeGreaterThanOrEqual(res.lengths[id].from);
  });

  it('shortens the heavy side within the minimum when allowed and growth is capped', () => {
    const res = optimizeLayout(box, walls, settings, { ...opts, maxLength: 10, allowShortening: true });
    expect(res.lengths.A.to).toBeLessThan(10);
    expect(res.lengths.A.to).toBeGreaterThanOrEqual(6);
    expect(Math.abs(res.after.x)).toBeLessThan(Math.abs(res.before.x));
  });

  it('keeps locked walls and stays within the max length', () => {
    const res = optimizeLayout(box, walls, settings, { ...opts, maxLength: 12, locked: new Set(['B']) });
    expect(res.walls[3]).toEqual(walls[3]);
    for (const { to } of Object.values(res.lengths)) expect(to).toBeLessThanOrEqual(12);
  });

  it('grows a T stem away from its flange', () => {
    // Flange on y = 40 (x 20–30), stem at x = 25 hanging down from it; stiff wall at x = 90.
    const T = [
      xWall('F', 40, 20, 30),
      yWall('S', 25, 30, 40),
      yWall('Z', 90, 15, 35),
      xWall('G', 5, 45, 55),
    ];
    const res = optimizeLayout(box, T, settings, opts);
    const S = res.walls[1];
    expect(Math.max(S.start.y, S.end.y)).toBeCloseTo(40, 9); // junction end stays put
    expect(wallLength(S)).toBeGreaterThan(10);
    expect(Math.abs(res.after.x)).toBeLessThan(Math.abs(res.before.x));
  });

  it('stops growth at the slab edge and at voids', () => {
    const withHole: Outline = { outer: rect(0, 0, 100, 50), holes: [rect(60, 0.5, 100, 18)] };
    const res = optimizeLayout(withHole, walls, settings, opts);
    for (const w of res.walls) expect(wallOnSlab(withHole, w)).toBe(true);
  });
});

describe('wall removal', () => {
  // Y walls at 10 and 90 balance about x = 50; the extra wall E at 80 pulls the CR east.
  // Growth is capped at the drawn length, so only removal can fix it.
  const walls = [
    xWall('C', 50, 45, 55),
    xWall('D', 0, 45, 55),
    yWall('A', 10, 20, 30),
    yWall('B', 90, 20, 30),
    yWall('E', 80, 20, 30),
  ];
  const capped = { ...opts, maxLength: 10 };

  it('removes the wall that causes the eccentricity, only when allowed', () => {
    const off = optimizeLayout(box, walls, settings, capped);
    expect(off.removed).toEqual([]);
    expect(Math.abs(off.after.x)).toBeGreaterThan(0.05);

    const on = optimizeLayout(box, walls, settings, { ...capped, allowRemoval: true });
    expect(on.removed).toEqual(['E']);
    expect(Math.abs(on.after.x)).toBeLessThan(0.001);
    expect(on.walls.map((w) => w.id)).toEqual(['C', 'D', 'A', 'B']);
  });

  it('does not remove walls when lengths alone can balance', () => {
    const res = optimizeLayout(box, walls, settings, { ...opts, allowRemoval: true });
    expect(res.removed).toEqual([]);
    expect(Math.abs(res.after.x)).toBeLessThan(0.005); // 6 in length steps leave ~0.3%
  });

  it('never removes locked walls and keeps the minimum wall count', () => {
    const res = optimizeLayout(box, walls, settings, { ...capped, allowRemoval: true, locked: new Set(['E']) });
    expect(res.removed).not.toContain('E');
    const ys = res.walls.filter((w) => w.start.x === w.end.x);
    expect(ys.length).toBeGreaterThanOrEqual(2);
  });
});

describe('uniform thickness', () => {
  const walls = [xWall('C', 50, 45, 55), xWall('D', 0, 45, 55), yWall('A', 10, 20, 30), yWall('B', 90, 20, 30), yWall('E', 80, 20, 30)];
  const capped = { ...opts, maxLength: 10, allowRemoval: true };

  it('does not change eccentricity', () => {
    const thin = optimizeLayout(box, walls, settings, { ...capped, thickness: { min: 1, max: 1 } });
    const thick = optimizeLayout(box, walls, settings, { ...capped, thickness: { min: 2, max: 2 } });
    expect(thin.after.x).toBeCloseTo(thick.after.x, 12);
    expect(thin.after.y).toBeCloseTo(thick.after.y, 12);
  });

  it('thickens all walls equally to restore stiffness lost to removals', () => {
    const res = optimizeLayout(box, walls, settings, { ...capped, thickness: { min: 1, max: 3 } });
    expect(res.removed).toEqual(['E']);
    // Lost 1 of 3 equal Y walls → need 1.5 × 3/2 = 2.25 ft = 27 in.
    expect(res.thickness * 12).toBeCloseTo(27, 9);
    expect(res.stiffness.y).toBeGreaterThanOrEqual(1);
    expect(new Set(res.walls.map((w) => w.t))).toEqual(new Set([res.thickness]));
    expect(res.stiffnessShort).toBe(false);
  });

  it('flags when the max thickness cannot restore stiffness', () => {
    const res = optimizeLayout(box, walls, settings, { ...capped, thickness: { min: 1, max: 2 } });
    expect(res.thickness).toBe(2);
    expect(res.stiffnessShort).toBe(true);
  });

  it('uses the thinnest wall in range when stiffness is already enough', () => {
    const res = optimizeLayout(box, walls.slice(0, 4), settings, { ...opts, thickness: { min: 1, max: 3 } });
    expect(res.thickness).toBe(1.5);
  });
});

describe('wallOnSlab', () => {
  const withHole: Outline = { outer: rect(0, 0, 100, 50), holes: [rect(40, 10, 60, 40)] };
  it('accepts walls on the perimeter and on void edges', () => {
    expect(wallOnSlab(withHole, xWall('a', 0, 10, 30))).toBe(true);
    expect(wallOnSlab(withHole, yWall('b', 40, 15, 35))).toBe(true);
  });
  it('rejects walls crossing a void or leaving the slab', () => {
    expect(wallOnSlab(withHole, xWall('a', 20, 30, 70))).toBe(false);
    expect(wallOnSlab(withHole, xWall('b', 20, 90, 110))).toBe(false);
  });
});
