import { useEffect, useMemo, useRef, useState } from 'react';
import { PlanView, type Tool } from './components/PlanView';
import { Results } from './components/Results';
import { loadCredentials, SettingsDialog } from './components/SettingsDialog';
import { WallChecks, type CheckRecord, type WallCheckRow } from './components/WallChecks';
import {
  analyzeLevel,
  centerOfMass,
  checkLayout,
  DEFAULT_SETTINGS,
  optimizeLayout,
  wallHeight,
  type BuildingSettings,
  type LevelAnalysis,
  type Point,
} from './engine';
import { barsToWalls, lineColor, type LineColor } from './detect';
import { importMarkups, type Markup } from './markups';
import { detectBars, loadPdf, readMarkups, type PDFDocumentProxy } from './pdf';
import {
  DEFAULT_WALL_DESIGN,
  heightWarning,
  runWallCheck,
  storyForces,
  wallCalcInput,
  wallLoads,
  type Credentials,
  type UnitSystem,
  type WallDesignSettings,
} from './skyciv';
import {
  emptyProject,
  formatFtIn,
  ftPerPtFromScale,
  ftToPt,
  nextWallId,
  HALF_INCH,
  parseFeet,
  pct,
  SCALE_PRESETS,
  toEngine,
  type PlanWall,
  type Project,
} from './project';

interface OptimizeSummary {
  /** Layout and thickness before optimizing: the undo point and the baseline for re-runs. */
  previous: PlanWall[];
  previousThickness: number;
  before: Point;
  after: Point;
  /** Original → optimized length per kept wall, ft. */
  lengths: Record<string, { from: number; to: number }>;
  removed: string[];
  thickness: number;
  stiffness: Point;
  stiffnessShort: boolean;
}

interface OptimizerLimits {
  maxLength: number;
  minLength: number;
  allowShortening: boolean;
  allowRemoval: boolean;
  minThicknessIn: number;
  maxThicknessIn: number;
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 6;

const TOOL_HELP: Record<Tool, string> = {
  select: 'Click a wall to select it. Delete or Backspace removes it.',
  calibrate: 'Click two points a known distance apart (e.g. two grid lines), then enter the distance.',
  outline: 'Click the slab corners. Click the first point or press Enter to close. Hold Shift for angled edges, Backspace undoes a point, Esc cancels.',
  hole: 'Trace courtyards, shafts and other voids with no floor mass. Same controls as the outline.',
  wall: 'Click the start and end of a wall centerline. Walls snap horizontal/vertical and to existing points.',
};

function lengthSummary(lengths: OptimizeSummary['lengths']): string {
  const changes = Object.values(lengths).map((l) => l.to - l.from);
  const longer = changes.filter((d) => d >= HALF_INCH);
  const shorter = changes.filter((d) => d <= -HALF_INCH);
  if (!longer.length && !shorter.length) return 'No length changes needed.';
  const parts = [];
  if (longer.length) parts.push(`${longer.length} lengthened (up to +${formatFtIn(Math.max(...longer))})`);
  if (shorter.length) parts.push(`${shorter.length} shortened (up to ${formatFtIn(Math.min(...shorter))})`);
  return `${parts.join(', ')}.`;
}

export default function App() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState('');
  const [loadError, setLoadError] = useState('');
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>('select');
  const [project, setProject] = useState<Project>(emptyProject);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [calPts, setCalPts] = useState<Point[] | null>(null);
  const [calInput, setCalInput] = useState('');
  const [dragging, setDragging] = useState(false);
  const [optimized, setOptimized] = useState<OptimizeSummary | null>(null);
  const [limits, setLimits] = useState<OptimizerLimits>({
    maxLength: 30,
    minLength: 6,
    allowShortening: false,
    allowRemoval: true,
    minThicknessIn: 12,
    maxThicknessIn: 24,
  });
  const [detectMsg, setDetectMsg] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [markups, setMarkups] = useState<Markup[]>([]);
  const [wallColors, setWallColors] = useState<Record<LineColor, boolean>>({ black: true, red: true });
  const [redLineMarkups, setRedLineMarkups] = useState(false);
  const redLineCount = markups.filter(
    (m) => (m.subtype === 'Line' || m.subtype === 'PolyLine') && lineColor(m.color ?? undefined) === 'red',
  ).length;
  const [credentials, setCredentials] = useState<Credentials | null>(loadCredentials);
  const [showSettings, setShowSettings] = useState(false);
  const [checks, setChecks] = useState<Record<string, CheckRecord>>({});
  const [checkRun, setCheckRun] = useState<{ done: number; total: number } | null>(null);
  const checkAbort = useRef<AbortController | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const fitPending = useRef(false);

  const update = (patch: Partial<Project>) => {
    // Any geometry edit invalidates the last optimization's undo point.
    if (patch.walls || patch.outline || patch.holes) setOptimized(null);
    setProject((p) => ({ ...p, ...patch }));
  };
  const updateDesign = (patch: Partial<WallDesignSettings>) =>
    setProject((p) => ({ ...p, wallDesign: { ...p.wallDesign, ...patch } }));
  const updateSettings = (patch: Partial<BuildingSettings>) => {
    if (patch.wallThickness !== undefined) setOptimized(null);
    setProject((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  };

  useEffect(() => {
    setMarkups([]);
    if (!pdf) return;
    let stale = false;
    readMarkups(pdf, project.pageNumber)
      .then((m) => !stale && setMarkups(m))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [pdf, project.pageNumber]);

  async function openPdf(file: File) {
    setLoadError('');
    try {
      const doc = await loadPdf(file);
      fitPending.current = true;
      setPdf(doc);
      setFileName(file.name);
      setProject(emptyProject());
      setOptimized(null);
      setSelectedWallId(null);
      setCalPts(null);
      setTool('calibrate');
    } catch (e) {
      setLoadError(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  }

  function fit(size = pageSize) {
    const el = viewerRef.current;
    if (!el || !size) return;
    const z = Math.min((el.clientWidth - 48) / size.width, (el.clientHeight - 48) / size.height);
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)));
  }

  function handlePageSize(size: { width: number; height: number }) {
    setPageSize(size);
    if (fitPending.current) {
      fitPending.current = false;
      fit(size);
    }
  }

  function applyCalibration() {
    const ft = parseFeet(calInput);
    if (!calPts || !ft) return;
    const d = Math.hypot(calPts[1].x - calPts[0].x, calPts[1].y - calPts[0].y);
    update({ ftPerPt: ft / d });
    setCalPts(null);
    setCalInput('');
    setTool(project.outline ? 'select' : 'outline');
  }

  function deleteWall(id: string) {
    update({ walls: project.walls.filter((w) => w.id !== id) });
    setSelectedWallId((s) => (s === id ? null : s));
  }

  function toggleLock(id: string) {
    setProject((p) => ({ ...p, walls: p.walls.map((w) => (w.id === id ? { ...w, locked: !w.locked } : w)) }));
  }

  function runOptimize() {
    if (!frame) return;
    // Re-runs start from the original layout so changing an option gives a fresh result.
    const baseThickness = optimized?.previousThickness ?? project.settings.wallThickness;
    const current = new Map(project.walls.map((w) => [w.id, w]));
    const baseWalls = (optimized?.previous ?? project.walls).map((w) => ({ ...w, locked: current.get(w.id)?.locked ?? w.locked }));
    const base: Project = { ...project, walls: baseWalls, settings: { ...project.settings, wallThickness: baseThickness } };
    const model = toEngine(base, frame)!;
    const res = optimizeLayout(model.outline, model.walls, base.settings, {
      maxLength: limits.maxLength,
      minLength: limits.minLength,
      allowShortening: limits.allowShortening,
      allowRemoval: limits.allowRemoval,
      thickness: { min: limits.minThicknessIn / 12, max: Math.max(limits.minThicknessIn, limits.maxThicknessIn) / 12 },
      locked: new Set(baseWalls.filter((w) => w.locked).map((w) => w.id)),
    });
    setOptimized({ ...res, previous: baseWalls, previousThickness: baseThickness });
    const byId = new Map(res.walls.map((w) => [w.id, w]));
    setProject((p) => ({
      ...p,
      settings: { ...p.settings, wallThickness: res.thickness },
      walls: baseWalls
        .filter((w) => byId.has(w.id))
        .map((w) => ({ ...w, start: ftToPt(byId.get(w.id)!.start, frame), end: ftToPt(byId.get(w.id)!.end, frame) })),
    }));
  }

  /** Append walls that aren't already in the project (same ends within 6 in). */
  function mergeWalls(found: Omit<PlanWall, 'id'>[]): PlanWall[] {
    const tol = project.ftPerPt ? 0.5 / project.ftPerPt : 3;
    const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < tol;
    const same = (a: Omit<PlanWall, 'id'>, b: Omit<PlanWall, 'id'>) =>
      (near(a.start, b.start) && near(a.end, b.end)) || (near(a.start, b.end) && near(a.end, b.start));
    const walls = [...project.walls];
    for (const w of found) if (!walls.some((e) => same(e, w))) walls.push({ id: nextWallId(walls), ...w });
    return walls;
  }

  async function detectWalls() {
    if (!pdf || !project.ftPerPt) return;
    const ftPerPt = project.ftPerPt;
    setDetecting(true);
    try {
      const bars = await detectBars(pdf, project.pageNumber);
      const colors = (['black', 'red'] as const).filter((c) => wallColors[c]);
      const found = barsToWalls(bars, { ftPerPt, minThicknessFt: 0.25, maxThicknessFt: 3, minLengthFt: 3, colors });
      const walls = mergeWalls(found);
      update({ walls });
      setDetectMsg(
        found.length
          ? `Found ${found.length} wall segments (${colors.join(' + ')}), added ${walls.length - project.walls.length}. Review them and delete any that aren't shear walls.`
          : `No heavy ${colors.join(' or ')} wall linework found. Check the scale and colors, or draw walls by hand.`,
      );
    } finally {
      setDetecting(false);
    }
  }

  async function importBluebeam() {
    if (!pdf) return;
    setDetecting(true);
    try {
      const res = importMarkups(markups, await detectBars(pdf, project.pageNumber), project.ftPerPt, {
        redLines: redLineMarkups,
      });
      const walls = mergeWalls(res.walls);
      update({ walls, ...(res.outline ? { outline: res.outline, holes: res.holes } : {}) });
      if (res.outline) setTool('select');
      const ignored = Object.entries(res.ignored).map(([type, n]) => `${n} ${type}`);
      const by = res.authors.length ? ` (by ${res.authors.join(', ')})` : '';
      setDetectMsg(
        `Imported markups${by}: ${res.outline ? `floor outline (${res.outline.length} points), ${res.holes.length} voids` : 'no outline polygon'}, ` +
          `${walls.length - project.walls.length} walls from ${redLineMarkups ? 'rectangle and red line' : 'rectangle'} markups.` +
          (ignored.length ? ` Not used: ${ignored.join(', ')}.` : '') +
          (res.ignored['red Line'] || res.ignored['red PolyLine'] ? ' Tick "Red line markups" to import red lines as walls.' : ''),
      );
    } finally {
      setDetecting(false);
    }
  }

  function undoOptimize() {
    if (!optimized) return;
    setProject((p) => ({ ...p, walls: optimized.previous, settings: { ...p.settings, wallThickness: optimized.previousThickness } }));
    setOptimized(null);
  }

  function exportProject() {
    const blob = new Blob([JSON.stringify({ version: 1, pdf: fileName, project }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName.replace(/\.pdf$/i, '') || 'project'}.shearwalls.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importProject(file: File) {
    try {
      const data = JSON.parse(await file.text());
      const p = data.project as Project;
      setProject({
        ...emptyProject(),
        ...p,
        settings: { ...DEFAULT_SETTINGS, ...p.settings },
        wallDesign: { ...DEFAULT_WALL_DESIGN, ...p.wallDesign },
      });
      setOptimized(null);
      setSelectedWallId(null);
    } catch {
      setLoadError(`${file.name} is not a valid project file`);
    }
  }

  const frame = pageSize && project.ftPerPt ? { pageHeight: pageSize.height, ftPerPt: project.ftPerPt } : null;

  const { analysis, messages, cm } = useMemo(() => {
    const msgs: string[] = [];
    if (!pdf) return { analysis: null, messages: ['Upload an architectural plan PDF to start.'], cm: null };
    if (!frame) msgs.push('Set the drawing scale (step 2).');
    if (!project.outline) msgs.push('Trace the floor outline (step 3).');
    if (!frame || !project.outline) return { analysis: null, messages: msgs, cm: null };

    const model = toEngine(project, frame)!;
    let cmFt: Point | null = null;
    try {
      cmFt = centerOfMass(model.outline);
    } catch (e) {
      return { analysis: null, messages: [(e as Error).message], cm: null };
    }
    msgs.push(...checkLayout(model.walls, project.settings));
    let result: LevelAnalysis | null = null;
    try {
      result = analyzeLevel(model.outline, model.walls, project.settings);
    } catch (e) {
      if (!msgs.length) msgs.push((e as Error).message);
    }
    return { analysis: result, messages: msgs, cm: cmFt };
  }, [pdf, frame?.pageHeight, frame?.ftPerPt, project]);

  /** Story forces from the base shear, and per-wall design inputs for the SkyCiv wall check. */
  const design = useMemo(() => {
    if (!analysis) return null;
    const s = project.settings;
    const { baseShear, k } = project.wallDesign;
    const stories = storyForces(baseShear, s.stories, s.storyHeight, k);
    const rows: WallCheckRow[] = analysis.elements.map((el, i) => {
      // In-plane demand: the larger of the X- and Y-load cases (torsion loads perpendicular walls in-plane too).
      const shareOfV = Math.max(analysis.loads.X.walls[i].governing, analysis.loads.Y.walls[i].governing);
      const d = { id: el.wall.id, lengthFt: el.length, thicknessFt: el.wall.t, heightFt: wallHeight(s), shareOfV };
      const loads = wallLoads(d, stories[0]);
      return { id: d.id, loads, input: wallCalcInput(d, loads, project.wallDesign, d.id), warning: heightWarning(d) };
    });
    return { stories, rows };
  }, [analysis, project]);

  async function runChecks() {
    if (!credentials || !design) return;
    checkAbort.current?.abort();
    const abort = new AbortController();
    checkAbort.current = abort;
    const rows = design.rows;
    setChecks({});
    setCheckRun({ done: 0, total: rows.length });
    let next = 0;
    let done = 0;
    // A few requests in parallel; each wall is one Quick Design run.
    const worker = async () => {
      while (next < rows.length && !abort.signal.aborted) {
        const row = rows[next++];
        const result = await runWallCheck(credentials, row.input, abort.signal);
        if (abort.signal.aborted) return;
        setChecks((c) => ({ ...c, [row.id]: { input: row.input, result } }));
        setCheckRun({ done: ++done, total: rows.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    if (!abort.signal.aborted) setCheckRun(null);
  }

  function cancelChecks() {
    checkAbort.current?.abort();
    setCheckRun(null);
  }

  const markers = frame
    ? { cm: cm ? ftToPt(cm, frame) : undefined, cr: analysis ? ftToPt(analysis.cr, frame) : undefined }
    : {};

  const s = project.settings;

  return (
    <div className="app">
      <header>
        <h1>
          Shear Wall Optimizer <span>COM / COR · rigid diaphragm · concrete walls</span>
        </h1>
        <div className="header-actions">
          <button onClick={() => setShowSettings(true)} title="SkyCiv API credentials">
            {credentials ? `SkyCiv: ${credentials.username}` : 'SkyCiv API settings'}
          </button>
        </div>
        {pdf && (
          <div className="zoom">
            <button onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z / 1.25))}>−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * 1.25))}>+</button>
            <button onClick={() => fit()}>Fit</button>
          </div>
        )}
      </header>

      <aside className="sidebar">
        <section>
          <h2>1. Plan</h2>
          <label className="button primary">
            {pdf ? 'Replace PDF' : 'Upload PDF'}
            <input type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && openPdf(e.target.files[0])} />
          </label>
          {fileName && <p className="file">{fileName}</p>}
          {pdf && pdf.numPages > 1 && (
            <label className="field">
              Page
              <select
                value={project.pageNumber}
                onChange={(e) => {
                  fitPending.current = true;
                  update({ pageNumber: Number(e.target.value) });
                }}
              >
                {Array.from({ length: pdf.numPages }, (_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
          {loadError && <p className="error">{loadError}</p>}
        </section>

        <section className={pdf ? '' : 'disabled'}>
          <h2>2. Scale {project.ftPerPt && <span className="ok">✓</span>}</h2>
          {project.ftPerPt && (
            <p className="status">1" on sheet = {formatFtIn(project.ftPerPt * 72)}</p>
          )}
          <button className={tool === 'calibrate' ? 'active' : ''} onClick={() => setTool('calibrate')}>
            Measure known dimension
          </button>
          {calPts && (
            <div className="cal-input">
              <input
                autoFocus
                placeholder={`e.g. 15'-0"`}
                value={calInput}
                onChange={(e) => setCalInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyCalibration()}
              />
              <button className="primary" disabled={!parseFeet(calInput)} onClick={applyCalibration}>
                Apply
              </button>
            </div>
          )}
          <label className="field">
            or sheet scale
            <select
              value=""
              onChange={(e) => e.target.value && update({ ftPerPt: ftPerPtFromScale(Number(e.target.value)) })}
            >
              <option value="">Choose…</option>
              {SCALE_PRESETS.map((p) => (
                <option key={p.label} value={p.inPerFt}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">Sheet scales are only right if the PDF is at full print size. Check with a known dimension.</p>
        </section>

        <section className={pdf ? '' : 'disabled'}>
          <h2>3. Geometry</h2>
          <div className="tools">
            {(
              [
                ['select', 'Select'],
                ['outline', project.outline ? 'Redraw outline' : 'Floor outline'],
                ['hole', 'Add void'],
                ['wall', 'Add wall'],
              ] as [Tool, string][]
            ).map(([t, label]) => (
              <button key={t} className={tool === t ? 'active' : ''} onClick={() => setTool(t)}>
                {label}
              </button>
            ))}
          </div>
          <p className="hint">{TOOL_HELP[tool]}</p>
          <div className="check-row">
            <span>Shear wall colors:</span>
            {(['black', 'red'] as const).map((c) => (
              <label key={c} className="check">
                <input
                  type="checkbox"
                  checked={wallColors[c]}
                  onChange={(e) => setWallColors({ ...wallColors, [c]: e.target.checked })}
                />
                <span className={`swatch swatch-${c}`} />
                {c === 'black' ? 'Black' : 'Red'}
              </label>
            ))}
          </div>
          {redLineCount > 0 && (
            <label className="check">
              <input type="checkbox" checked={redLineMarkups} onChange={(e) => setRedLineMarkups(e.target.checked)} />
              Red line markups as walls ({redLineCount})
            </label>
          )}
          {markups.length > 0 && (
            <button disabled={detecting} onClick={importBluebeam}>
              Import Bluebeam markups ({markups.length})
            </button>
          )}
          <button disabled={!project.ftPerPt || detecting || (!wallColors.black && !wallColors.red)} onClick={detectWalls}>
            {detecting ? 'Detecting…' : 'Detect walls from PDF'}
          </button>
          <p className="hint">
            {detectMsg ||
              (markups.length
                ? 'This page has PDF markups. Import uses the polygon as the floor outline (inner polygons as voids) and thin rectangles as shear walls.'
                : 'Finds the heaviest black and/or red wall linework (highlighted shear walls / lateral frames); each color is judged by its own line weight. T and L shapes become separate straight walls.')}
          </p>
          <p className="status">
            Outline {project.outline ? '✓' : '—'} · {project.holes.length} voids · {project.walls.length} walls
          </p>
          <div className="tools">
            <button disabled={!project.holes.length} onClick={() => update({ holes: [] })}>
              Clear voids
            </button>
            <button
              disabled={!project.walls.length}
              onClick={() => {
                update({ walls: [] });
                setSelectedWallId(null);
              }}
            >
              Clear walls
            </button>
          </div>
        </section>

        <section>
          <h2>4. Building</h2>
          <div className="grid2">
            <label className="field">
              Stories
              <input type="number" min={1} value={s.stories} onChange={(e) => updateSettings({ stories: Math.max(1, Number(e.target.value)) })} />
            </label>
            <label className="field">
              Story height (ft)
              <input type="number" min={1} step={0.5} value={s.storyHeight} onChange={(e) => updateSettings({ storyHeight: Math.max(1, Number(e.target.value)) })} />
            </label>
            <label className="field">
              Wall thickness (in)
              <input
                type="number"
                min={4}
                step={1}
                value={Math.round(s.wallThickness * 12)}
                onChange={(e) => updateSettings({ wallThickness: Math.max(4, Number(e.target.value)) / 12 })}
              />
            </label>
            <label className="field">
              Min walls / dir
              <input type="number" min={1} value={s.minWallsPerDirection} onChange={(e) => updateSettings({ minWallsPerDirection: Math.max(1, Number(e.target.value)) })} />
            </label>
          </div>
          <label className="field">
            Wall boundary condition
            <select value={s.fixity} onChange={(e) => updateSettings({ fixity: e.target.value as BuildingSettings['fixity'] })}>
              <option value="cantilever">Cantilever (Fig 8.12)</option>
              <option value="fixed">Fixed–fixed (Fig 8.14)</option>
            </select>
          </label>
          <p className="hint">
            Walls are continuous over all levels: H = {formatFtIn(wallHeight(s))}. Uniform floor mass, so the COM is the slab
            centroid.
          </p>
        </section>

        <section className={pdf ? '' : 'disabled'}>
          <h2>5. Optimize</h2>
          <div className="grid2">
            <label className="field">
              Max wall length (ft)
              <input
                type="number"
                min={1}
                value={limits.maxLength}
                onChange={(e) => setLimits({ ...limits, maxLength: Math.max(1, Number(e.target.value)) })}
              />
            </label>
            <label className={`field ${limits.allowShortening ? '' : 'muted'}`}>
              Min wall length (ft)
              <input
                type="number"
                min={1}
                value={limits.minLength}
                disabled={!limits.allowShortening}
                onChange={(e) => setLimits({ ...limits, minLength: Math.max(1, Number(e.target.value)) })}
              />
            </label>
          </div>
          <div className="grid2">
            <label className="field">
              Min thickness (in)
              <input
                type="number"
                min={4}
                value={limits.minThicknessIn}
                onChange={(e) => setLimits({ ...limits, minThicknessIn: Math.max(4, Number(e.target.value)) })}
              />
            </label>
            <label className="field">
              Max thickness (in)
              <input
                type="number"
                min={4}
                value={limits.maxThicknessIn}
                onChange={(e) => setLimits({ ...limits, maxThicknessIn: Math.max(4, Number(e.target.value)) })}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={limits.allowShortening}
              onChange={(e) => setLimits({ ...limits, allowShortening: e.target.checked })}
            />
            Allow shortening walls
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={limits.allowRemoval}
              onChange={(e) => setLimits({ ...limits, allowRemoval: e.target.checked })}
            />
            Allow removing walls
          </label>
          <button className="primary" disabled={!analysis} onClick={runOptimize}>
            Optimize walls
          </button>
          <p className="hint">
            Walls stay at their locations. Lengths change first: ends connected to another wall (T/L junctions) stay put and
            the free end grows; free walls grow about their center, up to the slab edge, voids and the max length. Walls are
            only removed if that can't get e/L below 0.5%, fewest first, keeping {s.minWallsPerDirection} per direction. All
            walls share one thickness. It can't move the CR, so the optimizer uses the thinnest one in range that keeps total
            stiffness in each direction at least at the original. Locked walls are never changed or removed.
          </p>
          {optimized && (
            <div className="opt-summary">
              <div>
                e<sub>x</sub>/L<sub>x</sub> {pct(optimized.before.x)} → <strong>{pct(optimized.after.x)}</strong>
              </div>
              <div>
                e<sub>y</sub>/L<sub>y</sub> {pct(optimized.before.y)} → <strong>{pct(optimized.after.y)}</strong>
              </div>
              <div className="hint">
                {lengthSummary(optimized.lengths)}{' '}
                {optimized.removed.length ? `Removed ${optimized.removed.join(', ')} (red dashes). ` : ''}
                Dashed lines show the original walls.
              </div>
              <div>
                Thickness {Math.round(optimized.previousThickness * 12)} in → <strong>{Math.round(optimized.thickness * 12)} in</strong>{' '}
                (all walls)
              </div>
              <div className="hint">
                Stiffness vs original: X {pct(optimized.stiffness.x)}, Y {pct(optimized.stiffness.y)}.
                {optimized.stiffnessShort && ' Max thickness is not enough to restore the original stiffness.'}
              </div>
              {Math.max(Math.abs(optimized.after.x), Math.abs(optimized.after.y)) > 0.005 && (
                <div className="hint">
                  This is the best reachable balance: the walls that would help are locked, at the max length, or blocked by
                  the slab edge or a void. Raise the max length, allow shortening or removal, or add a wall on the light side.
                </div>
              )}
              <button onClick={undoOptimize}>Undo optimization</button>
            </div>
          )}
        </section>

        <section className={pdf ? '' : 'disabled'}>
          <h2>6. Wall design check</h2>
          <p className="hint">
            ACI 318-19 in-plane wall check with SkyCiv Quick Design ({`3003-aci-concrete-wall-calculator`}), one run per wall.
          </p>
          <div className="grid2">
            <label className="field">
              Base shear V (kips)
              <input
                type="number"
                min={0}
                value={project.wallDesign.baseShear || ''}
                placeholder="Required"
                onChange={(e) => updateDesign({ baseShear: Math.max(0, Number(e.target.value)) })}
              />
            </label>
            <label className="field">
              Exponent k
              <input
                type="number"
                min={1}
                max={2}
                step={0.05}
                value={project.wallDesign.k}
                onChange={(e) => updateDesign({ k: Math.min(2, Math.max(1, Number(e.target.value))) })}
              />
            </label>
            <label className="field">
              f'c (psi)
              <input type="number" min={2500} step={500} value={project.wallDesign.fcPsi} onChange={(e) => updateDesign({ fcPsi: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>
                f<sub>y</sub> (ksi)
              </span>
              <input type="number" min={40} step={5} value={project.wallDesign.fyKsi} onChange={(e) => updateDesign({ fyKsi: Number(e.target.value) })} />
            </label>
            <label className="field wide">
              Vertical bars
              <span className="bar-input">
                <select value={project.wallDesign.vertBar} onChange={(e) => updateDesign({ vertBar: Number(e.target.value) })}>
                  {[3, 4, 5, 6, 7, 8, 9].map((n) => (
                    <option key={n} value={n}>
                      #{n}
                    </option>
                  ))}
                </select>
                @
                <input type="number" min={3} value={project.wallDesign.vertSpacingIn} onChange={(e) => updateDesign({ vertSpacingIn: Math.max(3, Number(e.target.value)) })} />
                in
              </span>
            </label>
            <label className="field wide">
              Horizontal bars
              <span className="bar-input">
                <select value={project.wallDesign.horizBar} onChange={(e) => updateDesign({ horizBar: Number(e.target.value) })}>
                  {[3, 4, 5, 6, 7, 8, 9].map((n) => (
                    <option key={n} value={n}>
                      #{n}
                    </option>
                  ))}
                </select>
                @
                <input type="number" min={3} value={project.wallDesign.horizSpacingIn} onChange={(e) => updateDesign({ horizSpacingIn: Math.max(3, Number(e.target.value)) })} />
                in
              </span>
            </label>
            <label className="field">
              Cover (in)
              <input type="number" min={0.75} step={0.25} value={project.wallDesign.coverIn} onChange={(e) => updateDesign({ coverIn: Number(e.target.value) })} />
            </label>
            <label className="field">
              Units sent to SkyCiv
              <select value={project.wallDesign.units} onChange={(e) => updateDesign({ units: e.target.value as UnitSystem })}>
                <option value="imperial">Imperial (in, kip, ksi)</option>
                <option value="metric">Metric (mm, kN, MPa)</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={project.wallDesign.shearOnly}
              onChange={(e) => updateDesign({ shearOnly: e.target.checked })}
            />
            Shear only (ignore bending checks)
          </label>
          <p className="hint">
            When ticked, each wall passes or fails on its shear ratio alone. Bending, axial and detailing results are still
            in the SkyCiv report (M<sub>u</sub> is still sent) but don't affect the result here. Toggling doesn't need a
            re-run.
          </p>
          <p className="hint">
            ASCE 7 §12.8.3: k = 1 for T ≤ 0.5 s, 2 for T ≥ 2.5 s, linear between.
          </p>
          {design && project.wallDesign.baseShear > 0 && (
            <table className="story-forces">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>h (ft)</th>
                  <th>
                    F<sub>x</sub> (k)
                  </th>
                  <th>
                    V<sub>x</sub> (k)
                  </th>
                  <th>
                    M<sub>x</sub> (k-ft)
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...design.stories].reverse().map((st) => (
                  <tr key={st.level}>
                    <td>{st.level === s.stories ? 'Roof' : st.level + 1}</td>
                    <td>{st.height.toFixed(0)}</td>
                    <td>{st.F.toFixed(1)}</td>
                    <td>{st.V.toFixed(1)}</td>
                    <td>{st.M.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {checkRun ? (
            <button onClick={cancelChecks}>
              Cancel ({checkRun.done}/{checkRun.total})
            </button>
          ) : (
            <button
              className="primary"
              disabled={!design || !credentials || !design.rows.length || !(project.wallDesign.baseShear > 0)}
              onClick={runChecks}
            >
              Run wall check{design ? ` (${design.rows.length} walls)` : ''}
            </button>
          )}
          {!(project.wallDesign.baseShear > 0) && <p className="hint">Enter the base shear to run the check.</p>}
          {!credentials && (
            <p className="hint">
              <button className="link" onClick={() => setShowSettings(true)}>
                Add your SkyCiv API credentials
              </button>{' '}
              to run the check.
            </p>
          )}
          <p className="hint">
            Enter V at strength level (factored, including ρ). It is distributed to the levels by F<sub>x</sub> = C
            <sub>vx</sub>V with equal floor weights, giving story shear V<sub>x</sub> and overturning M<sub>x</sub>. Every
            level has the same walls, so each wall takes its governing share (incl. accidental torsion) of the base V and
            M: V<sub>u</sub> = share·V, M<sub>u</sub> = share·M<sub>base</sub>, with P<sub>u</sub> = 0.9 × self-weight.
            The check is at the base, where V and M are largest for a uniform wall. The calculator covers ACI 318-19 Ch. 11
            only: no special structural wall (Ch. 18) or boundary element checks. Walls taller than 25 m are entered as
            25 m, which doesn't change α<sub>c</sub> when h/L ≥ 2.
          </p>
        </section>

        <section>
          <h2>Project</h2>
          <div className="tools">
            <button disabled={!pdf} onClick={exportProject}>
              Save JSON
            </button>
            <label className={`button ${pdf ? '' : 'disabled'}`}>
              Load JSON
              <input type="file" accept="application/json" hidden disabled={!pdf} onChange={(e) => e.target.files?.[0] && importProject(e.target.files[0])} />
            </label>
          </div>
          <p className="hint">Saves the scale, outline and walls. Re-upload the same PDF before loading.</p>
        </section>
      </aside>

      <main
        ref={viewerRef}
        className={`viewer ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f?.type === 'application/pdf') openPdf(f);
        }}
      >
        {pdf ? (
          <PlanView
            pdf={pdf}
            pageNumber={project.pageNumber}
            zoom={zoom}
            tool={tool}
            project={project}
            selectedWallId={selectedWallId}
            calibrationPts={calPts}
            markers={markers}
            ghostWalls={optimized?.previous}
            onPageSize={handlePageSize}
            onCalibrate={(a, b) => {
              setCalPts([a, b]);
              setCalInput('');
            }}
            onPolygon={(kind, pts) => {
              if (kind === 'outline') {
                update({ outline: pts });
                setTool('wall');
              } else update({ holes: [...project.holes, pts] });
            }}
            onWall={(a, b) => update({ walls: [...project.walls, { id: nextWallId(project.walls), start: a, end: b }] })}
            onSelectWall={setSelectedWallId}
            onDeleteSelected={() => selectedWallId && deleteWall(selectedWallId)}
          />
        ) : (
          <label className="dropzone">
            <strong>Drop an architectural plan PDF here</strong>
            <span>or click to browse</span>
            <input type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && openPdf(e.target.files[0])} />
          </label>
        )}
      </main>

      <Results
        analysis={analysis}
        messages={messages}
        selectedWallId={selectedWallId}
        lockedIds={new Set(project.walls.filter((w) => w.locked).map((w) => w.id))}
        lengthChanges={optimized?.lengths}
        onToggleLock={toggleLock}
        onSelectWall={(id) => {
          setSelectedWallId(id);
          setTool('select');
        }}
        onDeleteWall={deleteWall}
      >
        {design && (
          <WallChecks
            rows={design.rows}
            checks={checks}
            running={checkRun}
            selectedWallId={selectedWallId}
            shearOnly={project.wallDesign.shearOnly}
            onSelectWall={(id) => {
              setSelectedWallId(id);
              setTool('select');
            }}
          />
        )}
      </Results>

      {showSettings && (
        <SettingsDialog credentials={credentials} onSave={setCredentials} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
