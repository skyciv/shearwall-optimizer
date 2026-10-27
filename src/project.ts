import { DEFAULT_SETTINGS, type BuildingSettings, type Outline, type Point, type Wall } from './engine';
import { DEFAULT_WALL_DESIGN, type WallDesignSettings } from './skyciv';

/**
 * Plan geometry is stored in PDF points (page viewport at scale 1, y down) so it stays
 * attached to the drawing. It is converted to feet (y up) only for analysis.
 */
export interface PlanWall {
  id: string;
  start: Point;
  end: Point;
  /** Excluded from optimization (cores, stairs, fixed architecture). */
  locked?: boolean;
}

export interface Project {
  pageNumber: number;
  /** Real-world feet per PDF point; null until the scale is set. */
  ftPerPt: number | null;
  outline: Point[] | null;
  holes: Point[][];
  walls: PlanWall[];
  settings: BuildingSettings;
  /** Inputs for the SkyCiv ACI wall check. */
  wallDesign: WallDesignSettings;
}

export const emptyProject = (): Project => ({
  pageNumber: 1,
  ftPerPt: null,
  outline: null,
  holes: [],
  walls: [],
  settings: { ...DEFAULT_SETTINGS },
  wallDesign: { ...DEFAULT_WALL_DESIGN },
});

export interface Frame {
  pageHeight: number;
  ftPerPt: number;
}

export const ptToFt = (p: Point, f: Frame): Point => ({ x: p.x * f.ftPerPt, y: (f.pageHeight - p.y) * f.ftPerPt });
export const ftToPt = (p: Point, f: Frame): Point => ({ x: p.x / f.ftPerPt, y: f.pageHeight - p.y / f.ftPerPt });

export function toEngine(project: Project, f: Frame): { outline: Outline; walls: Wall[] } | null {
  if (!project.outline) return null;
  const conv = (pts: Point[]) => pts.map((p) => ptToFt(p, f));
  return {
    outline: { outer: conv(project.outline), holes: project.holes.map(conv) },
    walls: project.walls.map((w) => ({
      id: w.id,
      start: ptToFt(w.start, f),
      end: ptToFt(w.end, f),
      t: project.settings.wallThickness,
    })),
  };
}

export function nextWallId(walls: PlanWall[]): string {
  const n = walls.reduce((m, w) => Math.max(m, Number(w.id.replace(/\D/g, '')) || 0), 0);
  return `W${n + 1}`;
}

/** Architectural scales: sheet inches per real foot. Valid only for PDFs at true print size. */
export const SCALE_PRESETS: { label: string; inPerFt: number }[] = [
  { label: '1/32" = 1\'-0"', inPerFt: 1 / 32 },
  { label: '1/16" = 1\'-0"', inPerFt: 1 / 16 },
  { label: '3/32" = 1\'-0"', inPerFt: 3 / 32 },
  { label: '1/8" = 1\'-0"', inPerFt: 1 / 8 },
  { label: '3/16" = 1\'-0"', inPerFt: 3 / 16 },
  { label: '1/4" = 1\'-0"', inPerFt: 1 / 4 },
];

export const ftPerPtFromScale = (inPerFt: number) => 1 / (72 * inPerFt);

/** Accepts 25, 25.5, 25'-6", 25' 6", 25 6 → feet. */
export function parseFeet(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(?:'|ft)?\s*-?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in)?)?$/);
  if (!m) return null;
  const ft = Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
  return ft > 0 ? ft : null;
}

/** Length changes smaller than this round to 0" and aren't reported. */
export const HALF_INCH = 1 / 24;

/** Percent with one decimal; avoids "-0.0%". */
export const pct = (v: number) => `${(Math.abs(v) < 5e-4 ? 0 : v * 100).toFixed(1)}%`;

export function formatFtIn(ft: number): string {
  const totalIn = Math.round(Math.abs(ft) * 12);
  const sign = ft < 0 && totalIn > 0 ? '-' : '';
  return `${sign}${Math.floor(totalIn / 12)}'-${totalIn % 12}"`;
}
