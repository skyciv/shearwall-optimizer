import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { findBars, type Bar } from './detect';
import type { Point } from './engine';
import type { Markup } from './markups';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

export async function loadPdf(file: File) {
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}

/** Black and red bars on a page, in page points (viewport at scale 1). */
export async function detectBars(pdf: pdfjs.PDFDocumentProxy, pageNumber: number): Promise<Bar[]> {
  const page = await pdf.getPage(pageNumber);
  const ops = await page.getOperatorList();
  return findBars(ops.fnArray, ops.argsArray, pdfjs.OPS, page.getViewport({ scale: 1 }).transform);
}

const NOT_MARKUPS = new Set(['Link', 'Widget', 'Popup']);

/** Markup annotations on a page (Bluebeam and other PDF markup tools), in page points. */
export async function readMarkups(pdf: pdfjs.PDFDocumentProxy, pageNumber: number): Promise<Markup[]> {
  const page = await pdf.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const toPt = (x: number, y: number): Point => {
    const [px, py] = vp.convertToViewportPoint(x, y);
    return { x: px, y: py };
  };
  const annotations = await page.getAnnotations();
  return annotations
    .filter((a) => !NOT_MARKUPS.has(a.subtype))
    .map((a): Markup => {
      // pdf.js gives vertices as {x, y}[] or as a flat number list depending on version.
      let vertices: Point[] | undefined;
      if (a.vertices) {
        const raw = Object.values(a.vertices) as (number | Point)[];
        vertices =
          typeof raw[0] === 'number'
            ? Array.from({ length: raw.length / 2 }, (_, i) => toPt(raw[2 * i] as number, raw[2 * i + 1] as number))
            : (raw as Point[]).map((p) => toPt(p.x, p.y));
      }
      const lc = a.lineCoordinates as number[] | undefined;
      return {
        subtype: a.subtype,
        author: a.titleObj?.str ?? '',
        contents: a.contentsObj?.str ?? '',
        borderWidth: a.borderStyle?.width ?? 1,
        color: a.color ? [a.color[0], a.color[1], a.color[2]] : null,
        rect: a.rect ? [toPt(a.rect[0], a.rect[1]), toPt(a.rect[2], a.rect[3])] : null,
        vertices,
        line: lc ? [toPt(lc[0], lc[1]), toPt(lc[2], lc[3])] : undefined,
      };
    });
}
