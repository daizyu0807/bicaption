import { startTransition, useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  CaptionConfig,
  DictationHotkeyBinding,
  DictationOutputAction,
  ModelDownloadProgress,
  ModelStatus,
  SessionMode,
  SidecarEvent,
} from '../electron/types.js';
import { applySettingsOverlayStyle, initialViewState, reduceSidecarEvent } from './caption-state.js';
import { initialDictationViewState, reduceDictationEvent, reduceDictationOutputStatus } from './dictation-state.js';
import { pickPreferredInputDevice } from './device-preferences.js';
import { getDictationHotkeyLabel, isModifierOnlyHotkey, validateDictationHotkey } from './dictation-hotkey.js';

function isOverlayRoute() {
  return window.location.hash === '#overlay';
}

function OverlayView({
  viewState,
  dictationState,
  settings,
  overlayMode,
}: {
  viewState: ReturnType<typeof useCaptionState>;
  dictationState: ReturnType<typeof useDictationState>;
  settings: AppSettings;
  overlayMode: 'hidden' | 'subtitle' | 'dictation';
}) {
  const overlayStyle = applySettingsOverlayStyle(settings);
  const hasVisibleCaptions = viewState.captions.length > 0 || Boolean(viewState.partial);
  const isDictationActive = ['connecting', 'streaming'].includes(dictationState.sessionState)
    || ['recording', 'capturing', 'processing'].includes(dictationState.dictationState);
  const [showDictationResult, setShowDictationResult] = useState(false);
  const shouldShowDictationPrompt = isDictationActive || showDictationResult;
  const shouldShowShell = hasVisibleCaptions
    || viewState.sessionState === 'streaming'
    || viewState.sessionState === 'connecting'
    || shouldShowDictationPrompt
    || overlayMode === 'dictation';
  const translationEnabled = isTranslationEnabled(settings);
  const stackRef = useRef<HTMLElement | null>(null);
  const userScrolledUp = useRef(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);
  const dictationPrompt = getDictationPrompt(dictationState, showDictationResult);
  const effectiveDictationPrompt = overlayMode === 'dictation'
    ? dictationPrompt ?? {
      tone: 'live' as const,
      title: '正在聽你說',
      detail: '按住快捷鍵說話，放開後送出辨識。',
    }
    : dictationPrompt;
  const isDictationOverlayMode = overlayMode === 'dictation';

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
    if (!dictationState.finalText) {
      return;
    }
    setShowDictationResult(true);
    const timeoutId = window.setTimeout(() => setShowDictationResult(false), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [dictationState.finalText]);

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

  if (isDictationOverlayMode && effectiveDictationPrompt) {
    return (
      <main className="overlay-window overlay-window-dictation" style={overlayStyle}>
        <section className="dictation-overlay-shell">
          <div className={`dictation-prompt dictation-prompt-${effectiveDictationPrompt.tone} no-drag`}>
            <span className="dictation-prompt-dot" aria-hidden="true">
              {effectiveDictationPrompt.tone === 'live' && (
                <>
                  <span className="dictation-prompt-ring dictation-prompt-ring-a" />
                  <span className="dictation-prompt-ring dictation-prompt-ring-b" />
                </>
              )}
            </span>
            <div className="dictation-prompt-copy">
              <p className="dictation-prompt-title">{effectiveDictationPrompt.title}</p>
              <p className="dictation-prompt-text">{effectiveDictationPrompt.detail}</p>
              {effectiveDictationPrompt.tone === 'processing' && (
                <span className="dictation-prompt-progress" aria-hidden="true">
                  <span className="dictation-prompt-progress-bar" />
                </span>
              )}
            </div>
          </div>
          <div className="dictation-overlay-actions no-drag">
            <button className="dictation-overlay-close" onClick={closeOverlayAndFocusSettings} aria-label="Hide overlay">
              隱藏
            </button>
          </div>
        </section>
      </main>
    );
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
        <span className="overlay-title">{isDictationOverlayMode ? '語音輸入' : 'BiCaption'}</span>
      </header>
      {!isCollapsed && (
        <section className={`overlay-body${isDictationOverlayMode ? ' overlay-body-prompt-only' : ''}`} ref={stackRef}>
          {dictationPrompt && (
            <div className={`dictation-prompt dictation-prompt-${dictationPrompt.tone} no-drag`}>
              <span className="dictation-prompt-dot" aria-hidden="true">
                {dictationPrompt.tone === 'live' && (
                  <>
                    <span className="dictation-prompt-ring dictation-prompt-ring-a" />
                    <span className="dictation-prompt-ring dictation-prompt-ring-b" />
                  </>
                )}
              </span>
              <div className="dictation-prompt-copy">
                <p className="dictation-prompt-title">{dictationPrompt.title}</p>
                <p className="dictation-prompt-text">{dictationPrompt.detail}</p>
                {dictationPrompt.tone === 'processing' && (
                  <span className="dictation-prompt-progress" aria-hidden="true">
                    <span className="dictation-prompt-progress-bar" />
                  </span>
                )}
              </div>
            </div>
          )}
          {!isDictationOverlayMode ? viewState.captions.map((caption) => (
            <div key={caption.segmentId} className="caption-pair no-drag">
              <p className="caption-line">{caption.sourceText}</p>
              {translationEnabled && caption.translatedText ? (
                <p className="caption-line caption-translation">{caption.translatedText}</p>
              ) : null}
            </div>
          )) : null}
          {!isDictationOverlayMode && viewState.partial ? (
            <p className="caption-line caption-partial no-drag">{viewState.partial.sourceText}</p>
          ) : null}
          {!isDictationOverlayMode && !hasVisibleCaptions ? (
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

  useEffect(() => {
    if (!window.app) {
      return;
    }
    return window.app.subscribe('dictation:output-status', (payload) => {
      startTransition(() => {
        setViewState((current) => reduceDictationOutputStatus(current, payload as {
          type: 'dictation_output_status';
          action: DictationOutputAction;
          status: 'copied' | 'pasted' | 'fallback';
          detail?: string;
        }));
      });
    });
  }, []);

  return viewState;
}

function useOverlayMode() {
  const [mode, setMode] = useState<'hidden' | 'subtitle' | 'dictation'>('hidden');

  useEffect(() => {
    if (!window.app) {
      return;
    }

    return window.app.subscribe('overlay:mode', (payload) => {
      setMode(payload.mode);
    });
  }, []);

  return mode;
}

function getDictationPrompt(
  state: ReturnType<typeof useDictationState>,
  showResult: boolean,
): { tone: 'live' | 'processing' | 'done'; title: string; detail: string } | null {
  if (state.lastError) {
    return {
      tone: 'processing',
      title: '語音輸入中斷',
      detail: state.lastError,
    };
  }
  if (state.dictationState === 'recording') {
    return {
      tone: 'live',
      title: '正在聽你說',
      detail: '按住快捷鍵繼續說話，放開後送出辨識。',
    };
  }
  if (state.dictationState === 'capturing' || state.dictationState === 'processing' || state.sessionState === 'connecting') {
    return {
      tone: 'processing',
      title: '正在整理語音',
      detail: '放開後會自動完成辨識並輸出文字。',
    };
  }
  if (showResult && state.finalText) {
    return {
      tone: 'done',
      title: '已完成語音輸入',
      detail: state.finalText,
    };
  }
  return null;
}

function isTranslationEnabled(settings: AppSettings): boolean {
  if (settings.translateModel === 'disabled') return false;
  return settings.sourceLang === 'auto' || settings.targetLang !== settings.sourceLang;
}

function buildSessionConfig(settings: AppSettings, mode: SessionMode = 'subtitle'): CaptionConfig {
  const isDictation = mode === 'dictation';
  return {
    mode,
    sessionId: crypto.randomUUID(),
    deviceId: isDictation ? settings.dictationDeviceId : settings.subtitleDeviceId,
    outputDeviceId: settings.outputDeviceId,
    sourceLang: isDictation ? settings.dictationSourceLang : settings.sourceLang,
    targetLang: settings.targetLang,
    sttModel: isDictation ? settings.dictationSttModel : settings.sttModel,
    translateModel: settings.translateModel,
    chunkMs: isDictation ? settings.dictationChunkMs : settings.subtitleChunkMs,
    partialStableMs: isDictation ? settings.dictationEndpointMs : settings.subtitlePartialStableMs,
    beamSize: settings.beamSize,
    bestOf: settings.bestOf,
    vadFilter: settings.vadFilter,
    conditionOnPrev: settings.conditionOnPrev,
    dictationRewriteMode: isDictation ? settings.dictationRewriteMode : undefined,
    dictationDictionaryEnabled: isDictation ? settings.dictationDictionaryEnabled : undefined,
    dictationCloudEnhancementEnabled: isDictation ? settings.dictationCloudEnhancementEnabled : undefined,
    dictationOutputStyle: isDictation ? settings.dictationOutputStyle : undefined,
    dictationDictionaryText: isDictation ? settings.dictationDictionaryText : undefined,
    dictationMaxRewriteExpansionRatio: isDictation ? settings.dictationMaxRewriteExpansionRatio : undefined,
  };
}

function getSessionSummary(viewState: ReturnType<typeof useCaptionState>, settings: AppSettings) {
  if (viewState.sessionState === 'streaming') {
    const translation = isTranslationEnabled(settings) ? '雙語' : '單語';
    const modelNames: Record<string, string> = { sensevoice: 'SenseVoice', 'apple-stt': 'SFSpeechRecognizer' };
    const model = modelNames[settings.sttModel] ?? settings.sttModel;
    if (!settings.outputDeviceId) {
      return `${model}・${translation}・系統預設`;
    }
    const audio = getInputHealthLabel(viewState);
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

function getPermissionLabel(status: { trusted: boolean } | { available: boolean; trusted: boolean } | null, kind: 'accessibility' | 'input-monitoring') {
  if (!status) {
    return '檢查中';
  }
  if ('available' in status && !status.available) {
    return '無法使用';
  }
  if (status.trusted) {
    return '已允許';
  }
  return kind === 'accessibility' ? '未允許' : '未授權';
}

function getDictationOutputActionLabel(action: DictationOutputAction) {
  switch (action) {
    case 'copy':
      return '複製到剪貼簿';
    case 'paste':
      return '貼到目前視窗';
    case 'copy-and-paste':
      return '先複製再貼上';
  }
}

function getRewriteBackendLabel(backend: 'disabled' | 'rules' | 'cloud-llm' | 'local-llm' | null) {
  switch (backend) {
    case 'disabled':
      return '未整理';
    case 'rules':
      return '規則整理';
    case 'cloud-llm':
      return '雲端 LLM';
    case 'local-llm':
      return '本地 LLM';
    default:
      return '尚無結果';
  }
}

function getRewriteFallbackLabel(reason: string | null) {
  switch (reason) {
    case 'cloud_rewrite_unavailable':
      return '雲端 rewrite provider 尚未接入，已回退。';
    case 'local_llm_rewrite_unavailable':
      return '本地 LLM rewrite provider 尚未接入，已回退。';
    case 'rewrite_empty':
      return '整理結果為空，已回退到前一階段文字。';
    case 'rewrite_expanded_too_much':
      return '整理結果膨脹過多，已回退到前一階段文字。';
    case 'rewrite_dropped_dictionary_term':
      return '整理結果遺失字典詞條，已回退到前一階段文字。';
    default:
      return null;
  }
}

function SettingsView({
  settings,
  devices,
  viewState,
  dictationViewState,
  modelStatus,
  onSave,
}: {
  settings: AppSettings;
  devices: Array<{ id: string; label: string; kind: string }>;
  viewState: ReturnType<typeof useCaptionState>;
  dictationViewState: ReturnType<typeof useDictationState>;
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
  const [hotkeyTestError, setHotkeyTestError] = useState<string | null>(null);
  const isStreaming = viewState.sessionState === 'streaming' || viewState.sessionState === 'connecting';
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
  const subtitleModelEntries = [
    { key: 'sensevoice', label: 'SenseVoice', ready: localModelStatus?.sensevoice },
    { key: 'whisper-tiny-en', label: 'Whisper tiny.en', ready: localModelStatus?.whisperTinyEn },
    { key: 'whisper-small', label: 'Whisper small', ready: localModelStatus?.whisperSmall },
    { key: 'zipformer-ko', label: 'Zipformer Ko', ready: localModelStatus?.zipformerKo },
    { key: 'vad', label: 'VAD', ready: localModelStatus?.vad },
  ] as const;
  const shouldShowModelPanel = isDownloading || Boolean(downloadError) || subtitleModelEntries.some(({ ready }) => !ready);

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

  async function ensureInputMonitoringPermission() {
    const current = await window.app.checkInputMonitoringPermission();
    setInputMonitoringPermission(current);
    if (current.trusted) {
      return true;
    }
    if (!current.available) {
      setHotkeyTestError(current.detail ?? 'Global hotkey helper is unavailable.');
      return false;
    }
    const requested = await window.app.requestInputMonitoringPermission();
    setInputMonitoringPermission(requested);
    if (!requested.available) {
      setHotkeyTestError(requested.detail ?? 'Global hotkey helper is unavailable.');
      return false;
    }
    if (!requested.trusted) {
      await window.app.openInputMonitoringSettings();
    }
    return requested.trusted;
  }

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

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

      <section className={`settings-grid settings-grid-${activeSettingsTab}`}>
        <div className="settings-tabbar">
          <button
            className={activeSettingsTab === 'subtitle' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setActiveSettingsTab('subtitle')}
          >
            雙語字幕
          </button>
          <button
            className={activeSettingsTab === 'dictation' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setActiveSettingsTab('dictation')}
          >
            語音輸入
          </button>
        </div>
        {activeSettingsTab === 'subtitle' && shouldShowModelPanel && (
        <article className="panel model-panel panel-span-full">
          <h2>Models</h2>
          <div className="model-status-row">
            {subtitleModelEntries.map(({ key, label, ready }) => (
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
        )}

        {activeSettingsTab === 'dictation' && (
        <div className="dictation-grid settings-content-grid">
        <article className="panel panel-compact">
          <h2>語音輸入快捷鍵</h2>
          <label>
            輸入裝置（麥克風）
            <select
              value={draft.dictationDeviceId}
              onChange={(event) => setDraft({ ...draft, dictationDeviceId: event.target.value })}
            >
              {inputDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <div className="dictation-summary-grid">
            <div className="hotkey-event-box">
              <span className="hotkey-event-label">快捷鍵</span>
              <span className="hotkey-event-value">{getDictationHotkeyLabel(hotkeyBinding)}</span>
            </div>
          </div>
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
              快捷鍵組合鍵
              <div className="modifier-grid">
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
              <span className="hotkey-permission-action-spacer" aria-hidden="true" />
            </div>
            <div className="hotkey-permission-row">
              <span className="hotkey-permission-label">Input Monitoring</span>
              <span className={inputMonitoringPermission?.trusted ? 'hotkey-permission-ok' : 'hotkey-permission-missing'}>
                {getPermissionLabel(inputMonitoringPermission, 'input-monitoring')}
              </span>
              <button
                className="secondary"
                disabled={Boolean(inputMonitoringPermission?.trusted)}
                onClick={async () => {
                  setHotkeyTestError(null);
                  try {
                    const granted = await ensureInputMonitoringPermission();
                    if (!granted) {
                      setHotkeyTestError('Input Monitoring settings were opened. Enable the app there, then reopen the app if needed.');
                    }
                  } catch (error) {
                    setHotkeyTestError(error instanceof Error ? error.message : 'Failed to request Input Monitoring permission');
                  }
                }}
              >
                申請
              </button>
            </div>
            {inputMonitoringPermission?.detail && !inputMonitoringPermission.trusted && (
              <p className="error-text">{inputMonitoringPermission.detail}</p>
            )}
          </div>
          {hotkeyTestError && <p className="error-text">{hotkeyTestError}</p>}
        </article>
        <article className="panel panel-compact">
          <h2>語音輸入</h2>
          <label>
            語音辨識引擎
            <select
              value={draft.dictationSttModel}
              onChange={(event) => setDraft({ ...draft, dictationSttModel: event.target.value })}
            >
              <option value="apple-stt">SFSpeechRecognizer</option>
              <option value="sensevoice">SenseVoice</option>
            </select>
          </label>
          <label>
            語音語言
            <select
              value={draft.dictationSourceLang}
              onChange={(event) => {
                const lang = event.target.value;
                const recommended = lang === 'auto' ? 'sensevoice' : draft.dictationSttModel === 'sensevoice' ? 'sensevoice' : 'apple-stt';
                setDraft({ ...draft, dictationSourceLang: lang, dictationSttModel: recommended });
              }}
            >
              <option value="auto">自動偵測</option>
              <option value="en">English</option>
              <option value="zh">中文</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
            </select>
          </label>
          {draft.dictationSttModel === 'apple-stt' && (
            <p className="model-hint">SFSpeechRecognizer 不會做多語自動判斷。若你要中英混講或自動偵測，改用 SenseVoice。</p>
          )}
          <label>
            句尾停頓偵測（{draft.dictationEndpointMs}ms）
            <input
              type="range"
              min="600"
              max="2000"
              step="100"
              value={draft.dictationEndpointMs}
              onChange={(event) => setDraft({ ...draft, dictationEndpointMs: Number(event.target.value) })}
            />
          </label>
          <label>
            輸出文字風格
            <select
              value={draft.dictationOutputStyle}
              onChange={(event) => setDraft({ ...draft, dictationOutputStyle: event.target.value as AppSettings['dictationOutputStyle'] })}
            >
              <option value="literal">原文</option>
              <option value="polished">潤飾後</option>
            </select>
          </label>
          <label>
            整理模式
            <select
              value={draft.dictationRewriteMode}
              onChange={(event) => {
                const mode = event.target.value as AppSettings['dictationRewriteMode'];
                setDraft({
                  ...draft,
                  dictationRewriteMode: mode,
                  dictationCloudEnhancementEnabled: false,
                });
              }}
            >
              <option value="disabled">關閉</option>
              <option value="rules">規則整理</option>
              <option value="rules-and-local-llm">規則 + 本地 LLM</option>
            </select>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={draft.dictationDictionaryEnabled}
              onChange={(event) => setDraft({ ...draft, dictationDictionaryEnabled: event.target.checked })}
            />
            啟用自訂字典
          </label>
          <label>
            自訂字典
            <textarea
              rows={6}
              value={draft.dictationDictionaryText}
              onChange={(event) => setDraft({ ...draft, dictationDictionaryText: event.target.value })}
              placeholder={'spoken => canonical\nchat g p t => ChatGPT\nbicaption => BiCaption'}
            />
          </label>
          <p className="model-hint">每行一條，格式為 <code>{'spoken => canonical'}</code>。左邊可寫常見誤轉或口語說法。</p>
          <label>
            輸出方式
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
              自動貼上需要 Accessibility 權限。若貼上失敗，文字仍會保留在剪貼簿。
            </p>
          )}
          {draft.dictationRewriteMode === 'rules-and-local-llm' && (
            <p className="model-hint">本地 LLM 會先吃 dictionary 校正結果，再依保守 prompt 做書面化；prompt contract 已對齊 SayIt 的「口語轉可直接貼上文字」方向。</p>
          )}
          <p className="model-hint">按住快捷鍵開始語音輸入，放開後結束並輸出文字。</p>
        </article>
        <article className="panel panel-compact">
          <h2>最近一次輸入結果</h2>
          <div className="dictation-summary-grid">
            <div className="hotkey-event-box">
              <span className="hotkey-event-label">整理 backend</span>
              <span className="hotkey-event-value">{getRewriteBackendLabel(dictationViewState.rewriteBackend)}</span>
            </div>
            <div className="hotkey-event-box">
              <span className="hotkey-event-label">延遲</span>
              <span className="hotkey-event-value">{dictationViewState.finalLatencyMs ? `${dictationViewState.finalLatencyMs}ms` : '—'}</span>
            </div>
          </div>
          <label>
            Literal transcript
            <textarea rows={3} value={dictationViewState.literalTranscript} readOnly />
          </label>
          <label>
            Dictionary text
            <textarea rows={3} value={dictationViewState.dictionaryText} readOnly />
          </label>
          <label>
            Final text
            <textarea rows={4} value={dictationViewState.finalText} readOnly />
          </label>
          {getRewriteFallbackLabel(dictationViewState.fallbackReason) && (
            <p className="model-hint">{getRewriteFallbackLabel(dictationViewState.fallbackReason)}</p>
          )}
          {dictationViewState.outputStatus && (
            <p className="model-hint">
              輸出狀態：
              {dictationViewState.outputStatus === 'copied' && '已複製到剪貼簿。'}
              {dictationViewState.outputStatus === 'pasted' && '已貼到目前視窗。'}
              {dictationViewState.outputStatus === 'fallback' && (dictationViewState.outputDetail ?? '貼上失敗，已保留剪貼簿內容。')}
            </p>
          )}
        </article>
        </div>
        )}

        {activeSettingsTab === 'subtitle' && (
        <div className="subtitle-grid settings-content-grid">
        <article className="panel">
          <h2>Bilingual Capture</h2>
          <label>
            輸入裝置（麥克風）
            <select
              value={draft.subtitleDeviceId}
              onChange={(event) => setDraft({ ...draft, subtitleDeviceId: event.target.value })}
            >
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
            <>
              <label>
                翻譯觸發延遲（{draft.partialStableMs}ms）
                <input type="range" min="200" max="2000" step="100" value={draft.partialStableMs} onChange={(event) => setDraft({ ...draft, partialStableMs: Number(event.target.value) })} />
              </label>
              <p className="model-hint">SFSpeechRecognizer 會依照目前的 Source lang 辨識，不會做多語自動判斷。若你講中文，請改成「中文」或改用 SenseVoice + 自動偵測。</p>
            </>
          )}
          <label>
            系統音訊（Loopback）
            <select value={draft.outputDeviceId} onChange={(event) => setDraft({ ...draft, outputDeviceId: event.target.value })}>
              <option value="">系統預設</option>
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
        </div>
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
  const overlayMode = useOverlayMode();
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
      const outputDeviceIds = new Set(loadedDevices.filter((d) => d.kind === 'output' || d.kind === 'duplex').map((d) => d.id));
      const preferred = pickPreferredInputDevice(loadedDevices);
      if (!loadedSettings.subtitleDeviceId || !inputDeviceIds.has(loadedSettings.subtitleDeviceId)) {
        loadedSettings = { ...loadedSettings, subtitleDeviceId: preferred?.id ?? '' };
      }
      if (!loadedSettings.dictationDeviceId || !inputDeviceIds.has(loadedSettings.dictationDeviceId)) {
        loadedSettings = { ...loadedSettings, dictationDeviceId: preferred?.id ?? '' };
      }
      if (loadedSettings.outputDeviceId && !outputDeviceIds.has(loadedSettings.outputDeviceId)) {
        loadedSettings = { ...loadedSettings, outputDeviceId: '' };
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
    return <OverlayView viewState={captionState} dictationState={dictationState} settings={settings} overlayMode={overlayMode} />;
  }

  return <SettingsView settings={settings} devices={devices} viewState={captionState} dictationViewState={dictationState} modelStatus={modelStatus} onSave={onSave} />;
}
