import type { Fixity } from './types';

/**
 * Relative rigidity R = 1/Δ for a unit force with E = 1 (E cancels when all walls share f'c).
 *
 * Seismic Design Review Workbook Figs 8.12 / 8.14, with I = tD³/12, A = tD, G = 0.4E:
 *   cantilever: Δ·E·t = 4(H/D)³ + 3(H/D)
 *   fixed:      Δ·E·t =  (H/D)³ + 3(H/D)
 */
export function relativeRigidity(H: number, D: number, t: number, fixity: Fixity): number {
  if (H <= 0 || D <= 0 || t <= 0) throw new Error('H, D and t must be positive');
  const r = H / D;
  const flexure = fixity === 'cantilever' ? 4 * r ** 3 : r ** 3;
  return t / (flexure + 3 * r);
}

/** Full deflection from the workbook equations, for checking the closed form. */
export function deflection(F: number, H: number, D: number, t: number, E: number, fixity: Fixity): number {
  const I = (t * D ** 3) / 12;
  const A = t * D;
  const G = 0.4 * E;
  const k = fixity === 'cantilever' ? 3 : 12;
  return (F * H ** 3) / (k * E * I) + (1.2 * F * H) / (A * G);
}
