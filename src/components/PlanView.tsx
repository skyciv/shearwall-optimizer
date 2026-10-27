import { useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '../engine';
import type { PDFDocumentProxy, RenderTask } from '../pdf';
import type { PlanWall, Project } from '../project';

export type Tool = 'select' | 'calibrate' | 'outline' | 'hole' | 'wall';

const MAX_CANVAS_PX = 8192;
const SNAP_PX = 8;

interface Props {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  tool: Tool;
  project: Project;
  selectedWallId: string | null;
  calibrationPts: Point[] | null;
  /** Analysis markers in PDF points. */
  markers: { cm?: Point; cr?: Point };
  /** Wall positions before the last optimization. */
  ghostWalls?: PlanWall[];
  onPageSize: (size: { width: number; height: number }) => void;
  onCalibrate: (a: Point, b: Point) => void;
  onPolygon: (kind: 'outline' | 'hole', pts: Point[]) => void;
  onWall: (a: Point, b: Point) => void;
  onSelectWall: (id: string | null) => void;
  onDeleteSelected: () => void;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const ortho = (anchor: Point, p: Point): Point =>
  Math.abs(p.x - anchor.x) >= Math.abs(p.y - anchor.y) ? { x: p.x, y: anchor.y } : { x: anchor.x, y: p.y };
const pathOf = (pts: Point[]) => `M${pts.map((p) => `${p.x},${p.y}`).join('L')}Z`;

export function PlanView(props: Props) {
  const { pdf, pageNumber, zoom, tool, project, selectedWallId, calibrationPts, markers } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [draft, setDraft] = useState<Point[]>([]);
  const [hover, setHover] = useState<Point | null>(null);
  const [freeAngle, setFreeAngle] = useState(false);

  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setSize({ width: base.width, height: base.height });
      cb.current.onPageSize({ width: base.width, height: base.height });
      const scale = Math.min(zoom * (window.devicePixelRatio || 1), MAX_CANVAS_PX / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
      await task.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, zoom]);

  useEffect(() => setDraft([]), [tool]);

  const snapTargets = useMemo(() => {
    const pts: Point[] = [...(project.outline ?? []), ...project.holes.flat()];
    for (const w of project.walls) pts.push(w.start, w.end);
    return pts;
  }, [project.outline, project.holes, project.walls]);

  const isPolygon = tool === 'outline' || tool === 'hole';
  const tol = SNAP_PX / zoom;

  function resolve(raw: Point): Point {
    let p = raw;
    let best = tol;
    for (const t of snapTargets) {
      const d = dist(raw, t);
      if (d < best) {
        best = d;
        p = t;
      }
    }
    const anchor = draft[draft.length - 1];
    if (anchor && (tool === 'wall' || (isPolygon && !freeAngle))) p = ortho(anchor, p);
    return p;
  }

  function toPt(e: React.MouseEvent): Point {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  }

  function closePolygon(pts: Point[]) {
    if (pts.length >= 3) props.onPolygon(tool as 'outline' | 'hole', pts);
    setDraft([]);
  }

  function handleClick(e: React.MouseEvent) {
    const raw = toPt(e);
    if (tool === 'select') {
      props.onSelectWall(null);
      return;
    }
    if (isPolygon && draft.length >= 3 && dist(raw, draft[0]) < tol) {
      closePolygon(draft);
      return;
    }
    const p = resolve(raw);
    if (tool === 'calibrate') {
      if (draft.length === 1) {
        props.onCalibrate(draft[0], p);
        setDraft([]);
      } else setDraft([p]);
    } else if (tool === 'wall') {
      if (draft.length === 1) {
        if (dist(draft[0], p) > 0) props.onWall(draft[0], p);
        setDraft([]);
      } else setDraft([p]);
    } else {
      setDraft([...draft, p]);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Shift') setFreeAngle(true);
      if (e.key === 'Escape') setDraft([]);
      if (e.key === 'Enter' && isPolygon) closePolygon(draft);
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (draft.length) setDraft(draft.slice(0, -1));
        else cb.current.onDeleteSelected();
        e.preventDefault();
      }
    }
    const onKeyUp = (e: KeyboardEvent) => e.key === 'Shift' && setFreeAngle(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  const W = size?.width ?? 0;
  const H = size?.height ?? 0;
  const px = (n: number) => n / zoom; // screen pixels → PDF points
  const tPts = project.ftPerPt ? project.settings.wallThickness / project.ftPerPt : 0;
  const preview = hover && draft.length ? [...draft, resolve(hover)] : draft;

  return (
    <div className="plan" style={{ width: W * zoom, height: H * zoom }}>
      <canvas ref={canvasRef} className="plan-canvas" style={{ width: W * zoom, height: H * zoom }} />
      {size && <svg
        ref={svgRef}
        className={`plan-overlay tool-${tool}`}
        width={W * zoom}
        height={H * zoom}
        viewBox={`0 0 ${W} ${H}`}
        onClick={handleClick}
        onMouseMove={(e) => setHover(toPt(e))}
        onMouseLeave={() => setHover(null)}
      >
        {project.outline && (
          <path
            className="slab"
            d={[project.outline, ...project.holes].map(pathOf).join(' ')}
            fillRule="evenodd"
            strokeWidth={px(2)}
          />
        )}
        {project.holes.map((h, i) => (
          <path key={i} className="hole" d={pathOf(h)} strokeWidth={px(1.5)} strokeDasharray={`${px(6)} ${px(4)}`} />
        ))}

        {props.ghostWalls?.map((g) => {
          const w = project.walls.find((c) => c.id === g.id);
          if (w && w.start.x === g.start.x && w.start.y === g.start.y && w.end.x === g.end.x && w.end.y === g.end.y) return null;
          return (
            <line
              key={`ghost-${g.id}`}
              className={w ? 'ghost' : 'ghost removed'}
              x1={g.start.x}
              y1={g.start.y}
              x2={g.end.x}
              y2={g.end.y}
              strokeWidth={px(2)}
              strokeDasharray={`${px(5)} ${px(4)}`}
            />
          );
        })}

        {project.walls.map((w) => {
          const horizontal = Math.abs(w.end.x - w.start.x) >= Math.abs(w.end.y - w.start.y);
          const mid = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
          return (
            <g
              key={w.id}
              className={`wall wall-${horizontal ? 'x' : 'y'} ${w.id === selectedWallId ? 'selected' : ''}`}
              onClick={(e) => {
                if (tool !== 'select') return;
                e.stopPropagation();
                props.onSelectWall(w.id);
              }}
            >
              <line x1={w.start.x} y1={w.start.y} x2={w.end.x} y2={w.end.y} className="wall-hit" strokeWidth={px(14)} />
              <line x1={w.start.x} y1={w.start.y} x2={w.end.x} y2={w.end.y} className="wall-body" strokeWidth={Math.max(tPts, px(4))} />
              <text x={mid.x} y={mid.y} dx={horizontal ? 0 : px(8)} dy={horizontal ? px(-8) : px(4)} fontSize={px(11)}>
                {w.locked ? `${w.id} 🔒` : w.id}
              </text>
            </g>
          );
        })}

        {markers.cm && markers.cr && (
          <line
            className="ecc-line"
            x1={markers.cm.x}
            y1={markers.cm.y}
            x2={markers.cr.x}
            y2={markers.cr.y}
            strokeWidth={px(1.5)}
            strokeDasharray={`${px(4)} ${px(3)}`}
          />
        )}
        {markers.cm && (
          <g className="marker cm" transform={`translate(${markers.cm.x},${markers.cm.y})`}>
            <circle r={px(7)} strokeWidth={px(2)} />
            <path d={`M${-px(11)},0H${px(11)}M0,${-px(11)}V${px(11)}`} strokeWidth={px(1.5)} />
            <text x={px(10)} y={px(-10)} fontSize={px(12)}>CM</text>
          </g>
        )}
        {markers.cr && (
          <g className="marker cr" transform={`translate(${markers.cr.x},${markers.cr.y})`}>
            <path d={`M0,${-px(8)}L${px(8)},0L0,${px(8)}L${-px(8)},0Z`} strokeWidth={px(2)} />
            <text x={px(10)} y={px(18)} fontSize={px(12)}>CR</text>
          </g>
        )}

        {calibrationPts && calibrationPts.length === 2 && (
          <line
            className="calib"
            x1={calibrationPts[0].x}
            y1={calibrationPts[0].y}
            x2={calibrationPts[1].x}
            y2={calibrationPts[1].y}
            strokeWidth={px(2)}
          />
        )}

        {preview.length > 0 && (
          <g className={`draft draft-${tool}`}>
            <polyline points={preview.map((p) => `${p.x},${p.y}`).join(' ')} strokeWidth={tool === 'wall' ? Math.max(tPts, px(4)) : px(2)} />
            {draft.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={px(i === 0 && isPolygon && draft.length >= 3 ? 6 : 3.5)} />
            ))}
          </g>
        )}
      </svg>}
    </div>
  );
}
