import type { LevelAnalysis } from '../engine';
import { formatFtIn, HALF_INCH, pct } from '../project';

interface Props {
  analysis: LevelAnalysis | null;
  /** Why there is no analysis yet, or what is wrong with the layout. */
  messages: string[];
  selectedWallId: string | null;
  lockedIds: Set<string>;
  /** Original → optimized lengths, ft. */
  lengthChanges?: Record<string, { from: number; to: number }>;
  onToggleLock: (id: string) => void;
  onSelectWall: (id: string) => void;
  onDeleteWall: (id: string) => void;
  /** Extra result sections (e.g. design checks), shown below the walls table. */
  children?: React.ReactNode;
}

function eccClass(ratio: number) {
  const r = Math.abs(ratio);
  if (r <= 0.01) return 'good';
  if (r <= 0.05) return 'warn';
  return 'bad';
}

export function Results({
  analysis,
  messages,
  selectedWallId,
  lockedIds,
  lengthChanges,
  onToggleLock,
  onSelectWall,
  onDeleteWall,
  children,
}: Props) {
  return (
    <aside className="results">
      <h2>Results</h2>
      {messages.length > 0 && (
        <ul className="messages">
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      {analysis && (
        <>
          <div className="ecc-cards">
            {(['x', 'y'] as const).map((k) => (
              <div key={k} className={`ecc-card ${eccClass(analysis.eRatio[k])}`}>
                <span className="label">e<sub>{k}</sub> / L<sub>{k}</sub></span>
                <span className="value">{pct(analysis.eRatio[k])}</span>
                <span className="sub">
                  e<sub>{k}</sub> = {formatFtIn(analysis.e[k])} · L<sub>{k}</sub> = {formatFtIn(k === 'x' ? analysis.Lx : analysis.Ly)}
                </span>
              </div>
            ))}
          </div>
          <p className="hint">Green ≤ 1%, amber ≤ 5% (the size of the code's accidental eccentricity), red &gt; 5%.</p>

          <table className="kv">
            <tbody>
              <tr>
                <th>Center of mass</th>
                <td>
                  {analysis.cm.x.toFixed(2)}, {analysis.cm.y.toFixed(2)} ft
                </td>
              </tr>
              <tr>
                <th>Center of rigidity</th>
                <td>
                  {analysis.cr.x.toFixed(2)}, {analysis.cr.y.toFixed(2)} ft
                </td>
              </tr>
            </tbody>
          </table>

          <h3>Walls</h3>
          <p className="hint">
            Governing shear as % of story shear V, enveloping ±5% accidental torsion (ASCE 7 §12.8.4.2).
          </p>
          <table className="walls">
            <thead>
              <tr>
                <th>Wall</th>
                <th>Dir</th>
                <th>Length</th>
                <th title="Share of rigidity in its own direction">R share</th>
                <th>V<sub>x</sub> load</th>
                <th>V<sub>y</sub> load</th>
                <th title="Locked walls are not moved by the optimizer">Lock</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {analysis.elements.map((el, i) => {
                const sum = el.direction === 'X' ? analysis.sumRx : analysis.sumRy;
                const change = lengthChanges?.[el.wall.id];
                const changed = change && Math.abs(change.to - change.from) >= HALF_INCH;
                return (
                  <tr
                    key={el.wall.id}
                    className={el.wall.id === selectedWallId ? 'selected' : ''}
                    onClick={() => onSelectWall(el.wall.id)}
                  >
                    <td>{el.wall.id}</td>
                    <td className={`dir dir-${el.direction.toLowerCase()}`}>{el.direction}</td>
                    <td className={changed ? 'changed' : ''} title={changed ? `was ${formatFtIn(change.from)}` : undefined}>
                      {formatFtIn(el.length)}
                      {changed && <span className="delta"> ({change.to > change.from ? '+' : ''}{formatFtIn(change.to - change.from)})</span>}
                    </td>
                    <td>{pct(el.R / sum)}</td>
                    <td>{pct(analysis.loads.X.walls[i].governing)}</td>
                    <td>{pct(analysis.loads.Y.walls[i].governing)}</td>
                    <td className="lock">
                      <input
                        type="checkbox"
                        checked={lockedIds.has(el.wall.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => onToggleLock(el.wall.id)}
                      />
                    </td>
                    <td>
                      <button
                        className="icon"
                        title="Delete wall"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteWall(el.wall.id);
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {children}
        </>
      )}
    </aside>
  );
}
