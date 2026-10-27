import type { Point } from './engine';
import type { PlanWall } from './project';

/** Axis-aligned box in page points (viewport at scale 1, y down), including stroke width. */
export interface Bar {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  filled: boolean;
  /** Effective outline width in page points, 0 if not stroked. */
  strokeWidth: number;
  color: LineColor;
}

/** Linework colors used to mark shear walls. */
export type LineColor = 'black' | 'red';

type Matrix = number[];

const DARK = 80; // max RGB channel for "black" linework
const MIN_ASPECT = 4;

/** Classify a pdf.js RGB color (0–255) as black, red, or neither. */
export function lineColor(c: ArrayLike<number> | undefined): LineColor | null {
  if (!c) return null;
  const [r, g, b] = [c[0], c[1], c[2]];
  if (Math.max(r, g, b) < DARK) return 'black';
  if (r >= 150 && Math.max(g, b) <= 100 && r - Math.max(g, b) >= 90) return 'red';
  return null;
}

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): Point => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

interface GState {
  ctm: Matrix;
  lineWidth: number;
  stroke?: ArrayLike<number>;
  fill?: ArrayLike<number>;
}

/**
 * Find black or red bars (filled/outlined thin rectangles or thick straight strokes) in a
 * pdf.js operator list. This is how structural sheets and markups typically draw shear walls
 * and lateral frames.
 */
export function findBars(
  fnArray: number[],
  argsArray: unknown[][],
  OPS: Record<string, number>,
  viewportTransform: Matrix,
): Bar[] {
  let st: GState = { ctm: viewportTransform.slice(), lineWidth: 1 };
  const stack: GState[] = [];
  const bars: Bar[] = [];
  const fillOps = new Set([OPS.fill, OPS.eoFill]);
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke]);
  const bothOps = new Set([OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i] as any[];
    if (fn === OPS.save) stack.push({ ...st, ctm: st.ctm.slice() });
    else if (fn === OPS.restore) st = stack.pop() ?? st;
    else if (fn === OPS.transform) st.ctm = mul(st.ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...st, ctm: st.ctm.slice() });
      if (a[0]) st.ctm = mul(st.ctm, a[0]);
    } else if (fn === OPS.paintFormXObjectEnd) st = stack.pop() ?? st;
    else if (fn === OPS.setLineWidth) st.lineWidth = a[0];
    else if (fn === OPS.setStrokeRGBColor) st.stroke = a as unknown as ArrayLike<number>;
    else if (fn === OPS.setFillRGBColor) st.fill = a as unknown as ArrayLike<number>;
    else if (fn === OPS.constructPath) {
      const paint = fnArray[i + 1];
      const fillColor = fillOps.has(paint) || bothOps.has(paint) ? lineColor(st.fill) : null;
      const strokeColor = strokeOps.has(paint) || bothOps.has(paint) ? lineColor(st.stroke) : null;
      const color = strokeColor ?? fillColor;
      if (!color) continue;
      const bar = pathBar(a[0], a[1], st, OPS, !!fillColor, !!strokeColor, color);
      if (bar) bars.push(bar);
    }
  }
  return dedupe(bars);
}

function pathBar(
  ops: number[],
  args: number[],
  st: GState,
  OPS: Record<string, number>,
  filled: boolean,
  stroked: boolean,
  color: LineColor,
): Bar | null {
  const pts: Point[] = [];
  let k = 0;
  for (const op of ops) {
    if (op === OPS.moveTo || op === OPS.lineTo) {
      pts.push(apply(st.ctm, args[k], args[k + 1]));
      k += 2;
    } else if (op === OPS.rectangle) {
      const [x, y, w, h] = args.slice(k, k + 4);
      pts.push(apply(st.ctm, x, y), apply(st.ctm, x + w, y), apply(st.ctm, x + w, y + h), apply(st.ctm, x, y + h));
      k += 4;
    } else if (op === OPS.closePath) {
      // no coordinates
    } else return null; // curves: not a bar
  }
  if (pts.length < 2 || pts.length > 5) return null;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  // Reject anything that isn't axis-aligned: every point must sit on the bounding box.
  const tol = 0.05 * Math.min(Math.max(x1 - x0, y1 - y0), 10);
  const onBox = (p: Point) =>
    Math.abs(p.x - x0) < tol || Math.abs(p.x - x1) < tol || Math.abs(p.y - y0) < tol || Math.abs(p.y - y1) < tol;
  if (!pts.every(onBox)) return null;

  const strokeWidth = stroked ? st.lineWidth * Math.sqrt(Math.abs(st.ctm[0] * st.ctm[3] - st.ctm[1] * st.ctm[2])) : 0;
  if (stroked) {
    const half = strokeWidth / 2;
    if (pts.length === 2) {
      // Straight stroke with butt caps: widens across its length only.
      if (x1 - x0 >= y1 - y0) [y0, y1] = [y0 - half, y1 + half];
      else [x0, x1] = [x0 - half, x1 + half];
    } else [x0, y0, x1, y1] = [x0 - half, y0 - half, x1 + half, y1 + half];
  }
  const long = Math.max(x1 - x0, y1 - y0);
  const short = Math.min(x1 - x0, y1 - y0);
  if (short <= 0 || long / short < MIN_ASPECT) return null;
  return { x0, y0, x1, y1, filled, strokeWidth, color };
}

function dedupe(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const dup = out.some(
      (o) =>
        o.color === b.color &&
        Math.abs(o.x0 - b.x0) < 1 &&
        Math.abs(o.x1 - b.x1) < 1 &&
        Math.abs(o.y0 - b.y0) < 1 &&
        Math.abs(o.y1 - b.y1) < 1,
    );
    if (!dup) out.push(b);
  }
  return out;
}

export interface WallFilter {
  ftPerPt: number;
  minThicknessFt: number;
  maxThicknessFt: number;
  minLengthFt: number;
  /** Linework colors to accept. */
  colors: LineColor[];
}

/** Bars in the heaviest line weight of their own color (black and red are weighed separately). */
export function heaviestBars(bars: Bar[]): Bar[] {
  const heaviest = new Map<LineColor, number>();
  for (const b of bars) heaviest.set(b.color, Math.max(heaviest.get(b.color) ?? 0, b.strokeWidth));
  return bars.filter((b) => b.strokeWidth >= 0.9 * heaviest.get(b.color)!);
}

/**
 * Turn bars into wall centerlines (page points). For each selected color, keeps wall-sized
 * bars drawn in that color's heaviest line weight. That is how highlighted lateral elements
 * stand out from architectural walls, which are drawn at similar thickness but lighter weight.
 */
export function barsToWalls(bars: Bar[], f: WallFilter): Omit<PlanWall, 'id'>[] {
  const sized = bars.filter((b) => {
    const thick = Math.min(b.x1 - b.x0, b.y1 - b.y0) * f.ftPerPt;
    const len = Math.max(b.x1 - b.x0, b.y1 - b.y0) * f.ftPerPt;
    return f.colors.includes(b.color) && thick >= f.minThicknessFt && thick <= f.maxThicknessFt && len >= f.minLengthFt;
  });
  return heaviestBars(sized).map(barToWall);
}

/** Centerline along the long side of a box. */
export function barToWall(b: Pick<Bar, 'x0' | 'y0' | 'x1' | 'y1'>): Omit<PlanWall, 'id'> {
  const mid = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  return b.x1 - b.x0 >= b.y1 - b.y0
    ? { start: { x: b.x0, y: mid.y }, end: { x: b.x1, y: mid.y } }
    : { start: { x: mid.x, y: b.y0 }, end: { x: mid.x, y: b.y1 } };
}
