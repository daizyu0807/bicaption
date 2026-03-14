import { startTransition, useEffect, useState } from 'react';
import type { AppSettings, SidecarEvent } from '../electron/types.js';
import { applySettingsOverlayStyle, initialViewState, reduceSidecarEvent } from './caption-state.js';

function isOverlayRoute() {
  return window.location.hash === '#overlay';
}

function OverlayView({
  viewState,
  settings,
}: {
  viewState: ReturnType<typeof useCaptionState>;
  settings: AppSettings;
}) {
  const overlayStyle = applySettingsOverlayStyle(settings);

  return (
    <main className="overlay-shell" style={overlayStyle}>
      <section className="overlay-stack">
        {viewState.captions.map((caption) => (
          <article key={caption.segmentId} className="caption-card">
            <p className="caption-source">{caption.sourceText}</p>
            {caption.translatedText ? <p className="caption-translation">{caption.translatedText}</p> : null}
          </article>
        ))}
        {viewState.partial ? (
          <article className="caption-card partial">
            <p className="caption-source">{viewState.partial.sourceText}</p>
          </article>
        ) : null}
      </section>
    </main>
  );
}

function useCaptionState() {
  const [viewState, setViewState] = useState(initialViewState);

  useEffect(() => {
    return window.app.subscribe('sidecar:event', (payload) => {
      const event = payload as SidecarEvent;
      startTransition(() => {
        setViewState((current) => reduceSidecarEvent(current, event));
      });
    });
  }, []);

  return viewState;
}

function SettingsView({
  settings,
  devices,
  viewState,
  onSave,
}: {
  settings: AppSettings;
  devices: Array<{ id: string; label: string }>;
  viewState: ReturnType<typeof useCaptionState>;
  onSave: (partial: Partial<AppSettings>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  return (
    <main className="settings-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">Realtime Bilingual Subtitles</p>
          <h1>BlackHole 即時雙字幕</h1>
          <p className="muted">桌面 overlay + Python sidecar。原文即時、譯文收斂。</p>
        </div>
        <div className={`status-pill status-${viewState.sessionState}`}>{viewState.sessionState}</div>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Session</h2>
          <label>
            Input device
            <select value={draft.deviceId} onChange={(event) => setDraft({ ...draft, deviceId: event.target.value })}>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source language
            <input value={draft.sourceLang} onChange={(event) => setDraft({ ...draft, sourceLang: event.target.value })} />
          </label>
          <label>
            Target language
            <input value={draft.targetLang} onChange={(event) => setDraft({ ...draft, targetLang: event.target.value })} />
          </label>
          <label>
            STT model
            <input value={draft.sttModel} onChange={(event) => setDraft({ ...draft, sttModel: event.target.value })} />
          </label>
          <label>
            Chunk ms
            <input
              type="number"
              min="400"
              max="5000"
              value={draft.chunkMs}
              onChange={(event) => setDraft({ ...draft, chunkMs: Number(event.target.value) })}
            />
          </label>
          <div className="button-row">
            <button onClick={() => onSave(draft)}>Save settings</button>
            <button
              className="secondary"
              onClick={async () => {
                await onSave(draft);
                await window.app.startSession(draft);
              }}
            >
              Start
            </button>
            <button className="secondary" onClick={() => window.app.stopSession()}>
              Stop
            </button>
          </div>
        </article>

        <article className="panel">
          <h2>Overlay</h2>
          <label>
            Opacity
            <input
              type="range"
              min="0.3"
              max="1"
              step="0.05"
              value={draft.overlayOpacity}
              onChange={(event) => setDraft({ ...draft, overlayOpacity: Number(event.target.value) })}
            />
          </label>
          <label>
            Font scale
            <input
              type="range"
              min="0.8"
              max="1.8"
              step="0.1"
              value={draft.overlayFontScale}
              onChange={(event) => setDraft({ ...draft, overlayFontScale: Number(event.target.value) })}
            />
          </label>
          <label>
            Position
            <select
              value={draft.overlayPosition}
              onChange={(event) =>
                setDraft({ ...draft, overlayPosition: event.target.value as AppSettings['overlayPosition'] })
              }
            >
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
          </label>
        </article>

        <article className="panel">
          <h2>Metrics</h2>
          <div className="metric-list">
            <div>
              <span>Input level</span>
              <strong>{viewState.metrics.inputLevel.toFixed(2)}</strong>
            </div>
            <div>
              <span>Lag ms</span>
              <strong>{Math.round(viewState.metrics.processingLagMs)}</strong>
            </div>
            <div>
              <span>Queue depth</span>
              <strong>{viewState.metrics.queueDepth}</strong>
            </div>
          </div>
          {viewState.lastError ? <p className="error-text">{viewState.lastError}</p> : <p className="muted">No errors.</p>}
        </article>
      </section>
    </main>
  );
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [devices, setDevices] = useState<Array<{ id: string; label: string }>>([]);
  const captionState = useCaptionState();

  useEffect(() => {
    window.app.loadSettings().then(setSettings);
    window.app.listDevices().then(setDevices);
    return window.app.subscribe('settings:changed', (payload) => {
      setSettings(payload as AppSettings);
    });
  }, []);

  async function onSave(partial: Partial<AppSettings>) {
    const next = await window.app.saveSettings(partial);
    setSettings(next);
  }

  if (!settings) {
    return <main className="settings-shell loading">Loading…</main>;
  }

  if (isOverlayRoute()) {
  return <OverlayView viewState={captionState} settings={settings} />;
  }

  return <SettingsView settings={settings} devices={devices} viewState={captionState} onSave={onSave} />;
}
