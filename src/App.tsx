import { startTransition, useEffect, useRef, useState } from 'react';
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
  const hasVisibleCaptions = viewState.captions.length > 0 || Boolean(viewState.partial);
  const shouldShowShell = hasVisibleCaptions || viewState.sessionState === 'streaming' || viewState.sessionState === 'connecting';
  const translationEnabled = settings.targetLang !== settings.sourceLang && settings.translateModel !== 'disabled';
  const stackRef = useRef<HTMLElement | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    if (!stackRef.current) {
      return;
    }
    stackRef.current.scrollTop = stackRef.current.scrollHeight;
  }, [viewState.captions, viewState.partial]);

  if (!shouldShowShell) {
    return <main className="overlay-window overlay-hidden" />;
  }

  async function closeOverlayAndFocusSettings() {
    await window.app.hideOverlay();
    await window.app.showSettings();
  }

  return (
    <main className="overlay-window" style={overlayStyle}>
      <header className="overlay-titlebar">
        <div className="overlay-window-controls no-drag">
          <button className="traffic-light traffic-close" onClick={closeOverlayAndFocusSettings} aria-label="Hide overlay">
            <span aria-hidden="true">×</span>
          </button>
          <button className="traffic-light traffic-minimize" onClick={() => setIsCollapsed((c) => !c)} aria-label={isCollapsed ? 'Expand overlay' : 'Collapse overlay'}>
            <span aria-hidden="true">{isCollapsed ? '+' : '−'}</span>
          </button>
        </div>
        <span className="overlay-title">{translationEnabled ? 'Realtime Bilingual Captions' : 'Realtime English Captions'}</span>
      </header>
      {!isCollapsed && (
        <section className="overlay-body" ref={stackRef}>
          {viewState.captions.map((caption) => (
            <div key={caption.segmentId} className="caption-pair no-drag">
              <p className="caption-line">{caption.sourceText}</p>
              {translationEnabled && caption.translatedText ? (
                <p className="caption-line caption-translation">{caption.translatedText}</p>
              ) : null}
            </div>
          ))}
          {viewState.partial ? (
            <p className="caption-line caption-partial no-drag">{viewState.partial.sourceText}</p>
          ) : null}
          {!hasVisibleCaptions ? (
            <>
              <p className="caption-line caption-hint no-drag">Listening for speech...</p>
              <p className="caption-line caption-hint no-drag">Confirm input level is active, then captions appear here.</p>
            </>
          ) : null}
        </section>
      )}
    </main>
  );
}

function useCaptionState() {
  const [viewState, setViewState] = useState(initialViewState);

  useEffect(() => {
    if (!window.app) {
      setViewState((current) => ({
        ...current,
        sessionState: 'error',
        lastError: 'Preload API is unavailable.',
      }));
      return;
    }

    return window.app.subscribe('sidecar:event', (payload) => {
      const event = payload as SidecarEvent;
      startTransition(() => {
        setViewState((current) => reduceSidecarEvent(current, event));
      });
    });
  }, []);

  return viewState;
}

function applyPreset(
  current: AppSettings,
  preset: 'fast' | 'balanced' | 'accurate',
): AppSettings {
  if (preset === 'fast') {
    return { ...current, sttModel: 'tiny', chunkMs: 700, beamSize: 1, bestOf: 1, vadFilter: false, conditionOnPrev: false };
  }
  if (preset === 'accurate') {
    return { ...current, sttModel: 'small', chunkMs: 1400, beamSize: 5, bestOf: 3, vadFilter: true, conditionOnPrev: true };
  }
  return { ...current, sttModel: 'base', chunkMs: 1000, beamSize: 3, bestOf: 1, vadFilter: true, conditionOnPrev: false };
}

function isTranslationEnabled(settings: AppSettings): boolean {
  return settings.translateModel !== 'disabled' && settings.targetLang !== settings.sourceLang;
}

function getPresetLabel(settings: AppSettings) {
  if (settings.sttModel === 'tiny') return '快速';
  if (settings.sttModel === 'small') return '精準';
  return '平衡';
}

function getSessionSummary(viewState: ReturnType<typeof useCaptionState>, settings: AppSettings) {
  if (viewState.sessionState === 'streaming') {
    const preset = getPresetLabel(settings);
    const translation = isTranslationEnabled(settings) ? '・雙語' : '';
    const audio = getInputHealthLabel(viewState);
    return `${preset}${translation}・${audio}`;
  }
  if (viewState.sessionState === 'error') {
    return viewState.lastError ?? '發生錯誤，請檢查輸入裝置。';
  }
  if (viewState.sessionState === 'connecting') {
    return '連線中…';
  }
  return '選擇輸入裝置後按開始';
}

function getInputHealthLabel(viewState: ReturnType<typeof useCaptionState>) {
  if (viewState.metrics.inputLevel > 0.12) {
    return '音訊正常';
  }
  if (viewState.metrics.inputLevel > 0.02) {
    return '音訊微弱';
  }
  return '無音訊';
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
  const [overlaySuppressedLocal, setOverlaySuppressedLocal] = useState(false);
  const isStreaming = viewState.sessionState === 'streaming' || viewState.sessionState === 'connecting';
  const translationOn = isTranslationEnabled(draft);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const currentPreset = draft.sttModel === 'tiny' && draft.chunkMs === 700
    ? 'fast'
    : draft.sttModel === 'small' && draft.chunkMs === 1400
      ? 'accurate'
      : 'balanced';

  function onPresetChange(preset: string) {
    setDraft((current) => applyPreset(current, preset as 'fast' | 'balanced' | 'accurate'));
  }

  return (
    <main className="settings-shell">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="topbar-title">即時雙語字幕</h1>
          <span className="topbar-summary">{getSessionSummary(viewState, draft)}</span>
        </div>
        <div className="topbar-right" />
      </header>

      <section className="settings-grid">
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
            Speed preset
            <select value={currentPreset} onChange={(event) => onPresetChange(event.target.value)}>
              <option value="fast">Fast (tiny / 700ms)</option>
              <option value="balanced">Balanced (base / 1000ms)</option>
              <option value="accurate">Accurate (small / 1400ms)</option>
            </select>
          </label>
          <div className="form-row-2">
            <label>
              Source lang
              <select value={draft.sourceLang} onChange={(event) => setDraft({ ...draft, sourceLang: event.target.value })}>
                <option value="en">English</option>
                <option value="zh">中文</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
              </select>
            </label>
            <label>
              Target lang
              <select value={draft.targetLang} onChange={(event) => setDraft({ ...draft, targetLang: event.target.value })} disabled={!translationOn}>
                <option value="zh-TW">繁體中文</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
              </select>
            </label>
          </div>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={translationOn}
              onChange={(event) => setDraft({
                ...draft,
                translateModel: event.target.checked ? 'google' : 'disabled',
                targetLang: event.target.checked ? (draft.targetLang === draft.sourceLang ? 'zh-TW' : draft.targetLang) : draft.targetLang,
              })}
            />
            雙語字幕
          </label>
        </article>

        <article className="panel">
          <h2>Output</h2>
          <button className="secondary" onClick={() => {
            if (overlaySuppressedLocal) {
              window.app.showOverlay();
              setOverlaySuppressedLocal(false);
            } else {
              window.app.hideOverlay();
              setOverlaySuppressedLocal(true);
            }
          }}>
            {overlaySuppressedLocal ? '顯示字幕' : '隱藏字幕'}
          </button>
          <div className="form-row-2">
            <label>
              Opacity
              <input type="range" min="0.3" max="1" step="0.05" value={draft.overlayOpacity} onChange={(event) => setDraft({ ...draft, overlayOpacity: Number(event.target.value) })} />
            </label>
            <label>
              Font scale
              <input type="range" min="0.8" max="1.8" step="0.1" value={draft.overlayFontScale} onChange={(event) => setDraft({ ...draft, overlayFontScale: Number(event.target.value) })} />
            </label>
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={draft.saveEnabled} onChange={(event) => setDraft({ ...draft, saveEnabled: event.target.checked })} />
            保存字幕記錄
          </label>
          {draft.saveEnabled && (
            <div className="save-path-row">
              <span className="save-path-text">{draft.saveDirectory || '未設定'}</span>
              <button className="secondary" onClick={async () => {
                const dir = await window.app.chooseSaveDirectory();
                if (dir) {
                  setDraft({ ...draft, saveDirectory: dir });
                }
              }}>選擇</button>
              {draft.saveDirectory && (
                <button className="secondary" onClick={() => window.app.openSaveDirectory()}>查看</button>
              )}
            </div>
          )}
        </article>
      </section>

      <footer className="bottom-bar">
        <button
          disabled={isStreaming}
          onClick={async () => {
            await onSave(draft);
            await window.app.startSession(draft);
          }}
        >
          開始
        </button>
        <button className="secondary" disabled={!isStreaming} onClick={() => window.app.stopSession()}>
          停止
        </button>
      </footer>
    </main>
  );
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [devices, setDevices] = useState<Array<{ id: string; label: string }>>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const captionState = useCaptionState();
  const overlayRoute = isOverlayRoute();

  useEffect(() => {
    document.body.classList.toggle('overlay-route', overlayRoute);
    return () => {
      document.body.classList.remove('overlay-route');
    };
  }, [overlayRoute]);

  useEffect(() => {
    if (!window.app) {
      setBootError('Preload API is unavailable. Restart the app after Electron finishes compiling preload.');
      return;
    }

    window.app.loadSettings().then(setSettings).catch((error: unknown) => {
      setBootError(error instanceof Error ? error.message : 'Failed to load settings');
    });
    window.app.listDevices().then(setDevices).catch((error: unknown) => {
      setBootError(error instanceof Error ? error.message : 'Failed to list devices');
    });
    return window.app.subscribe('settings:changed', (payload) => {
      setSettings(payload as AppSettings);
    });
  }, []);

  async function onSave(partial: Partial<AppSettings>) {
    const next = await window.app.saveSettings(partial);
    setSettings(next);
  }

  if (bootError) {
    return <main className="settings-shell loading">{bootError}</main>;
  }

  if (!settings) {
    return <main className="settings-shell loading">Loading…</main>;
  }

  if (overlayRoute) {
    return <OverlayView viewState={captionState} settings={settings} />;
  }

  return <SettingsView settings={settings} devices={devices} viewState={captionState} onSave={onSave} />;
}
