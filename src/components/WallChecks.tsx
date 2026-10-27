import { evaluateCheck, quickDesignUrl, type WallCalcInput, type WallCheckResult, type WallLoads } from '../skyciv';

export interface WallCheckRow {
  id: string;
  loads: WallLoads;
  input: WallCalcInput;
  warning: string | null;
}

export interface CheckRecord {
  input: WallCalcInput;
  result: WallCheckResult;
}

interface Props {
  rows: WallCheckRow[];
  checks: Record<string, CheckRecord>;
  running: { done: number; total: number } | null;
  selectedWallId: string | null;
  /** Judge walls on shear alone (bending etc. reported but ignored). */
  shearOnly: boolean;
  onSelectWall: (id: string) => void;
}

const sameInput = (a: WallCalcInput, b: WallCalcInput) => JSON.stringify(a) === JSON.stringify(b);

export function WallChecks({ rows, checks, running, selectedWallId, shearOnly, onSelectWall }: Props) {
  const done = rows.filter((r) => checks[r.id]);
  if (!done.length && !running) return null;
  const stale = done.some((r) => !sameInput(checks[r.id].input, r.input));
  const failed = done.filter((r) => checks[r.id].result.ok && !evaluateCheck(checks[r.id].result, shearOnly).pass).length;

  return (
    <>
      <h3>ACI 318-19 wall check (SkyCiv){shearOnly && ' · shear only'}</h3>
      <p className="hint">
        {running
          ? `Running ${running.done}/${running.total}…`
          : `${done.length - failed}/${done.length} walls pass${failed ? `, ${failed} fail` : ''}.`}{' '}
        PDF report links expire about an hour after the run; the Quick Design link always reopens the inputs.
        {shearOnly && ' Pass/fail is on shear only; bending and other checks are in the report but ignored here.'}
        {stale && ' Some results are out of date (the layout or inputs changed). Run the check again.'}
      </p>
      <table className="walls checks">
        <thead>
          <tr>
            <th>Wall</th>
            <th>
              V<sub>u</sub> (k)
            </th>
            <th>
              M<sub>u</sub> (k-ft)
            </th>
            <th>Ratio</th>
            <th>Result</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rec = checks[r.id];
            const res = rec?.result;
            const isStale = rec && !sameInput(rec.input, r.input);
            const verdict = res?.ok ? evaluateCheck(res, shearOnly) : null;
            const ignored = new Set(verdict?.ignored ?? []);
            return (
              <tr
                key={r.id}
                className={`${r.id === selectedWallId ? 'selected' : ''} ${isStale ? 'stale' : ''}`}
                onClick={() => onSelectWall(r.id)}
                title={r.warning ?? res?.error ?? res?.checks.map((c) => `${c.label}: ${c.ratio === null ? (c.pass ? 'OK' : 'NG') : c.ratio.toFixed(2)}${ignored.has(c) ? ' (ignored)' : ''}`).join('\n')}
              >
                <td>{r.id}</td>
                <td>{r.loads.Vu.toFixed(1)}</td>
                <td>{r.loads.Mu.toFixed(0)}</td>
                <td className="ratio">
                  {verdict?.governing ? (
                    <>
                      {verdict.governing.ratio!.toFixed(2)}
                      <small>{verdict.governing.label}</small>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {!res ? (
                    <span className="badge">…</span>
                  ) : !res.ok ? (
                    <span className="badge bad">Error</span>
                  ) : (
                    <span className={`badge ${verdict!.pass ? 'good' : 'bad'}`}>{verdict!.pass ? 'PASS' : 'FAIL'}</span>
                  )}
                </td>
                <td className="links" onClick={(e) => e.stopPropagation()}>
                  {res?.reportUrl && (
                    <a href={res.reportUrl} target="_blank" rel="noreferrer">
                      PDF ↗
                    </a>
                  )}
                  <a href={quickDesignUrl((rec ?? r).input)} target="_blank" rel="noreferrer">
                    Open ↗
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {done.some((r) => checks[r.id].result.error) && (
        <ul className="messages">
          {done
            .filter((r) => checks[r.id].result.error)
            .map((r) => (
              <li key={r.id}>
                {r.id}: {checks[r.id].result.error}
              </li>
            ))}
        </ul>
      )}
    </>
  );
}
