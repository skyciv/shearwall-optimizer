import { barToWall, heaviestBars, lineColor, type Bar } from './detect';
import type { Point } from './engine';
import type { PlanWall } from './project';

/** A PDF markup annotation (e.g. from Bluebeam), with geometry in page points (y down). */
export interface Markup {
  subtype: string;
  author: string;
  contents: string;
  borderWidth: number;
  /** Markup color as RGB 0–255 (what Bluebeam displays), if set. */
  color?: [number, number, number] | null;
  /** Opposite corners of the annotation rectangle. */
  rect: [Point, Point] | null;
  /** Polygon / PolyLine vertices. */
  vertices?: Point[];
  /** Line markup end points. */
  line?: [Point, Point];
}

export interface MarkupImportOptions {
  /** Also take red Line / PolyLine markups as shear wall centerlines. */
  redLines?: boolean;
}

export interface MarkupImport {
  outline: Point[] | null;
  holes: Point[][];
  walls: Omit<PlanWall, 'id'>[];
  /** Markups not used, by type ("red Line" when red lines exist but weren't imported). */
  ignored: Record<string, number>;
  authors: string[];
}

const MIN_ASPECT = 4;
/** Max out-of-square slope for a line markup to count as an orthogonal wall. */
const ORTHO_SLOPE = 0.05;
const MIN_LINE_FT = 3;

/** Straight, orthogonal segments of a red line markup as wall centerlines; angled segments are dropped. */
function lineWalls(m: Markup, ftPerPt: number | null): Omit<PlanWall, 'id'>[] {
  const pts = m.line ?? m.vertices ?? [];
  const walls: Omit<PlanWall, 'id'>[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const len = Math.max(dx, dy);
    if (len === 0 || (ftPerPt && len * ftPerPt < MIN_LINE_FT)) continue;
    // Snap to the nearest axis through the segment's mid-line.
    if (dy <= ORTHO_SLOPE * dx) {
      const y = (a.y + b.y) / 2;
      walls.push({ start: { x: a.x, y }, end: { x: b.x, y } });
    } else if (dx <= ORTHO_SLOPE * dy) {
      const x = (a.x + b.x) / 2;
      walls.push({ start: { x, y: a.y }, end: { x, y: b.y } });
    }
  }
  return walls;
}

function area(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function inside(p: Point, poly: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * Map markups onto the model:
 * - the largest Polygon is the slab outline; Polygons inside it are voids;
 * - thin Squares (rectangle markups) are shear walls, located by the Square's rectangle and
 *   trimmed to the drawn wall length (see below);
 * - with `redLines`, red Line / PolyLine markups are shear wall centerlines.
 * Everything else (other lines, text, stamps, clouds) is counted and ignored.
 */
export function importMarkups(
  markups: Markup[],
  bars: Bar[],
  ftPerPt: number | null,
  opts: MarkupImportOptions = {},
): MarkupImport {
  const ignored: Record<string, number> = {};
  const skip = (type: string) => (ignored[type] = (ignored[type] ?? 0) + 1);
  const lineMarkupWalls: Omit<PlanWall, 'id'>[] = [];

  const polygons = markups
    .filter((m) => m.subtype === 'Polygon' && (m.vertices?.length ?? 0) >= 3)
    .map((m) => m.vertices!)
    .sort((a, b) => area(b) - area(a));
  const outline = polygons[0] ?? null;
  const holes: Point[][] = [];
  for (const poly of polygons.slice(1)) {
    if (outline && poly.every((p) => inside(p, outline))) holes.push(poly);
    else skip('Polygon');
  }

  type Box = Pick<Bar, 'x0' | 'y0' | 'x1' | 'y1'>;
  const len = (b: Box) => Math.max(b.x1 - b.x0, b.y1 - b.y0);
  const heavy = heaviestBars(bars);

  // The Square's rectangle is the ground truth for where the wall is: it is what Bluebeam shows
  // and prints. Its stored appearance can be stale, so a heavy bar only refines the length when
  // it sits inside the Square and spans most of it.
  const squares: { box: Box; bar?: Box }[] = [];
  for (const m of markups) {
    if (m.subtype === 'Polygon') continue;
    if ((m.subtype === 'Line' || m.subtype === 'PolyLine') && lineColor(m.color ?? undefined) === 'red') {
      if (opts.redLines) lineMarkupWalls.push(...lineWalls(m, ftPerPt));
      else skip(`red ${m.subtype}`);
      continue;
    }
    if (m.subtype !== 'Square' || !m.rect) {
      skip(m.subtype);
      continue;
    }
    // Rectangle path sits half a border width inside the annotation rect.
    const h = m.borderWidth / 2;
    const box = {
      x0: Math.min(m.rect[0].x, m.rect[1].x) + h,
      x1: Math.max(m.rect[0].x, m.rect[1].x) - h,
      y0: Math.min(m.rect[0].y, m.rect[1].y) + h,
      y1: Math.max(m.rect[0].y, m.rect[1].y) - h,
    };
    const long = len(box);
    const short = Math.min(box.x1 - box.x0, box.y1 - box.y0);
    const thickFt = ftPerPt ? short * ftPerPt : null;
    if (short <= 0 || long / short < MIN_ASPECT || (thickFt !== null && (thickFt < 0.25 || thickFt > 3))) {
      skip('Square');
      continue;
    }
    const horizontal = box.x1 - box.x0 >= box.y1 - box.y0;
    const tol = 2;
    const bar = heavy
      .filter(
        (b) =>
          b.x0 >= box.x0 - tol &&
          b.x1 <= box.x1 + tol &&
          b.y0 >= box.y0 - tol &&
          b.y1 <= box.y1 + tol &&
          b.x1 - b.x0 >= b.y1 - b.y0 === horizontal &&
          len(b) >= 0.8 * long,
      )
      .sort((a, b) => len(b) - len(a))[0];
    squares.push({ box, bar });
  }

  // Squares are usually drawn with some padding past the wall ends. Measure it on the
  // squares that matched a bar and trim the same amount from the rest.
  const pads = squares.filter((s) => s.bar).map((s) => len(s.box) - len(s.bar!)).sort((a, b) => a - b);
  const pad = pads.length ? pads[Math.floor(pads.length / 2)] : 0;
  const walls = squares.map(({ box, bar }) => {
    if (bar) return barToWall(bar);
    const trim = pad > 0 && pad < len(box) / 2 ? pad / 2 : 0;
    const horizontal = box.x1 - box.x0 >= box.y1 - box.y0;
    return barToWall(
      horizontal ? { ...box, x0: box.x0 + trim, x1: box.x1 - trim } : { ...box, y0: box.y0 + trim, y1: box.y1 - trim },
    );
  });

  const authors = [...new Set(markups.map((m) => m.author).filter(Boolean))];
  return { outline, holes, walls: [...walls, ...lineMarkupWalls], ignored, authors };
}
