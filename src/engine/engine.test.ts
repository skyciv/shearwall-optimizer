import { describe, expect, it } from 'vitest';
import {
  analyzeLevel,
  centerOfMass,
  checkLayout,
  DEFAULT_SETTINGS,
  deflection,
  relativeRigidity,
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

const xWall = (id: string, y: number, x0: number, x1: number, t = 1.5): Wall => ({
  id,
  start: { x: x0, y },
  end: { x: x1, y },
  t,
});

const yWall = (id: string, x: number, y0: number, y1: number, t = 1.5): Wall => ({
  id,
  start: { x, y: y0 },
  end: { x, y: y1 },
  t,
});

const box: Outline = { outer: rect(0, 0, 100, 50), holes: [] };
const settings = DEFAULT_SETTINGS; // 9 stories × 10 ft, 18 in walls, cantilever

describe('relativeRigidity', () => {
  it('matches the workbook deflection equations (R = 1/Δ, F = E = 1)', () => {
    for (const fixity of ['cantilever', 'fixed'] as const) {
      for (const [H, D] of [[10, 20], [90, 30], [90, 12], [12, 12]]) {
        const R = relativeRigidity(H, D, 1.5, fixity);
        expect(R * deflection(1, H, D, 1.5, 1, fixity)).toBeCloseTo(1, 12);
      }
    }
  });

  it('hand calc: H = 90, D = 30, t = 1.5 cantilever → 1.5 / (4·27 + 9)', () => {
    expect(relativeRigidity(90, 30, 1.5, 'cantilever')).toBeCloseTo(1.5 / 117, 12);
  });
});

describe('centerOfMass', () => {
  it('rectangle centroid', () => {
    expect(centerOfMass(box)).toEqual({ x: 50, y: 25 });
  });

  it('subtracts holes and ignores winding', () => {
    const outline: Outline = { outer: rect(0, 0, 100, 60).reverse(), holes: [rect(60, 20, 80, 40)] };
    const cm = centerOfMass(outline);
    expect(cm.x).toBeCloseTo((6000 * 50 - 400 * 70) / 5600, 10);
    expect(cm.y).toBeCloseTo(30, 10);
  });
});

describe('analyzeLevel', () => {
  it('workbook Fig 8.13: R1 = 0.5, R2 = 1.0, V = 150k → 50k / 100k direct', () => {
    // Same H/D, so R scales with t.
    const walls = [xWall('1', 0, 0, 20, 0.75), xWall('2', 50, 0, 20, 1.5), yWall('A', 0, 0, 20), yWall('B', 100, 0, 20)];
    const res = analyzeLevel(box, walls, settings, { Vx: 150, Vy: 150 });
    const direct = res.loads.X.walls.filter((w) => w.id === '1' || w.id === '2').map((w) => w.direct);
    expect(direct[0]).toBeCloseTo(50, 10);
    expect(direct[1]).toBeCloseTo(100, 10);
  });

  it('symmetric box: zero eccentricity, ±5% accidental torsion only', () => {
    const walls = [xWall('C', 50, 40, 60), xWall('D', 0, 40, 60), yWall('A', 0, 15, 35), yWall('B', 100, 15, 35)];
    const res = analyzeLevel(box, walls, settings);
    expect(res.cr).toEqual({ x: 50, y: 25 });
    expect(res.e).toEqual({ x: 0, y: 0 });

    // M_T = ±0.05·50 = ±2.5; J = R(2·25² + 2·50²) = 6250R; C torsional = 2.5·25/6250 = 0.01
    const X = res.loads.X;
    expect(X.designMoment).toEqual([2.5, -2.5]);
    const C = X.walls.find((w) => w.id === 'C')!;
    expect(C.direct).toBeCloseTo(0.5, 12);
    expect(C.torsional[0]).toBeCloseTo(-0.01, 12);
    expect(C.torsional[1]).toBeCloseTo(0.01, 12);
    expect(C.governing).toBeCloseTo(0.51, 12);
    const A = X.walls.find((w) => w.id === 'A')!;
    expect(A.direct).toBe(0);
    expect(A.governing).toBeCloseTo(0.02, 12);
  });

  describe('eccentric layout', () => {
    // Y walls: 30 ft at x = 0, 20 ft at x = 100 → X_CR = 100·117/(117 + 378)
    const walls = [xWall('C', 50, 40, 60), xWall('D', 0, 40, 60), yWall('A', 0, 10, 40), yWall('B', 100, 15, 35)];
    const res = analyzeLevel(box, walls, settings, { Vx: 100, Vy: 100 });

    it('center of rigidity and eccentricity', () => {
      expect(res.cr.x).toBeCloseTo(11700 / 495, 10);
      expect(res.cr.y).toBeCloseTo(25, 10);
      expect(res.e.x).toBeCloseTo(11700 / 495 - 50, 10);
      expect(res.eRatio.x).toBeCloseTo((11700 / 495 - 50) / 100, 10);
    });

    it('wall forces satisfy force and moment equilibrium in every case', () => {
      for (const load of [res.loads.X, res.loads.Y]) {
        for (const k of [0, 1] as const) {
          let force = 0;
          let moment = 0;
          for (const f of load.walls) {
            const el = res.elements.find((e) => e.wall.id === f.id)!;
            const F = f.direct + f.torsional[k];
            if (el.direction === load.direction) force += F;
            const dx = el.centroid.x - res.cr.x;
            const dy = el.centroid.y - res.cr.y;
            moment += el.direction === 'X' ? -F * dy : F * dx;
          }
          expect(force).toBeCloseTo(load.V, 10);
          expect(moment).toBeCloseTo(load.designMoment[k], 10);
        }
      }
    });

    it('Y load: stiff wall A governs with CM shifted toward it', () => {
      const [A, B] = ['A', 'B'].map((id) => res.loads.Y.walls.find((w) => w.id === id)!);
      expect(A.direct).toBeGreaterThan(B.direct);
      // CR sits near A, so torsion loads the far wall B more than its direct share.
      expect(B.governing).toBeGreaterThan(B.direct);
    });
  });
});

describe('checkLayout', () => {
  it('flags fewer than 2 walls per direction and collinear walls', () => {
    const issues = checkLayout([xWall('1', 0, 0, 20), xWall('2', 0, 30, 50), yWall('A', 0, 0, 20)], settings);
    expect(issues).toEqual([
      'X: all walls on one line, no torsional resistance',
      'Y: 1 walls, minimum is 2',
    ]);
  });

  it('accepts a valid layout', () => {
    const walls = [xWall('C', 50, 40, 60), xWall('D', 0, 40, 60), yWall('A', 0, 15, 35), yWall('B', 100, 15, 35)];
    expect(checkLayout(walls, settings)).toEqual([]);
  });
});
