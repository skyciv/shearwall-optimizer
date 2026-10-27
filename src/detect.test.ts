import { describe, expect, it } from 'vitest';
import { barsToWalls, findBars, lineColor, type Bar } from './detect';

// Minimal stand-in for pdf.js OPS codes.
const OPS = {
  save: 1, restore: 2, transform: 3, paintFormXObjectBegin: 4, paintFormXObjectEnd: 5, setLineWidth: 6,
  setStrokeRGBColor: 7, setFillRGBColor: 8, constructPath: 9, fill: 10, eoFill: 11, stroke: 12, closeStroke: 13,
  fillStroke: 14, eoFillStroke: 15, closeFillStroke: 16, closeEOFillStroke: 17, moveTo: 18, lineTo: 19,
  rectangle: 20, closePath: 21,
};
const identity = [1, 0, 0, 1, 0, 0];

/** One stroked horizontal line from (0, y) to (len, y). */
function strokedLine(y: number, len: number, rgb: number[], width: number) {
  return {
    fn: [OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.constructPath, OPS.stroke],
    args: [rgb, [width], [[OPS.moveTo, OPS.lineTo], [0, y, len, y]], []],
  };
}

function ops(...parts: { fn: number[]; args: unknown[] }[]) {
  return { fn: parts.flatMap((p) => p.fn), args: parts.flatMap((p) => p.args) as unknown[][] };
}

describe('lineColor', () => {
  it('classifies black, red and others', () => {
    expect(lineColor([0, 0, 0])).toBe('black');
    expect(lineColor([60, 60, 60])).toBe('black');
    expect(lineColor([255, 0, 0])).toBe('red');
    expect(lineColor([200, 40, 30])).toBe('red');
    expect(lineColor([255, 128, 0])).toBeNull(); // orange
    expect(lineColor([255, 200, 200])).toBeNull(); // pink
    expect(lineColor([150, 150, 150])).toBeNull(); // grey
    expect(lineColor(undefined)).toBeNull();
  });
});

describe('findBars / barsToWalls', () => {
  const k = 0.1; // ft per pt
  const filter = { ftPerPt: k, minThicknessFt: 0.25, maxThicknessFt: 3, minLengthFt: 3 };
  // Heavy black (8 pt), light black (3 pt), heavy red (6 pt), light red (3 pt), blue (8 pt).
  const page = ops(
    strokedLine(0, 100, [0, 0, 0], 8),
    strokedLine(50, 100, [0, 0, 0], 3),
    strokedLine(100, 100, [255, 0, 0], 6),
    strokedLine(150, 100, [255, 0, 0], 3),
    strokedLine(200, 100, [0, 0, 255], 8),
  );
  const bars = findBars(page.fn, page.args, OPS, identity);

  it('finds black and red bars only, with their colors', () => {
    expect(bars.map((b: Bar) => [b.color, b.y0 + b.strokeWidth / 2])).toEqual([
      ['black', 0],
      ['black', 50],
      ['red', 100],
      ['red', 150],
    ]);
  });

  it('keeps the heaviest weight of each selected color separately', () => {
    const y = (colors: ('black' | 'red')[]) => barsToWalls(bars, { ...filter, colors }).map((w) => w.start.y);
    expect(y(['black'])).toEqual([0]);
    expect(y(['red'])).toEqual([100]);
    // Red is not judged against the heavier black weight.
    expect(y(['black', 'red'])).toEqual([0, 100]);
  });
});
