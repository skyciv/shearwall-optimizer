import { useState } from 'react';
import type { Credentials } from '../skyciv';

const STORAGE_KEY = 'skyciv-credentials';

/** Saved credentials, if the user chose to remember them on this device. */
export function loadCredentials(): Credentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
}

function saveCredentials(creds: Credentials | null) {
  try {
    if (creds) localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private window): keep them for this session only.
  }
}

interface Props {
  credentials: Credentials | null;
  onSave: (creds: Credentials | null) => void;
  onClose: () => void;
}

export function SettingsDialog({ credentials, onSave, onClose }: Props) {
  const [username, setUsername] = useState(credentials?.username ?? '');
  const [key, setKey] = useState(credentials?.key ?? '');
  const [remember, setRemember] = useState(loadCredentials() !== null);
  const valid = username.trim() !== '' && key.trim() !== '';

  function save() {
    const creds = valid ? { username: username.trim(), key: key.trim() } : null;
    saveCredentials(remember ? creds : null);
    onSave(creds);
    onClose();
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-label="SkyCiv API settings" onMouseDown={(e) => e.stopPropagation()}>
        <h2>SkyCiv API</h2>
        <p className="hint">
          Used to run the ACI 318-19 shear wall check in SkyCiv Quick Design (0.01 API credits per wall). Get your API key at{' '}
          <a href="https://platform.skyciv.com/api" target="_blank" rel="noreferrer">
            platform.skyciv.com/api
          </a>
          .
        </p>
        <label className="field">
          SkyCiv username (email)
          <input type="email" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          API key
          <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember on this device
        </label>
        <p className="hint">
          Credentials are sent only to SkyCiv and are never included in saved project files. Without "remember" they are kept
          until you close this tab.
        </p>
        <div className="tools end">
          {credentials && (
            <button
              onClick={() => {
                saveCredentials(null);
                onSave(null);
                onClose();
              }}
            >
              Sign out
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
