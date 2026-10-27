import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WALL_DESIGN,
  evaluateCheck,
  heightWarning,
  parseRunResponse,
  quickDesignUrl,
  storyForces,
  verticalBars,
  wallCalcInput,
  wallLoads,
  type WallDemand,
} from './skyciv';

const wall: WallDemand = { id: 'W1', lengthFt: 10, thicknessFt: 1.5, heightFt: 90, shareOfV: 0.25 };

describe('wall check inputs', () => {
  it("reproduces the calculator's own S_l for its example wall", () => {
    // Example: L 5486, cover 50, #5 vertical, #4 horizontal, 13 bars → S_l 445.4
    expect(verticalBars(5486, 50, 5, 4, 450)).toEqual({ n: 13, spacing: 445.4 });
  });

  it('distributes base shear over the stories (k = 1)', () => {
    // 3 stories × 10 ft, V = 60: h = 10, 20, 30 → F = 10, 20, 30
    const s = storyForces(60, 3, 10, 1);
    expect(s.map((x) => x.F)).toEqual([10, 20, 30]);
    expect(s.map((x) => x.V)).toEqual([60, 50, 30]);
    // Base: 10·10 + 20·20 + 30·30; level 2 story: 20·10 + 30·20; top story: 30·10
    expect(s.map((x) => x.M)).toEqual([1400, 800, 300]);
  });

  it('uses the k exponent', () => {
    const s = storyForces(1400, 3, 10, 2);
    expect(s[0].F).toBeCloseTo(100, 9); // 1400·100/1400
    expect(s[2].F).toBeCloseTo(900, 9);
    expect(s[0].V).toBeCloseTo(1400, 9);
  });

  it('matches the inverted-triangle moment arm h(2n+1)/3 for k = 1', () => {
    const base = storyForces(1000, 9, 10, 1)[0];
    expect(base.M / base.V).toBeCloseTo((10 * 19) / 3, 9);
  });

  it('wall loads: share of base shear and moment, 0.9 self-weight', () => {
    const l = wallLoads(wall, { V: 1000, M: 50000 });
    expect(l.Vu).toBe(250);
    expect(l.Mu).toBe(12500);
    expect(l.Pu).toBeCloseTo(0.9 * 0.15 * 1.5 * 10 * 90, 9);
  });

  it('converts to the metric calculator inputs', () => {
    const input = wallCalcInput(wall, { Vu: 100, Mu: 1000, Pu: 50 }, { ...DEFAULT_WALL_DESIGN, units: 'metric' }, 'W1');
    expect(input).toMatchObject({
      L: 3048,
      H: 25000, // 27432 mm capped at the calculator limit
      W: 457.2,
      cover: 50.8,
      N_bl: 5,
      N_bt: 4,
      S_t: 304.8,
      f_c: 34.47,
      f_y: 413.69,
      V_u: 444.82,
      M_u: 1355.82,
      P_u: 222.41,
    });
    expect(input.long_Spacing as number).toBeLessThanOrEqual(304.8);
  });

  it("reproduces the user's imperial Quick Design file (W1)", () => {
    // Sample saved from the platform: L 127.1417 in, W 16 in, #9 bars @ ~3 in (42), #5 @ 12 in, 5 ksi, 60 ksi.
    const w1: WallDemand = { id: 'W1', lengthFt: 127.1417 / 12, thicknessFt: 16 / 12, heightFt: 90, shareOfV: 0 };
    const design = { ...DEFAULT_WALL_DESIGN, vertBar: 9, vertSpacingIn: 3, horizBar: 5, horizSpacingIn: 12 };
    const input = wallCalcInput(w1, { Vu: 235.901, Pu: 171.6416, Mu: 14940.3539 }, design, 'W1');
    expect(input).toMatchObject({
      L: 127.1417,
      H: 984.252,
      W: 16,
      cover: 2,
      N_bl: 9,
      no_L_Bars: 42,
      long_Spacing: 2.9449,
      N_bt: 5,
      S_t: 12,
      f_c: 5,
      f_y: 60,
      V_u: 235.901,
      P_u: 171.6416,
      M_u: 14940.3539,
      load_combo: 'W1',
      current_unit_system: 'imperial',
    });
    const map = (input.conversion_factors as any).input_unit_map;
    expect((input.conversion_factors as any).default_unit_system).toBe('metric');
    // Same metric originals as the platform wrote.
    expect(map.L).toEqual({ original_units: 'mm', original_val: '3229.4', new_units: 'in', new_value: '127.1417' });
    expect(map.long_Spacing).toMatchObject({ original_val: '74.8', new_value: '2.9449' });
    expect(map.W.original_val).toBe('406.4');
    expect(map.f_c).toMatchObject({ original_units: 'MPa', original_val: '34.47', new_units: 'ksi' });
    expect(map.V_u).toMatchObject({ original_units: 'kN', original_val: '1049.34', new_units: 'kip', new_value: '235.9010' });
    expect(map.M_u).toMatchObject({ original_units: 'kN-m', original_val: '20256.4', new_units: 'kip-ft' });
    expect(map.N_bl).toEqual({ original_units: '#', original_val: '9', new_units: '#', new_value: '9' });
  });

  it('opens Quick Design with metric values even for an imperial run', () => {
    const input = wallCalcInput(wall, { Vu: 100, Mu: 1000, Pu: 50 }, DEFAULT_WALL_DESIGN, 'W1');
    const url = new URL(quickDesignUrl(input));
    expect(url.searchParams.get('L')).toBe('3048');
    expect(url.searchParams.get('V_u')).toBe('444.82');
    expect(url.searchParams.has('conversion_factors')).toBe(false);
  });

  it('warns only when the H cap pushes h/L below 2', () => {
    expect(heightWarning(wall)).toBeNull();
    expect(heightWarning({ ...wall, lengthFt: 45 })).toMatch(/h_w\/l_w < 2/);
  });

  it('builds a Quick Design link with the inputs', () => {
    const url = new URL(quickDesignUrl({ L: 3048, V_u: 444.82 }));
    expect(url.origin + url.pathname).toBe('https://platform.skyciv.com/quick-design');
    expect(url.searchParams.get('uid')).toBe('3003-aci-concrete-wall-calculator');
    expect(url.searchParams.get('L')).toBe('3048');
  });
});

describe('parseRunResponse', () => {
  it('finds the governing ratio, boolean checks and report link', () => {
    const res = parseRunResponse({
      status: 0,
      data: {
        report: 'https://qd.skyciv.com/temp/pdf/reports/abc',
        results: {
          'Utility Ratios': { label: 'Utility Ratios', units: 'heading' },
          'Shear concrete ratio': { label: 'Shear', value: 0.27, units: 'utility' },
          'Bending moment ratio': { label: 'Bending Moment', value: 0.81, units: 'utility' },
          'Detailing checks': { label: 'Detailing Checks', value: false, units: 'utility_boolean' },
          'Shear strength': { label: 'Shear (ΦV_n)', value: '1843.672', units: 'kN' },
        },
      },
      msg: 'Design Calc ran successfully',
    });
    expect(res.ok).toBe(true);
    expect(res.pass).toBe(true);
    expect(res.governing).toMatchObject({ key: 'Bending moment ratio', label: 'Bending Moment', ratio: 0.81, pass: true });
    expect(res.checks).toHaveLength(3);
    expect(res.reportUrl).toBe('https://qd.skyciv.com/temp/pdf/reports/abc');
  });

  it('fails on a ratio over 1 or a failed detailing check', () => {
    const over = parseRunResponse({ status: 0, data: { results: { a: { label: 'Bending', value: 3.99, units: 'utility' } } } });
    expect(over.pass).toBe(false);
    const detailing = parseRunResponse({
      status: 0,
      data: { results: { a: { value: 0.5, units: 'utility' }, d: { label: 'Detailing', value: 1, units: 'utility_boolean' } } },
    });
    expect(detailing.pass).toBe(false);
  });

  it('shear-only judges the wall on shear and lists what it ignored', () => {
    const res = parseRunResponse({
      status: 0,
      data: {
        results: {
          'Shear concrete ratio': { label: 'Shear', value: 0.57, units: 'utility' },
          'Bending moment ratio': { label: 'Bending Moment', value: 3.99, units: 'utility' },
          'Detailing checks': { label: 'Detailing Checks', value: true, units: 'utility_boolean' },
        },
      },
    });
    expect(evaluateCheck(res, false)).toMatchObject({ pass: false, governing: { label: 'Bending Moment' } });
    const shear = evaluateCheck(res, true);
    expect(shear.pass).toBe(true);
    expect(shear.governing).toMatchObject({ label: 'Shear', ratio: 0.57 });
    expect(shear.ignored.map((c) => c.label)).toEqual(['Bending Moment', 'Detailing Checks']);
    // Shear over capacity still fails.
    const over = parseRunResponse({ status: 0, data: { results: { s: { label: 'Shear', value: 1.2, units: 'utility' } } } });
    expect(evaluateCheck(over, true).pass).toBe(false);
  });

  it('reports API errors', () => {
    const res = parseRunResponse({ status: 1, msg: 'Failed to run.', err: 'Invalid key' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Failed to run. – Invalid key');
  });
});
