import { describe, expect, it } from 'vitest';
import type { Bar } from './detect';
import type { Point } from './engine';
import { importMarkups, type Markup } from './markups';

const square = (x0: number, y0: number, x1: number, y1: number, borderWidth = 1): Markup => ({
  subtype: 'Square',
  author: 'sandesha',
  contents: '',
  borderWidth,
  rect: [
    { x: x0, y: y1 },
    { x: x1, y: y0 },
  ],
});
const polygon = (pts: [number, number][]): Markup => ({
  subtype: 'Polygon',
  author: 'sandesha',
  contents: '',
  borderWidth: 1,
  rect: null,
  vertices: pts.map(([x, y]) => ({ x, y })),
});
const ftPerPt = 0.148148; // 3/32" = 1'-0"

describe('importMarkups', () => {
  const outer = polygon([[0, 0], [1000, 0], [1000, 800], [0, 800]]);
  const shaft = polygon([[400, 300], [500, 300], [500, 400], [400, 400]]);
  const outside = polygon([[1200, 0], [1300, 0], [1300, 100]]);

  it('takes the largest polygon as the outline and inner ones as voids', () => {
    const res = importMarkups([shaft, outer, outside], [], ftPerPt);
    expect(res.outline).toEqual(outer.vertices);
    expect(res.holes).toEqual([shaft.vertices]);
    expect(res.ignored).toEqual({ Polygon: 1 });
  });

  it('turns thin squares into walls and ignores big boxes, lines and text', () => {
    const markups: Markup[] = [
      square(100, 100, 110.7, 174), // 1.6 ft × 10.9 ft vertical wall
      square(200, 50, 900, 600), // review cloud / region box
      { subtype: 'Line', author: '', contents: '', borderWidth: 5, rect: null },
      { subtype: 'FreeText', author: '', contents: 'LATERAL FRAMES', borderWidth: 1, rect: null },
    ];
    const res = importMarkups(markups, [], ftPerPt);
    expect(res.walls).toEqual([{ start: { x: 105.35, y: 100.5 }, end: { x: 105.35, y: 173.5 } }]);
    expect(res.ignored).toEqual({ Square: 1, Line: 1, FreeText: 1 });
    expect(res.authors).toEqual(['sandesha']);
  });

  it('prefers the heavy linework inside a square for exact wall geometry', () => {
    const bar: Bar = { x0: 102, y0: 103, x1: 108.5, y1: 171, filled: true, strokeWidth: 6, color: 'black' };
    const res = importMarkups([square(100, 100, 110.7, 174)], [bar], ftPerPt);
    expect(res.walls).toEqual([{ start: { x: 105.25, y: 103 }, end: { x: 105.25, y: 171 } }]);
  });

  describe('red line markups', () => {
    const line = (pts: [number, number][], color: [number, number, number] = [255, 0, 0]): Markup => ({
      subtype: pts.length === 2 ? 'Line' : 'PolyLine',
      author: '',
      contents: '',
      borderWidth: 5,
      color,
      rect: null,
      ...(pts.length === 2
        ? { line: [{ x: pts[0][0], y: pts[0][1] }, { x: pts[1][0], y: pts[1][1] }] as [Point, Point] }
        : { vertices: pts.map(([x, y]) => ({ x, y })) }),
    });

    it('are counted but not imported unless asked', () => {
      const res = importMarkups([line([[0, 0], [100, 0]]), line([[0, 50], [100, 50]], [0, 0, 255])], [], ftPerPt);
      expect(res.walls).toEqual([]);
      expect(res.ignored).toEqual({ 'red Line': 1, Line: 1 });
    });

    it('become walls, snapped orthogonal, dropping angled and short segments', () => {
      const markups = [
        line([[10, 10], [110, 12]]), // nearly horizontal → y = 11
        line([[200, 0], [200.5, 80], [260, 80], [300, 140]]), // vertical, horizontal, then a diagonal
        line([[0, 300], [10, 300]]), // 1.5 ft: too short
        line([[0, 400], [100, 400]], [0, 0, 0]), // black: not a shear wall line
      ];
      const res = importMarkups(markups, [], ftPerPt, { redLines: true });
      expect(res.walls).toEqual([
        { start: { x: 10, y: 11 }, end: { x: 110, y: 11 } },
        { start: { x: 200.25, y: 0 }, end: { x: 200.25, y: 80 } },
        { start: { x: 200.5, y: 80 }, end: { x: 260, y: 80 } },
      ]);
      expect(res.ignored).toEqual({ Line: 1 });
    });
  });

  it('ignores light linework and trims unmatched squares by the typical padding', () => {
    const heavyBar: Bar = { x0: 102, y0: 103, x1: 108.5, y1: 171, filled: true, strokeWidth: 6, color: 'black' };
    // A light architectural line inside the second square must not be used.
    const light: Bar = { x0: 302, y0: 110, x1: 308, y1: 160, filled: false, strokeWidth: 1.2, color: 'black' };
    const res = importMarkups([square(100, 100, 110.7, 174), square(300, 100, 310.7, 174)], [heavyBar, light], ftPerPt);
    // Matched square: 73 pt inside its border vs a 68 pt bar → 5 pt padding, 2.5 pt per end.
    expect(res.walls[1]).toEqual({ start: { x: 305.35, y: 103 }, end: { x: 305.35, y: 171 } });
  });
});
