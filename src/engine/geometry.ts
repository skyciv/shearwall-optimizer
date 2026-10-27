import type { Direction, Outline, Point, Wall } from './types';

const ORTHO_TOL = 1e-6;

/** Signed area and first moments of a closed polygon (shoelace). */
function polygonMoments(pts: Point[]): { area: number; qx: number; qy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  // Normalize to positive area regardless of winding.
  const s = Math.sign(a) || 1;
  return { area: (s * a) / 2, qx: (s * cx) / 6, qy: (s * cy) / 6 };
}

export function outlineArea(outline: Outline): number {
  return outline.holes.reduce((a, h) => a - polygonMoments(h).area, polygonMoments(outline.outer).area);
}

/** Center of mass for uniform floor mass = area centroid with holes subtracted. */
export function centerOfMass(outline: Outline): Point {
  let { area, qx, qy } = polygonMoments(outline.outer);
  for (const h of outline.holes) {
    const m = polygonMoments(h);
    area -= m.area;
    qx -= m.qx;
    qy -= m.qy;
  }
  if (area <= 0) throw new Error('Outline has non-positive net area');
  return { x: qx / area, y: qy / area };
}

/** Bounding dimensions L_x, L_y used for accidental eccentricity. */
export function planDimensions(outline: Outline): { Lx: number; Ly: number } {
  const xs = outline.outer.map((p) => p.x);
  const ys = outline.outer.map((p) => p.y);
  return { Lx: Math.max(...xs) - Math.min(...xs), Ly: Math.max(...ys) - Math.min(...ys) };
}

export function wallLength(w: Wall): number {
  return Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
}

export function wallCentroid(w: Wall): Point {
  return { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
}

/** In-plane direction of a wall. Only orthogonal walls are supported. */
export function wallDirection(w: Wall): Direction {
  const dx = Math.abs(w.end.x - w.start.x);
  const dy = Math.abs(w.end.y - w.start.y);
  if (dy <= ORTHO_TOL * Math.max(dx, 1)) return 'X';
  if (dx <= ORTHO_TOL * Math.max(dy, 1)) return 'Y';
  throw new Error(`Wall ${w.id} is not orthogonal`);
}
