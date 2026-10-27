/**
 * SkyCiv Quick Design integration: ACI 318-19 concrete shear wall check
 * (calculator 3003-aci-concrete-wall-calculator). See skyciv-ai-skills/run-quick-design.
 *
 * The calculator's native units are metric (mm, kN, kN-m, MPa). It also accepts imperial
 * inputs (in, kip, kip-ft, ksi) when they're sent the way the Quick Design UI saves them:
 * current_unit_system "imperial" plus a conversion_factors map back to metric.
 */

export const WALL_CALC_UID = '3003-aci-concrete-wall-calculator';
const RUN_URL = 'https://qd.skyciv.com/run';
const OPEN_URL = 'https://platform.skyciv.com/quick-design';

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;
const KN_PER_KIP = 4.448222;
const KNM_PER_KIPFT = 1.355818;
const MPA_PER_KSI = 6.894757;
/** Calculator input limit for H, mm. */
const MAX_H_MM = 25000;
const CONCRETE_KCF = 0.15;

/** US bar number → nominal diameter, mm. */
const BAR_DIA_MM: Record<number, number> = { 3: 9.525, 4: 12.7, 5: 15.875, 6: 19.05, 7: 22.225, 8: 25.4, 9: 28.651 };

export interface Credentials {
  /** SkyCiv account email. */
  username: string;
  /** API token from https://platform.skyciv.com/api */
  key: string;
}

export interface WallDesignSettings {
  /** Seismic base shear V, kip (strength level). */
  baseShear: number;
  /** Vertical distribution exponent k, ASCE 7 §12.8.3 (1 for T ≤ 0.5 s, 2 for T ≥ 2.5 s). */
  k: number;
  fcPsi: number;
  fyKsi: number;
  coverIn: number;
  vertBar: number;
  vertSpacingIn: number;
  horizBar: number;
  horizSpacingIn: number;
  /** Units the calculator is run in (and its report shown in). */
  units: UnitSystem;
  /** Judge walls on shear alone; bending and other checks are reported but ignored. */
  shearOnly: boolean;
}

export type UnitSystem = 'imperial' | 'metric';

export const DEFAULT_WALL_DESIGN: WallDesignSettings = {
  baseShear: 0,
  k: 1,
  fcPsi: 5000,
  fyKsi: 60,
  coverIn: 2,
  vertBar: 5,
  vertSpacingIn: 12,
  horizBar: 4,
  horizSpacingIn: 12,
  units: 'imperial',
  shearOnly: false,
};

export interface WallDemand {
  id: string;
  lengthFt: number;
  thicknessFt: number;
  heightFt: number;
  /** Fraction of story shear V carried by the wall (governing case). */
  shareOfV: number;
}

export interface WallLoads {
  Vu: number; // kip
  Mu: number; // kip-ft
  Pu: number; // kip
}

export interface StoryForce {
  /** Level number, 1 = first elevated floor. */
  level: number;
  /** Height of the level above the base, ft. */
  height: number;
  /** Lateral force applied at the level, kip. */
  F: number;
  /** Shear in the story below the level, kip. */
  V: number;
  /** Overturning moment at the bottom of the story below the level, kip-ft. */
  M: number;
}

/**
 * Vertical distribution of the base shear, ASCE 7 §12.8.3: F_x = C_vx·V with
 * C_vx = w_x·h_x^k / Σ w_i·h_i^k. Floors have equal mass (uniform floor mass, same plate),
 * so w cancels. Returns levels bottom-up with story shears and overturning moments.
 */
export function storyForces(V: number, stories: number, storyHeight: number, k: number): StoryForce[] {
  const heights = Array.from({ length: stories }, (_, i) => (i + 1) * storyHeight);
  const sum = heights.reduce((s, h) => s + h ** k, 0);
  const F = heights.map((h) => (V * h ** k) / sum);
  return heights.map((height, i) => {
    const base = height - storyHeight;
    let Vs = 0;
    let M = 0;
    for (let j = i; j < stories; j++) {
      Vs += F[j];
      M += F[j] * (heights[j] - base);
    }
    return { level: i + 1, height, F: F[i], V: Vs, M };
  });
}

/**
 * Base demands for one wall. Every level has the same walls and floor plate, so each wall
 * takes the same share of the story shear at every level, and its share of the base
 * overturning moment too: V_u = share·V_base, M_u = share·M_base. P_u = 0.9 × wall
 * self-weight, the lower bound, which governs flexure.
 */
export function wallLoads(d: WallDemand, base: Pick<StoryForce, 'V' | 'M'>): WallLoads {
  return {
    Vu: d.shareOfV * base.V,
    Mu: d.shareOfV * base.M,
    Pu: 0.9 * CONCRETE_KCF * d.thicknessFt * d.lengthFt * d.heightFt,
  };
}

export type WallCalcInput = Record<string, unknown>;

/** Number of vertical bars along the wall and their actual spacing, mm. */
export function verticalBars(Lmm: number, coverMm: number, vertBar: number, horizBar: number, maxSpacingMm: number) {
  // Same definition as the calculator's S_l: clear run between the outer vertical bars.
  const run = Lmm - 2 * coverMm - 2 * BAR_DIA_MM[horizBar] - BAR_DIA_MM[vertBar];
  const n = Math.max(2, Math.ceil(run / maxSpacingMm - 1e-9) + 1);
  return { n, spacing: Math.round((run / (n - 1)) * 10) / 10 };
}

/** Unit-bearing inputs: metric (native) unit, imperial unit. */
const UNITS: Record<string, [string, string]> = {
  L: ['mm', 'in'],
  H: ['mm', 'in'],
  W: ['mm', 'in'],
  cover: ['mm', 'in'],
  N_bl: ['#', '#'],
  long_Spacing: ['mm', 'in'],
  N_bt: ['#', '#'],
  S_t: ['mm', 'in'],
  f_c: ['MPa', 'ksi'],
  f_y: ['MPa', 'ksi'],
  V_u: ['kN', 'kip'],
  P_u: ['kN', 'kip'],
  M_u: ['kN-m', 'kip-ft'],
};

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Calculator input for one wall. Metric values are always built (they back the Quick Design
 * link and the imperial conversion map); imperial values are computed directly from ft / in /
 * kip, not converted back, so they match what the engineer entered.
 */
export function wallCalcInput(
  d: WallDemand,
  loads: WallLoads,
  s: WallDesignSettings,
  label: string,
): WallCalcInput {
  const Lmm = d.lengthFt * MM_PER_FT;
  const coverMm = s.coverIn * MM_PER_IN;
  const bars = verticalBars(Lmm, coverMm, s.vertBar, s.horizBar, s.vertSpacingIn * MM_PER_IN);
  const metric: Record<string, number> = {
    L: round(Lmm, 1),
    H: round(Math.min(d.heightFt * MM_PER_FT, MAX_H_MM), 1),
    W: round(d.thicknessFt * MM_PER_FT, 1),
    cover: round(coverMm, 1),
    N_bl: s.vertBar,
    long_Spacing: bars.spacing,
    N_bt: s.horizBar,
    S_t: round(s.horizSpacingIn * MM_PER_IN, 1),
    f_c: round((s.fcPsi / 1000) * MPA_PER_KSI, 2),
    f_y: round(s.fyKsi * MPA_PER_KSI, 2),
    V_u: round(loads.Vu * KN_PER_KIP, 2),
    P_u: round(loads.Pu * KN_PER_KIP, 2),
    M_u: round(loads.Mu * KNM_PER_KIPFT, 2),
  };
  const common = { no_L_Bars: bars.n, load_combo: label };
  if (s.units === 'metric') return { ...metric, ...common, current_unit_system: 'metric' };

  const imperial: Record<string, number> = {
    L: round(d.lengthFt * 12, 4),
    H: round(Math.min(d.heightFt * 12, MAX_H_MM / MM_PER_IN), 4),
    W: round(d.thicknessFt * 12, 4),
    cover: round(s.coverIn, 4),
    N_bl: s.vertBar,
    long_Spacing: round(bars.spacing / MM_PER_IN, 4),
    N_bt: s.horizBar,
    S_t: round(s.horizSpacingIn, 4),
    f_c: round(s.fcPsi / 1000, 4),
    f_y: round(s.fyKsi, 4),
    V_u: round(loads.Vu, 4),
    P_u: round(loads.Pu, 4),
    M_u: round(loads.Mu, 4),
  };
  const input_unit_map = Object.fromEntries(
    Object.entries(UNITS).map(([key, [original_units, new_units]]) => [
      key,
      {
        original_units,
        original_val: String(metric[key]),
        new_units,
        new_value: new_units === '#' ? String(imperial[key]) : imperial[key].toFixed(4),
      },
    ]),
  );
  return {
    ...imperial,
    ...common,
    current_unit_system: 'imperial',
    conversion_factors: { default_unit_system: 'metric', current_unit_system: 'imperial', input_unit_map },
  };
}

/**
 * H is capped at the calculator's 25 m limit. ACI 318-19 §11.5.4.3 only uses h_w/l_w, and α_c
 * is constant once h_w/l_w ≥ 2, so the cap is harmless unless it drops the ratio below 2.
 */
export function heightWarning(d: WallDemand): string | null {
  const H = d.heightFt * MM_PER_FT;
  const L = d.lengthFt * MM_PER_FT;
  if (H <= MAX_H_MM) return null;
  return MAX_H_MM / L < 2 ? `H capped at 25 m makes h_w/l_w < 2 for ${d.id}; shear capacity may be overestimated.` : null;
}

/** Link that opens the calculator on the SkyCiv platform with these inputs filled in. */
export function quickDesignUrl(input: WallCalcInput): string {
  // The link is filled in the calculator's native metric units; for an imperial run the
  // metric values come from its conversion map.
  const map = (input.conversion_factors as { input_unit_map?: Record<string, { original_val: string }> } | undefined)
    ?.input_unit_map;
  const params = new URLSearchParams({ uid: WALL_CALC_UID });
  for (const [k, v] of Object.entries(input)) {
    if (k === 'conversion_factors' || k === 'current_unit_system') continue;
    params.set(k, map?.[k]?.original_val ?? String(v));
  }
  return `${OPEN_URL}?${params}`;
}

export interface Check {
  /** Result key from the calculator, e.g. "Shear concrete ratio". */
  key: string;
  label: string;
  ratio: number | null;
  pass: boolean;
}

export interface WallCheckResult {
  ok: boolean;
  pass: boolean;
  governing: Check | null;
  checks: Check[];
  /** PDF report, valid for about an hour. */
  reportUrl: string | null;
  error?: string;
}

interface RawResult {
  value?: unknown;
  units?: string;
  label?: string;
}

/** Parse a /run response. Ratios are entries with units "utility"; "utility_boolean" is 0/false = pass. */
export function parseRunResponse(json: any): WallCheckResult {
  if (!json || json.status !== 0 || !json.data) {
    const error = [json?.msg, json?.err, json?.log].filter(Boolean).join(' – ') || 'Unexpected response from SkyCiv';
    return { ok: false, pass: false, governing: null, checks: [], reportUrl: null, error };
  }
  const checks: Check[] = [];
  for (const [key, raw] of Object.entries((json.data.results ?? {}) as Record<string, RawResult>)) {
    const label = raw.label ?? key;
    if (raw.units === 'utility' && typeof raw.value === 'number') {
      checks.push({ key, label, ratio: raw.value, pass: raw.value <= 1 });
    } else if (raw.units === 'utility_boolean') {
      checks.push({ key, label, ratio: null, pass: !raw.value });
    }
  }
  const ratios = checks.filter((c) => c.ratio !== null);
  const governing = ratios.length ? ratios.reduce((a, b) => (b.ratio! > a.ratio! ? b : a)) : null;
  return {
    ok: true,
    pass: checks.every((c) => c.pass),
    governing,
    checks,
    reportUrl: typeof json.data.report === 'string' ? json.data.report : null,
  };
}

const isShear = (c: Check) => /shear/i.test(`${c.key} ${c.label}`);

/**
 * Pass/fail and governing check as the app judges them. With shearOnly, only the shear
 * check(s) count; bending, axial and detailing results stay in the report but are ignored.
 */
export function evaluateCheck(res: WallCheckResult, shearOnly: boolean): { pass: boolean; governing: Check | null; ignored: Check[] } {
  if (!shearOnly) return { pass: res.pass, governing: res.governing, ignored: [] };
  const used = res.checks.filter(isShear);
  const ratios = used.filter((c) => c.ratio !== null);
  return {
    pass: used.length > 0 && used.every((c) => c.pass),
    governing: ratios.length ? ratios.reduce((a, b) => (b.ratio! > a.ratio! ? b : a)) : null,
    ignored: res.checks.filter((c) => !isShear(c)),
  };
}

export async function runWallCheck(creds: Credentials, input: WallCalcInput, signal?: AbortSignal): Promise<WallCheckResult> {
  try {
    const res = await fetch(RUN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: JSON.stringify({ uid: WALL_CALC_UID, auth: creds.username, key: creds.key, pdf_report: true, input }),
      }),
      signal,
    });
    if (!res.ok) return { ok: false, pass: false, governing: null, checks: [], reportUrl: null, error: `HTTP ${res.status}` };
    return parseRunResponse(await res.json());
  } catch (e) {
    return { ok: false, pass: false, governing: null, checks: [], reportUrl: null, error: (e as Error).message };
  }
}
