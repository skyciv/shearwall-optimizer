import { centerOfMass, planDimensions, wallCentroid, wallDirection, wallLength } from './geometry';
import { relativeRigidity } from './rigidity';
import type { BuildingSettings, Direction, Outline, Point, Wall } from './types';

const LINE_TOL = 0.01; // ft; walls closer than this are on the same line

export interface WallElement {
  wall: Wall;
  direction: Direction;
  length: number;
  centroid: Point;
  R: number;
}

export interface WallForce {
  id: string;
  direct: number;
  /** Torsional shear for design eccentricities e + acc·L and e − acc·L. */
  torsional: [number, number];
  governing: number;
}

export interface LoadCase {
  direction: Direction;
  V: number;
  designEccentricity: [number, number];
  designMoment: [number, number];
  walls: WallForce[];
}

export interface LevelAnalysis {
  cm: Point;
  cr: Point;
  /** e_x = X_CR − X_CM, e_y = Y_CR − Y_CM. */
  e: Point;
  /** e_x / L_x, e_y / L_y. */
  eRatio: Point;
  Lx: number;
  Ly: number;
  sumRx: number;
  sumRy: number;
  /** ΣR·d² about the CR. */
  J: number;
  elements: WallElement[];
  loads: { X: LoadCase; Y: LoadCase };
}

/** Walls run the full building height, so H is the same for every wall. */
export function wallHeight(settings: BuildingSettings): number {
  return settings.stories * settings.storyHeight;
}

export function toElements(walls: Wall[], settings: BuildingSettings): WallElement[] {
  const H = wallHeight(settings);
  return walls.map((wall) => {
    const length = wallLength(wall);
    return {
      wall,
      direction: wallDirection(wall),
      length,
      centroid: wallCentroid(wall),
      R: relativeRigidity(H, length, wall.t, settings.fixity),
    };
  });
}

export function centerOfRigidity(elements: WallElement[]): { cr: Point; sumRx: number; sumRy: number } {
  let sumRx = 0;
  let sumRy = 0;
  let qx = 0;
  let qy = 0;
  for (const el of elements) {
    if (el.direction === 'X') {
      sumRx += el.R;
      qy += el.R * el.centroid.y;
    } else {
      sumRy += el.R;
      qx += el.R * el.centroid.x;
    }
  }
  if (sumRx === 0 || sumRy === 0) throw new Error('Need at least one wall in each direction');
  return { cr: { x: qx / sumRy, y: qy / sumRx }, sumRx, sumRy };
}

/** Layout problems that make the rigid-diaphragm analysis invalid or unstable. */
export function checkLayout(walls: Wall[], settings: BuildingSettings): string[] {
  const issues: string[] = [];
  for (const dir of ['X', 'Y'] as const) {
    const inDir = walls.filter((w) => wallDirection(w) === dir);
    if (inDir.length < settings.minWallsPerDirection) {
      issues.push(`${dir}: ${inDir.length} walls, minimum is ${settings.minWallsPerDirection}`);
    }
    const lines: number[] = [];
    for (const w of inDir) {
      const c = dir === 'X' ? w.start.y : w.start.x;
      if (!lines.some((l) => Math.abs(l - c) < LINE_TOL)) lines.push(c);
    }
    if (inDir.length > 1 && lines.length < 2) issues.push(`${dir}: all walls on one line, no torsional resistance`);
  }
  return issues;
}

function loadCase(
  direction: Direction,
  V: number,
  e: number,
  accidental: number,
  elements: WallElement[],
  cr: Point,
  sumR: number,
  J: number,
): LoadCase {
  const designEccentricity: [number, number] = [e + accidental, e - accidental];
  // Counterclockwise-positive moment about the CR of V applied at the (shifted) CM:
  // X load: V·(Y_CR − Y_CM) = V·e_y; Y load: −V·(X_CR − X_CM) = −V·e_x.
  const sign = direction === 'X' ? 1 : -1;
  const designMoment = designEccentricity.map((ed) => sign * V * ed) as [number, number];

  const walls = elements.map((el): WallForce => {
    const dx = el.centroid.x - cr.x;
    const dy = el.centroid.y - cr.y;
    // Diaphragm rotation θ = M/J; X walls move −θ·dy, Y walls move θ·dx.
    const arm = el.direction === 'X' ? -dy : dx;
    const torsional = designMoment.map((M) => (M * el.R * arm) / J) as [number, number];
    const parallel = el.direction === direction;
    const direct = parallel ? (V * el.R) / sumR : 0;
    const governing = parallel
      ? Math.max(direct + torsional[0], direct + torsional[1])
      : Math.max(Math.abs(torsional[0]), Math.abs(torsional[1]));
    return { id: el.wall.id, direct, torsional, governing };
  });

  return { direction, V, designEccentricity, designMoment, walls };
}

/** Rigid-diaphragm analysis of one level (workbook §8.7–8.8). */
export function analyzeLevel(
  outline: Outline,
  walls: Wall[],
  settings: BuildingSettings,
  shear: { Vx: number; Vy: number } = { Vx: 1, Vy: 1 },
): LevelAnalysis {
  const elements = toElements(walls, settings);
  const cm = centerOfMass(outline);
  const { cr, sumRx, sumRy } = centerOfRigidity(elements);
  const { Lx, Ly } = planDimensions(outline);
  const e = { x: cr.x - cm.x, y: cr.y - cm.y };

  const J = elements.reduce((s, el) => {
    const d = el.direction === 'X' ? el.centroid.y - cr.y : el.centroid.x - cr.x;
    return s + el.R * d * d;
  }, 0);
  if (J <= 0) throw new Error('Layout has no torsional resistance');

  const acc = settings.accidentalRatio;
  return {
    cm,
    cr,
    e,
    eRatio: { x: e.x / Lx, y: e.y / Ly },
    Lx,
    Ly,
    sumRx,
    sumRy,
    J,
    elements,
    loads: {
      X: loadCase('X', shear.Vx, e.y, acc * Ly, elements, cr, sumRx, J),
      Y: loadCase('Y', shear.Vy, e.x, acc * Lx, elements, cr, sumRy, J),
    },
  };
}

/** Walls are continuous over the height, so only the level outlines (and COM) differ. */
export function analyzeBuilding(levels: Outline[], walls: Wall[], settings: BuildingSettings): LevelAnalysis[] {
  return levels.map((outline) => analyzeLevel(outline, walls, settings));
}
