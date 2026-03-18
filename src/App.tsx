import { startTransition, useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  CaptionConfig,
  DictationFinalEvent,
  DictationHotkeyBinding,
  DictationHotkeyEvent,
  DictationOutputAction,
  DictationOutputStatusEvent,
  DictationStateEvent,
  ModelDownloadProgress,
  ModelStatus,
  SessionMode,
  SidecarEvent,
} from '../electron/types.js';
import { applySettingsOverlayStyle, initialViewState, reduceSidecarEvent } from './caption-state.js';
import { initialDictationViewState, reduceDictationEvent } from './dictation-state.js';
import { getDictationHotkeyLabel, isModifierOnlyHotkey, validateDictationHotkey } from './dictation-hotkey.js';

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
  const translationEnabled = isTranslationEnabled(settings);
  const stackRef = useRef<HTMLElement | null>(null);
  const userScrolledUp = useRef(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);

  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      // Consider "at bottom" if within 30px of the bottom
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      userScrolledUp.current = !atBottom;
    }
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!stackRef.current || userScrolledUp.current) {
      return;
    }
    stackRef.current.scrollTop = stackRef.current.scrollHeight;
  }, [viewState.captions, viewState.partial]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.screenX - drag.startX;
      const dy = e.screenY - drag.startY;
      window.app.setOverlayPosition(drag.winX + dx, drag.winY + dy);
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  if (!shouldShowShell) {
    return <main className="overlay-window overlay-hidden" />;
  }

  async function closeOverlayAndFocusSettings() {
    await window.app.hideOverlay();
    await window.app.showSettings();
  }

  return (
    <main className="overlay-window" style={overlayStyle}>
      <header className="overlay-titlebar" onMouseDown={async (e) => {
        if ((e.target as HTMLElement).closest('.no-drag')) return;
        const [winX, winY] = await window.app.getOverlayPosition();
        dragRef.current = { startX: e.screenX, startY: e.screenY, winX, winY };
      }}>
        <div className="overlay-window-controls no-drag">
          <button className="traffic-light traffic-close" onClick={closeOverlayAndFocusSettings} aria-label="Hide overlay">
            <span aria-hidden="true">×</span>
          </button>
          <button className="traffic-light traffic-minimize" onClick={() => setIsCollapsed((c) => !c)} aria-label={isCollapsed ? 'Expand overlay' : 'Collapse overlay'}>
            <span aria-hidden="true">{isCollapsed ? '+' : '−'}</span>
          </button>
        </div>
        <span className="overlay-title">BiCaption</span>
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

function useDictationState() {
  const [viewState, setViewState] = useState(initialDictationViewState);

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
        setViewState((current) => reduceDictationEvent(current, event));
      });
    });
  }, []);

  return viewState;
}

function isTranslationEnabled(settings: AppSettings): boolean {
  if (settings.translateModel === 'disabled') return false;
  return settings.sourceLang === 'auto' || settings.targetLang !== settings.sourceLang;
}

function buildSessionConfig(settings: AppSettings, mode: SessionMode = 'subtitle'): CaptionConfig {
  return {
    mode,
    sessionId: crypto.randomUUID(),
    deviceId: settings.deviceId,
    outputDeviceId: settings.outputDeviceId,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    sttModel: settings.sttModel,
    translateModel: settings.translateModel,
    chunkMs: settings.chunkMs,
    partialStableMs: settings.partialStableMs,
    beamSize: settings.beamSize,
    bestOf: settings.bestOf,
    vadFilter: settings.vadFilter,
    conditionOnPrev: settings.conditionOnPrev,
  };
}

function getSessionSummary(viewState: ReturnType<typeof useCaptionState>, settings: AppSettings) {
  if (viewState.sessionState === 'streaming') {
    const translation = isTranslationEnabled(settings) ? '雙語' : '單語';
    const audio = getInputHealthLabel(viewState);
    const modelNames: Record<string, string> = { sensevoice: 'SenseVoice', 'apple-stt': 'SFSpeechRecognizer' };
    const model = modelNames[settings.sttModel] ?? settings.sttModel;
    return `${model}・${translation}・${audio}`;
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

function getDownloadLabel(progress: ModelDownloadProgress | null): string {
  if (!progress) return '下載模型';
  if (progress.stage === 'extracting') return '解壓縮中…';
  const stageNames: Record<string, string> = { sensevoice: 'SenseVoice', 'apple-stt': 'SFSpeechRecognizer', vad: 'VAD' };
  const name = stageNames[progress.stage] ?? progress.stage;
  if (progress.totalMB > 0) {
    return `下載 ${name}… ${progress.downloadedMB}/${progress.totalMB} MB (${progress.percent}%)`;
  }
  return `下載 ${name}…`;
}

function getDictationHotkeyEventLabel(event: DictationHotkeyEvent | null): string {
  if (!event) {
    return 'No hotkey events yet.';
  }
  switch (event.type) {
    case 'listener_ready':
      return `Listener ready${typeof event.keyCode === 'number' ? ` for keyCode ${event.keyCode}` : ''}`;
    case 'hotkey_down':
      return `Hotkey down${typeof event.keyCode === 'number' ? ` (${event.keyCode})` : ''}`;
    case 'hotkey_up':
      return `Hotkey up${typeof event.keyCode === 'number' ? ` (${event.keyCode})` : ''}`;
    case 'permission_status':
      return `Permission status: ${event.trusted ? 'trusted' : 'not trusted'}`;
    case 'listener_stopped':
      return event.message ?? 'Listener stopped';
    case 'error':
      return event.message ?? 'Unknown hotkey error';
    default:
      return 'No hotkey events yet.';
  }
}

function getPermissionLabel(status: { trusted: boolean } | { available: boolean; trusted: boolean } | null, kind: 'accessibility' | 'input-monitoring') {
  if (!status) {
    return 'Checking…';
  }
  if ('available' in status && !status.available) {
    return 'Unavailable';
  }
  if (status.trusted) {
    return 'Granted';
  }
  return kind === 'accessibility' ? 'Denied' : 'Not granted';
}

function getDictationOutputActionLabel(action: DictationOutputAction) {
  switch (action) {
    case 'copy':
      return 'Copy to clipboard';
    case 'paste':
      return 'Paste to foreground app';
    case 'copy-and-paste':
      return 'Copy and paste';
  }
}

function getDictationStateLabel(event: DictationStateEvent | null, viewState: ReturnType<typeof useDictationState>) {
  if (event) {
    return `${event.state}${event.detail ? ` - ${event.detail}` : ''}`;
  }
  if (viewState.lastError) {
    return `error - ${viewState.lastError}`;
  }
  return `${viewState.dictationState}${viewState.detail ? ` - ${viewState.detail}` : ''}`;
}

function getDictationFinalLabel(event: DictationFinalEvent | null, viewState: ReturnType<typeof useDictationState>) {
  const text = event?.text || viewState.finalText;
  if (!text) {
    return 'No dictation transcript yet.';
  }
  const chunkCount = event?.chunkCount ?? viewState.finalChunkCount;
  const latencyMs = event?.latencyMs ?? viewState.finalLatencyMs;
  const meta = [
    typeof chunkCount === 'number' ? `${chunkCount} chunk${chunkCount === 1 ? '' : 's'}` : null,
    typeof latencyMs === 'number' ? `${latencyMs}ms` : null,
  ].filter(Boolean).join(' · ');
  return meta ? `${text} (${meta})` : text;
}

function SettingsView({
  settings,
  devices,
  viewState,
  dictationState,
  modelStatus,
  onSave,
}: {
  settings: AppSettings;
  devices: Array<{ id: string; label: string; kind: string }>;
  viewState: ReturnType<typeof useCaptionState>;
  dictationState: ReturnType<typeof useDictationState>;
  modelStatus: ModelStatus | null;
  onSave: (partial: Partial<AppSettings>) => Promise<void>;
}) {
  const [activeSettingsTab, setActiveSettingsTab] = useState<'subtitle' | 'dictation'>('subtitle');
  const [draft, setDraft] = useState(settings);
  const inputDevices = devices.filter((d) => d.kind === 'input' || d.kind === 'duplex');
  const loopbackDevices = devices.filter((d) => d.kind === 'duplex');
  const [overlaySuppressedLocal, setOverlaySuppressedLocal] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [localModelStatus, setLocalModelStatus] = useState(modelStatus);
  const [accessibilityPermission, setAccessibilityPermission] = useState<{ trusted: boolean; status: string } | null>(null);
  const [inputMonitoringPermission, setInputMonitoringPermission] = useState<{ trusted: boolean; available: boolean; detail?: string } | null>(null);
  const [hotkeyEvent, setHotkeyEvent] = useState<DictationHotkeyEvent | null>(null);
  const [dictationEvent, setDictationEvent] = useState<DictationStateEvent | null>(null);
  const [dictationFinalEvent, setDictationFinalEvent] = useState<DictationFinalEvent | null>(null);
  const [dictationOutputStatus, setDictationOutputStatus] = useState<DictationOutputStatusEvent | null>(null);
  const [hotkeyTestError, setHotkeyTestError] = useState<string | null>(null);
  const [isHotkeyTestRunning, setIsHotkeyTestRunning] = useState(false);
  const isStreaming = viewState.sessionState === 'streaming' || viewState.sessionState === 'connecting';
  const isDictating = ['connecting', 'streaming'].includes(dictationState.sessionState)
    || ['recording', 'capturing', 'processing'].includes(dictationState.dictationState);
  const translationOn = isTranslationEnabled(draft);
  const hotkeyBinding: DictationHotkeyBinding = draft.dictationHotkey;
  const hotkeyValidation = validateDictationHotkey(hotkeyBinding);
  const modelReadyMap: Record<string, boolean> = {
    sensevoice: localModelStatus?.sensevoice ?? false,
    'apple-stt': true,  // No model download needed — uses macOS built-in
  };
  const selectedModelReady = modelReadyMap[draft.sttModel] ?? false;
  const modelsReady = draft.sttModel === 'apple-stt' || (selectedModelReady && (localModelStatus?.vad ?? true));
  const isDownloading = downloadProgress !== null;

  useEffect(() => {
    setLocalModelStatus(modelStatus);
  }, [modelStatus]);

  useEffect(() => {
    const unsubs = [
      window.app.subscribe('models:progress', (payload) => {
        setDownloadProgress(payload as ModelDownloadProgress);
        setDownloadError(null);
      }),
      window.app.subscribe('models:done', (payload) => {
        setDownloadProgress(null);
        setLocalModelStatus(payload as ModelStatus);
      }),
      window.app.subscribe('models:error', (payload) => {
        setDownloadProgress(null);
        setDownloadError(payload as string);
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.app.checkAccessibilityPermission(),
      window.app.checkInputMonitoringPermission(),
    ]).then(([accessibility, inputMonitoring]) => {
      if (cancelled) {
        return;
      }
      setAccessibilityPermission(accessibility);
      setInputMonitoringPermission(inputMonitoring);
    }).catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      setHotkeyTestError(error instanceof Error ? error.message : 'Failed to check dictation permissions');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.app.subscribe('dictation:hotkey-event', (payload) => {
      const event = payload as DictationHotkeyEvent;
      setHotkeyEvent(event);
      if (event.type === 'listener_ready') {
        setIsHotkeyTestRunning(true);
        setHotkeyTestError(null);
      } else if (event.type === 'listener_stopped') {
        setIsHotkeyTestRunning(false);
      } else if (event.type === 'error') {
        setHotkeyTestError(event.message ?? 'Unknown hotkey error');
      }
    });
  }, []);

  useEffect(() => {
    return window.app.subscribe('sidecar:event', (payload) => {
      const event = payload as SidecarEvent;
      if (event.mode !== 'dictation') {
        return;
      }
      if (event.type === 'dictation_state') {
        setDictationEvent(event);
      } else if (event.type === 'dictation_final') {
        setDictationFinalEvent(event);
      } else if (event.type === 'session_state' && event.state === 'connecting') {
        setDictationEvent(null);
        setDictationFinalEvent(null);
        setDictationOutputStatus(null);
      }
    });
  }, []);

  useEffect(() => {
    return window.app.subscribe('dictation:output-status', (payload) => {
      setDictationOutputStatus(payload as DictationOutputStatusEvent);
    });
  }, []);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  async function startManualDictation() {
    if (isStreaming || isDictating) {
      await window.app.stopSession();
    }
    const nextSettings = {
      ...draft,
      translateModel: isTranslationEnabled(draft) ? 'google' : 'disabled',
    };
    await onSave(nextSettings);
    await window.app.startSession(buildSessionConfig(nextSettings, 'dictation'));
  }

  function toggleHotkeyModifier(modifier: string, checked: boolean) {
    const modifiers = checked
      ? [...new Set([...draft.dictationHotkey.modifiers, modifier])]
      : draft.dictationHotkey.modifiers.filter((item) => item !== modifier);
    setDraft({
      ...draft,
      dictationHotkey: {
        ...draft.dictationHotkey,
        modifiers,
      },
    });
  }

  const modifierOnlyHotkey = isModifierOnlyHotkey(hotkeyBinding);


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
        <div className="settings-tabbar">
          <button
            className={activeSettingsTab === 'subtitle' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setActiveSettingsTab('subtitle')}
          >
            雙語辨識
          </button>
          <button
            className={activeSettingsTab === 'dictation' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setActiveSettingsTab('dictation')}
          >
            語音輸入
          </button>
        </div>
        <article className="panel model-panel">
          <h2>Models</h2>
          <div className="model-status-row">
            {([
              { key: 'sensevoice', label: 'SenseVoice', ready: localModelStatus?.sensevoice },
              { key: 'whisper-tiny-en', label: 'Whisper tiny.en', ready: localModelStatus?.whisperTinyEn },
              { key: 'whisper-small', label: 'Whisper small', ready: localModelStatus?.whisperSmall },
              { key: 'zipformer-ko', label: 'Zipformer Ko', ready: localModelStatus?.zipformerKo },
              { key: 'vad', label: 'VAD', ready: localModelStatus?.vad },
            ] as const).map(({ key, label, ready }) => (
              <div key={key} className="model-row">
                <span className={ready ? 'model-ok' : 'model-missing'}>
                  {ready ? '✓' : '✗'} {label}
                </span>
                {!ready && (
                  <button
                    className="secondary"
                    disabled={isDownloading}
                    onClick={() => window.app.downloadModel(key)}
                  >
                    下載
                  </button>
                )}
              </div>
            ))}
          </div>
          {isDownloading && downloadProgress && (
            <div className="progress-bar-container">
              <div className="progress-bar-fill" style={{ width: `${downloadProgress.percent}%` }} />
            </div>
          )}
          {isDownloading && <p className="model-hint">{getDownloadLabel(downloadProgress)}</p>}
          {downloadError && <p className="error-text">{downloadError}</p>}
        </article>

        {activeSettingsTab === 'dictation' && (
        <article className="panel">
          <h2>Dictation Hotkey</h2>
          <p className="model-hint">Binding: {getDictationHotkeyLabel(hotkeyBinding)}</p>
          {hotkeyValidation.error && <p className="error-text">{hotkeyValidation.error}</p>}
          {!hotkeyValidation.error && hotkeyValidation.warning && <p className="model-hint">{hotkeyValidation.warning}</p>}
          <div className="form-row-2">
            <label>
              Hotkey key
              <select
                value={draft.dictationHotkey.keyCode}
                onChange={(event) => {
                  const keyCode = Number(event.target.value);
                  setDraft({
                    ...draft,
                    dictationHotkey: {
                      ...draft.dictationHotkey,
                      keyCode,
                      modifiers: [59, 63].includes(keyCode) ? [] : draft.dictationHotkey.modifiers,
                    },
                  });
                }}
              >
                <option value="59">Hold Ctrl</option>
                <option value="63">Hold Fn</option>
                <option value="49">Space</option>
                <option value="36">Return</option>
              </select>
            </label>
            <label>
              Hotkey modifiers
              <div className="form-row-2">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={draft.dictationHotkey.modifiers.includes('cmd')}
                    disabled={modifierOnlyHotkey}
                    onChange={(event) => toggleHotkeyModifier('cmd', event.target.checked)}
                  />
                  Cmd
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={draft.dictationHotkey.modifiers.includes('shift')}
                    disabled={modifierOnlyHotkey}
                    onChange={(event) => toggleHotkeyModifier('shift', event.target.checked)}
                  />
                  Shift
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={draft.dictationHotkey.modifiers.includes('ctrl')}
                    disabled={modifierOnlyHotkey}
                    onChange={(event) => toggleHotkeyModifier('ctrl', event.target.checked)}
                  />
                  Ctrl
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={draft.dictationHotkey.modifiers.includes('alt')}
                    disabled={modifierOnlyHotkey}
                    onChange={(event) => toggleHotkeyModifier('alt', event.target.checked)}
                  />
                  Option
                </label>
              </div>
            </label>
          </div>
          {modifierOnlyHotkey && <p className="model-hint">Modifier-only mode uses press-to-talk directly on the selected key.</p>}
          <div className="hotkey-permissions">
            <div className="hotkey-permission-row">
              <span className="hotkey-permission-label">Accessibility</span>
              <span className={accessibilityPermission?.trusted ? 'hotkey-permission-ok' : 'hotkey-permission-missing'}>
                {getPermissionLabel(accessibilityPermission, 'accessibility')}
              </span>
            </div>
            <div className="hotkey-permission-row">
              <span className="hotkey-permission-label">Input Monitoring</span>
              <span className={inputMonitoringPermission?.trusted ? 'hotkey-permission-ok' : 'hotkey-permission-missing'}>
                {getPermissionLabel(inputMonitoringPermission, 'input-monitoring')}
              </span>
            </div>
          </div>
          <div className="hotkey-actions">
            <button
              className="secondary"
              disabled={isHotkeyTestRunning || !hotkeyValidation.isValid}
              onClick={async () => {
                setHotkeyTestError(null);
                setIsHotkeyTestRunning(true);
                try {
                  await window.app.testDictationHotkey(hotkeyBinding);
                } catch (error) {
                  setIsHotkeyTestRunning(false);
                  setHotkeyTestError(error instanceof Error ? error.message : 'Failed to start dictation hotkey test');
                }
              }}
            >
              Start Test
            </button>
            <button
              className="secondary"
              disabled={!isHotkeyTestRunning}
              onClick={async () => {
                try {
                  await window.app.stopDictationHotkeyTest();
                } finally {
                  setIsHotkeyTestRunning(false);
                }
              }}
            >
              Stop Test
            </button>
          </div>
          <div className="hotkey-event-box">
            <span className="hotkey-event-label">Latest event</span>
            <span className="hotkey-event-value">{getDictationHotkeyEventLabel(hotkeyEvent)}</span>
          </div>
          {hotkeyTestError && <p className="error-text">{hotkeyTestError}</p>}
        </article>
        )}

        {activeSettingsTab === 'dictation' && (
        <article className="panel">
          <h2>Dictation Session</h2>
          <p className="model-hint">Session: {dictationState.sessionState}</p>
          <div className="hotkey-event-box">
            <span className="hotkey-event-label">Latest state</span>
            <span className="hotkey-event-value">{getDictationStateLabel(dictationEvent, dictationState)}</span>
          </div>
          <div className="hotkey-event-box">
            <span className="hotkey-event-label">Latest transcript</span>
            <span className="hotkey-event-value">{getDictationFinalLabel(dictationFinalEvent, dictationState)}</span>
          </div>
          {dictationOutputStatus && (
            <div className="hotkey-event-box">
              <span className="hotkey-event-label">Output</span>
              <span className="hotkey-event-value">
                {dictationOutputStatus.status}
                {dictationOutputStatus.detail ? ` - ${dictationOutputStatus.detail}` : ''}
              </span>
            </div>
          )}
          <div className="hotkey-actions">
            <button
              className="secondary"
              disabled={!modelsReady || isDictating}
              onClick={() => void startManualDictation()}
            >
              Start Dictation
            </button>
            <button
              className="secondary"
              disabled={!isDictating}
              onClick={() => window.app.stopSession()}
            >
              Stop Dictation
            </button>
          </div>
          {dictationState.lastError && <p className="error-text">{dictationState.lastError}</p>}
        </article>
        )}

        {activeSettingsTab === 'subtitle' && (
        <article className="panel">
          <h2>Bilingual Capture</h2>
          <label>
            輸入裝置（麥克風）
            <select value={draft.deviceId} onChange={(event) => setDraft({ ...draft, deviceId: event.target.value })}>
              {inputDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            語音辨識引擎
            <select value={draft.sttModel} onChange={(event) => setDraft({ ...draft, sttModel: event.target.value })}>
              <option value="apple-stt">SFSpeechRecognizer — macOS 內建，免下載，串流翻譯</option>
              <option value="sensevoice">SenseVoice — 多語言混合辨識，支援中英日韓</option>
            </select>
          </label>
          {draft.sttModel === 'apple-stt' && (
            <label>
              翻譯觸發延遲（{draft.partialStableMs}ms）
              <input type="range" min="200" max="2000" step="100" value={draft.partialStableMs} onChange={(event) => setDraft({ ...draft, partialStableMs: Number(event.target.value) })} />
            </label>
          )}
          <label>
            系統音訊（Loopback）
            <select value={draft.outputDeviceId} onChange={(event) => setDraft({ ...draft, outputDeviceId: event.target.value })}>
              <option value="">不使用</option>
              {loopbackDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-row-2">
            <label>
              Source lang
              <select value={draft.sourceLang} onChange={(event) => {
                const lang = event.target.value;
                const recommended = lang === 'auto' ? 'sensevoice' : 'apple-stt';
                setDraft({ ...draft, sourceLang: lang, sttModel: recommended });
              }}>
                <option value="auto">自動偵測</option>
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
          <button className={overlaySuppressedLocal ? 'secondary' : ''} onClick={() => {
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
        </article>
        )}

        {activeSettingsTab === 'dictation' && (
        <article className="panel">
          <h2>Dictation Output</h2>
          <label>
            Dictation output
            <select
              value={draft.dictationOutputAction}
              onChange={(event) => setDraft({ ...draft, dictationOutputAction: event.target.value as DictationOutputAction })}
            >
              <option value="copy">{getDictationOutputActionLabel('copy')}</option>
              <option value="paste">{getDictationOutputActionLabel('paste')}</option>
              <option value="copy-and-paste">{getDictationOutputActionLabel('copy-and-paste')}</option>
            </select>
          </label>
          {draft.dictationOutputAction !== 'copy' && (
            <p className="model-hint">
              Paste currently requires Accessibility permission. If paste fails, the transcript stays in clipboard.
            </p>
          )}
        </article>
        )}

        {activeSettingsTab === 'subtitle' && (
        <article className="panel">
          <h2>Subtitle Output</h2>
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
        )}
      </section>

      <footer className="bottom-bar">
        {activeSettingsTab === 'subtitle' ? (
          <>
            <button
              disabled={!modelsReady || !hotkeyValidation.isValid}
              onClick={async () => {
                if (isStreaming) {
                  await window.app.stopSession();
                }
                const nextSettings = {
                  ...draft,
                  translateModel: isTranslationEnabled(draft) ? 'google' : 'disabled',
                };
                await onSave(nextSettings);
                await window.app.startSession(buildSessionConfig(nextSettings));
              }}
            >
              {!modelsReady ? '需要下載模型' : isStreaming ? '套用' : '開始'}
            </button>
            <button className="secondary" disabled={!isStreaming} onClick={() => window.app.stopSession()}>
              停止
            </button>
          </>
        ) : (
          <>
            <button
              disabled={!hotkeyValidation.isValid}
              onClick={async () => {
                const nextSettings = {
                  ...draft,
                  translateModel: isTranslationEnabled(draft) ? 'google' : 'disabled',
                };
                await onSave(nextSettings);
              }}
            >
              儲存語音輸入設定
            </button>
            <button className="secondary" disabled={!isDictating} onClick={() => window.app.stopSession()}>
              停止 Dictation
            </button>
          </>
        )}
      </footer>
    </main>
  );
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [devices, setDevices] = useState<Array<{ id: string; label: string; kind: string }>>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const captionState = useCaptionState();
  const dictationState = useDictationState();
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

    Promise.all([
      window.app.loadSettings(),
      window.app.listDevices(),
    ]).then(([loadedSettings, loadedDevices]) => {
      setDevices(loadedDevices);
      const inputDeviceIds = new Set(
        loadedDevices.filter((d) => d.kind === 'input' || d.kind === 'duplex').map((d) => d.id),
      );
      if (loadedSettings.deviceId && !inputDeviceIds.has(loadedSettings.deviceId)) {
        const first = loadedDevices.find((d) => d.kind === 'input' || d.kind === 'duplex');
        if (first) {
          loadedSettings = { ...loadedSettings, deviceId: first.id };
        }
      }
      setSettings(loadedSettings);
    }).catch((error: unknown) => {
      setBootError(error instanceof Error ? error.message : 'Failed to load settings or devices');
    });
    window.app.checkModels().then(setModelStatus).catch(() => {});
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

  return <SettingsView settings={settings} devices={devices} viewState={captionState} dictationState={dictationState} modelStatus={modelStatus} onSave={onSave} />;
}
