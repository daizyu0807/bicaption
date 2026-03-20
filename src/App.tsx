import { startTransition, useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  CaptionConfig,
  DictationHotkeyBinding,
  DictationOutputAction,
  MeetingNotesResult,
  ModelDownloadProgress,
  ModelStatus,
  SessionMode,
  SidecarEvent,
} from '../electron/types.js';
import { applySettingsOverlayStyle, initialViewState, reduceSidecarEvent } from './caption-state.js';
import { initialDictationViewState, reduceDictationEvent, reduceDictationOutputStatus } from './dictation-state.js';
import { pickPreferredInputDevice } from './device-preferences.js';
import { getDictationHotkeyLabel, isModifierOnlyHotkey, validateDictationHotkey } from './dictation-hotkey.js';
import { initialMeetingViewState, reduceMeetingEvent } from './meeting-state.js';

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
  const shouldShowDictationPrompt = isDictationActive || showDictationResult || Boolean(dictationState.finalText);
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
  const suppressOrbClickRef = useRef(false);
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
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        suppressOrbClickRef.current = true;
      }
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
        <section
          className={`dictation-float-shell dictation-float-shell-${effectiveDictationPrompt.tone}`}
          onMouseDown={async (e) => {
            if (!(e.target as HTMLElement).closest('.dictation-float-orb')) {
              return;
            }
            const [winX, winY] = await window.app.getOverlayPosition();
            suppressOrbClickRef.current = false;
            dragRef.current = { startX: e.screenX, startY: e.screenY, winX, winY };
          }}
        >
          <button
            className={`dictation-float-orb dictation-float-${effectiveDictationPrompt.tone}`}
            onClick={(e) => {
              if (suppressOrbClickRef.current) {
                suppressOrbClickRef.current = false;
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              void closeOverlayAndFocusSettings();
            }}
            aria-label={effectiveDictationPrompt.title}
          >
            {effectiveDictationPrompt.tone === 'live' ? (
              <>
                <span className="dictation-float-wave dictation-float-wave-a" />
                <span className="dictation-float-wave dictation-float-wave-b" />
                <span className="dictation-float-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
              </>
            ) : null}
            {effectiveDictationPrompt.tone === 'processing' ? (
              <span className="dictation-float-processing-glyph" aria-hidden="true">
                <span className="dictation-float-spinner" />
                <span className="dictation-float-dot dictation-float-dot-a" />
                <span className="dictation-float-dot dictation-float-dot-b" />
                <span className="dictation-float-dot dictation-float-dot-c" />
              </span>
            ) : null}
            {effectiveDictationPrompt.tone === 'done' ? (
              <span className="dictation-float-done-glyph" aria-hidden="true">
                <span className="dictation-float-check" />
              </span>
            ) : null}
          </button>
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

function useMeetingState() {
  const [viewState, setViewState] = useState(initialMeetingViewState);

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
        setViewState((current) => reduceMeetingEvent(current, event));
      });
    });
  }, []);

  return viewState;
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
  if (state.dictationState === 'capturing' || (state.activeSessionId && state.sessionState === 'connecting')) {
    return {
      tone: 'live',
      title: '正在聽你說',
      detail: '持續收音中，放開後才會開始整理。',
    };
  }
  if (state.dictationState === 'processing' || (state.activeSessionId && state.sessionState === 'stopped' && !state.finalText)) {
    return {
      tone: 'processing',
      title: '正在整理語音',
      detail: '放開後會自動完成辨識並輸出文字。',
    };
  }
  if (state.finalText) {
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

function getDefaultSubtitleTargetLang(sourceLang: string): string {
  if (sourceLang === 'en') return 'zh-TW';
  if (sourceLang === 'ja') return 'zh-TW';
  if (sourceLang === 'ko') return 'zh-TW';
  if (sourceLang === 'zh-TW') return 'en';
  return 'zh-TW';
}

function getRecommendedSubtitleSttModel(sourceLang: string, currentModel?: string): string {
  if (currentModel === 'moonshine' || sourceLang === 'en') {
    return 'moonshine';
  }
  return sourceLang === 'auto' ? 'sensevoice' : 'apple-stt';
}

function buildSessionConfig(settings: AppSettings, mode: SessionMode = 'subtitle'): CaptionConfig {
  const isDictation = mode === 'dictation';
  const isMeeting = mode === 'meeting';
  const meetingPrimaryDeviceId = settings.meetingSourceMode === 'system-audio'
    ? settings.meetingSystemAudioDeviceId
    : settings.meetingMicDeviceId;
  const meetingSecondaryDeviceId = settings.meetingSourceMode === 'dual'
    ? settings.meetingSystemAudioDeviceId
    : '';
  return {
    mode,
    sessionId: crypto.randomUUID(),
    deviceId: isMeeting ? meetingPrimaryDeviceId : isDictation ? settings.dictationDeviceId : settings.subtitleDeviceId,
    outputDeviceId: isMeeting ? meetingSecondaryDeviceId : settings.outputDeviceId,
    sourceLang: isMeeting ? settings.meetingSourceLang : isDictation ? settings.dictationSourceLang : settings.sourceLang,
    targetLang: isMeeting ? settings.meetingTargetLang : settings.targetLang,
    sttModel: isMeeting ? settings.meetingSttModel : isDictation ? settings.dictationSttModel : settings.sttModel,
    translateModel: isMeeting ? settings.meetingTranslateModel : settings.translateModel,
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
    dictationLocalLlmModel: isDictation ? settings.dictationLocalLlmModel : undefined,
    dictationLocalLlmRunner: isDictation ? settings.dictationLocalLlmRunner : undefined,
    meetingSourceMode: isMeeting ? settings.meetingSourceMode : undefined,
    meetingSpeakerLabelsEnabled: isMeeting ? settings.meetingSpeakerLabelsEnabled : undefined,
    meetingNotesPrompt: isMeeting ? settings.meetingNotesPrompt : undefined,
    meetingSaveTranscript: isMeeting ? settings.meetingSaveTranscript : undefined,
    meetingTranscriptDirectory: isMeeting ? settings.meetingTranscriptDirectory : undefined,
  };
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

const MODEL_LIBRARY = [
  {
    key: 'moonshine',
    label: 'Moonshine',
    sizeLabel: '~0.1 GB+',
    description: '低延遲串流語音辨識，優先用於雙語字幕與會議字幕。',
  },
  {
    key: 'sensevoice',
    label: 'SenseVoice',
    sizeLabel: '~0.9 GB',
    description: '多語辨識主力模型，適合繁體中文、英文與混語場景。',
  },
  {
    key: 'whisper-tiny-en',
    label: 'Whisper tiny.en',
    sizeLabel: '~80 MB',
    description: '極輕量英文模型，適合低資源與快速驗證。',
  },
  {
    key: 'whisper-small',
    label: 'Whisper small',
    sizeLabel: '~480 MB',
    description: '英文準確率更高的 Whisper 模型，載入時間也較長。',
  },
  {
    key: 'zipformer-ko',
    label: 'Zipformer Korean',
    sizeLabel: '~180 MB',
    description: '韓文辨識模型，適合韓文字幕與口語輸入。',
  },
  {
    key: 'vad',
    label: 'Silero VAD',
    sizeLabel: '~2 MB',
    description: '語音活動偵測元件，負責切分說話片段。',
  },
] as const;

function isModelReady(status: ModelStatus | null, key: (typeof MODEL_LIBRARY)[number]['key']) {
  switch (key) {
    case 'moonshine':
      return true;
    case 'sensevoice':
      return status?.sensevoice ?? false;
    case 'whisper-tiny-en':
      return status?.whisperTinyEn ?? false;
    case 'whisper-small':
      return status?.whisperSmall ?? false;
    case 'zipformer-ko':
      return status?.zipformerKo ?? false;
    case 'vad':
      return status?.vad ?? false;
    default:
      return false;
  }
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

function isStreamingModelReady(status: ModelStatus | null, modelKey: string) {
  const modelReadyMap: Record<string, boolean> = {
    moonshine: true,
    sensevoice: status?.sensevoice ?? false,
    'apple-stt': true,
  };
  return modelKey === 'sensevoice'
    ? Boolean(modelReadyMap[modelKey] && (status?.vad ?? true))
    : Boolean(modelReadyMap[modelKey]);
}

function getMeetingSpeakerLabel(
  settings: Pick<AppSettings, 'meetingMicrophoneLabel' | 'meetingSystemLabel'>,
  source?: 'microphone' | 'system',
  fallbackLabel?: string,
) {
  if (source === 'microphone') {
    return settings.meetingMicrophoneLabel || fallbackLabel || '我方';
  }
  if (source === 'system') {
    return settings.meetingSystemLabel || fallbackLabel || '遠端';
  }
  return fallbackLabel || '未標記';
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
    case 'local_llm_provider_missing':
      return '找不到本地 LLM rewrite script，已回退到規則整理。';
    case 'local_llm_dependency_missing':
      return '本地 LLM 依賴未安裝，已回退到規則整理。';
    case 'local_llm_model_missing':
      return '尚未設定本地 LLM 模型，已回退到規則整理。';
    case 'local_llm_timeout':
      return '本地 LLM 回應逾時，已回退到規則整理。';
    case 'local_llm_provider_error':
      return '本地 LLM 執行失敗，已回退到規則整理。';
    case 'local_llm_invalid_response':
      return '本地 LLM 回傳格式無法解析，已回退到規則整理。';
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
  meetingViewState,
  modelStatus,
  onSave,
}: {
  settings: AppSettings;
  devices: Array<{ id: string; label: string; kind: string }>;
  viewState: ReturnType<typeof useCaptionState>;
  dictationViewState: ReturnType<typeof useDictationState>;
  meetingViewState: ReturnType<typeof useMeetingState>;
  modelStatus: ModelStatus | null;
  onSave: (partial: Partial<AppSettings>) => Promise<void>;
}) {
  const [activeSettingsTab, setActiveSettingsTab] = useState<'subtitle' | 'dictation' | 'meeting' | 'models'>('subtitle');
  const [draft, setDraft] = useState(settings);
  const inputDevices = devices.filter((d) => d.kind === 'input' || d.kind === 'duplex');
  const loopbackDevices = devices.filter((d) => d.kind === 'duplex');
  const [overlaySuppressedLocal, setOverlaySuppressedLocal] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [localModelStatus, setLocalModelStatus] = useState(modelStatus);
  const [meetingNotesResult, setMeetingNotesResult] = useState<MeetingNotesResult | null>(null);
  const [meetingNotesStatus, setMeetingNotesStatus] = useState<'idle' | 'generating' | 'ready' | 'error'>('idle');
  const [meetingNotesError, setMeetingNotesError] = useState<string | null>(null);
  const [meetingReportStatus, setMeetingReportStatus] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [meetingReportMessage, setMeetingReportMessage] = useState<string | null>(null);
  const [accessibilityPermission, setAccessibilityPermission] = useState<{ trusted: boolean; status: string } | null>(null);
  const [inputMonitoringPermission, setInputMonitoringPermission] = useState<{ trusted: boolean; available: boolean; detail?: string } | null>(null);
  const [hotkeyTestError, setHotkeyTestError] = useState<string | null>(null);
  const isStreaming = viewState.sessionState === 'streaming' || viewState.sessionState === 'connecting';
  const translationOn = isTranslationEnabled(draft);
  const hotkeyBinding: DictationHotkeyBinding = draft.dictationHotkey;
  const hotkeyValidation = validateDictationHotkey(hotkeyBinding);
  const localLlmEnabled = draft.dictationRewriteMode === 'rules-and-local-llm';
  const modelsReady = isStreamingModelReady(localModelStatus, draft.sttModel);
  const meetingModelsReady = isStreamingModelReady(localModelStatus, draft.meetingSttModel);
  const isDownloading = downloadProgress !== null;
  const subtitleModelEntries = MODEL_LIBRARY.map((entry) => ({
    ...entry,
    ready: isModelReady(localModelStatus, entry.key),
  }));

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
      <aside className="settings-sidebar">
        <div className="settings-tabbar settings-tabbar-sidebar">
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
          <button
            className={activeSettingsTab === 'meeting' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setActiveSettingsTab('meeting')}
          >
            會議字幕
          </button>
          <button
            className={activeSettingsTab === 'models' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setActiveSettingsTab('models')}
          >
            模型
          </button>
        </div>
      </aside>

      <section className="settings-main">
        <header className="settings-main-header">
          <h2 className="settings-main-title">
            {activeSettingsTab === 'subtitle'
              ? '雙語字幕'
              : activeSettingsTab === 'dictation'
                ? '語音輸入'
                : activeSettingsTab === 'meeting'
                  ? '會議字幕'
                  : '模型'}
          </h2>
        </header>

        <div className={`settings-scroll settings-grid settings-grid-${activeSettingsTab}`}>
        {activeSettingsTab === 'dictation' && (
        <div className="dictation-workspace settings-content-grid">
          <div className="dictation-flow-grid">
            <article className="dictation-section dictation-section-primary">
              <h3 className="dictation-section-title">啟動</h3>
              <div className="dictation-inline-grid">
                <label>
                  輸入裝置
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
                <label>
                  快捷鍵
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
              </div>
              <div className="settings-subgroup">
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
              <div className="settings-subgroup dictation-permission-card">
                <div className="dictation-permission-row">
                  <span className="dictation-permission-copy">Accessibility</span>
                  <strong className={accessibilityPermission?.trusted ? 'hotkey-permission-ok' : 'hotkey-permission-missing'}>
                    {getPermissionLabel(accessibilityPermission, 'accessibility')}
                  </strong>
                  {!accessibilityPermission?.trusted && (
                    <button
                      className="secondary"
                      onClick={async () => {
                        setHotkeyTestError(null);
                        try {
                          const granted = await window.app.requestAccessibilityPermission();
                          setAccessibilityPermission(granted);
                          if (!granted.trusted) {
                            await window.app.openAccessibilitySettings();
                            setHotkeyTestError('Accessibility 設定已開啟。允許後若仍無法使用，請重新開啟 app。');
                          }
                        } catch (error) {
                          setHotkeyTestError(error instanceof Error ? error.message : 'Failed to request Accessibility permission');
                        }
                      }}
                    >
                      前往授權
                    </button>
                  )}
                </div>
                <div className="dictation-permission-row">
                  <span className="dictation-permission-copy">Input Monitoring</span>
                  <strong className={inputMonitoringPermission?.trusted ? 'hotkey-permission-ok' : 'hotkey-permission-missing'}>
                    {getPermissionLabel(inputMonitoringPermission, 'input-monitoring')}
                  </strong>
                  {!inputMonitoringPermission?.trusted && (
                    <button
                      className="secondary"
                      onClick={async () => {
                        setHotkeyTestError(null);
                        try {
                          const granted = await ensureInputMonitoringPermission();
                          if (!granted) {
                            setHotkeyTestError('Input Monitoring 設定已開啟。允許後若仍無法使用，請重新開啟 app。');
                          }
                        } catch (error) {
                          setHotkeyTestError(error instanceof Error ? error.message : 'Failed to request Input Monitoring permission');
                        }
                      }}
                    >
                      前往授權
                    </button>
                  )}
                </div>
              </div>
              {inputMonitoringPermission?.detail && !inputMonitoringPermission.trusted && (
                <p className="error-text">{inputMonitoringPermission.detail}</p>
              )}
              {hotkeyValidation.error && <p className="error-text">{hotkeyValidation.error}</p>}
              {!hotkeyValidation.error && hotkeyValidation.warning && <p className="model-hint">{hotkeyValidation.warning}</p>}
              {hotkeyTestError && <p className="error-text">{hotkeyTestError}</p>}
            </article>

            <article className="dictation-section">
              <h3 className="dictation-section-title">輸出</h3>
              <div className="dictation-inline-grid">
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
                    <option value="zh-TW">繁體中文</option>
                    <option value="ja">日本語</option>
                    <option value="ko">한국어</option>
                  </select>
                </label>
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
              </div>
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
              <div className="settings-subgroup settings-subgroup-compact settings-toggle-stack">
                <label className="toggle-row settings-toggle-block">
                  <input
                    type="checkbox"
                    checked={localLlmEnabled}
                    onChange={(event) => setDraft({
                      ...draft,
                      dictationRewriteMode: event.target.checked ? 'rules-and-local-llm' : 'rules',
                      dictationCloudEnhancementEnabled: false,
                    })}
                  />
                  <span>
                    啟用本地 LLM 潤稿
                  </span>
                </label>
                <label className="toggle-row settings-toggle-block settings-toggle-compact">
                  <input
                    type="checkbox"
                    checked={draft.dictationDictionaryEnabled}
                    onChange={(event) => setDraft({ ...draft, dictationDictionaryEnabled: event.target.checked })}
                  />
                  <span>啟用自訂字典</span>
                </label>
              </div>
              <label>
                自訂字典
                <textarea
                  rows={3}
                  value={draft.dictationDictionaryText}
                  onChange={(event) => setDraft({ ...draft, dictationDictionaryText: event.target.value })}
                  placeholder={'spoken => canonical\nchat g p t => ChatGPT\nbicaption => BiCaption'}
                />
              </label>
              {draft.dictationOutputAction !== 'copy' && (
                <p className="model-hint">自動貼上需要 Accessibility 權限。</p>
              )}
            </article>
          </div>

          <div className="dictation-detail-stack">
            <article className="dictation-section">
              <h3 className="dictation-section-title">進階</h3>
              <div className="dictation-inline-grid">
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
              </div>
              {draft.dictationSttModel === 'apple-stt' && (
                <p className="model-hint">Apple STT 不支援多語自動判斷。</p>
              )}
            </article>
          </div>
        </div>
        )}

        {activeSettingsTab === 'subtitle' && (
        <div className="subtitle-workspace settings-content-grid">
          <div className="dictation-flow-grid">
            <article className="dictation-section dictation-section-primary">
              <h3 className="dictation-section-title">來源</h3>
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
              <div className="dictation-inline-grid">
                <label>
                  來源語言
                  <select value={draft.sourceLang} onChange={(event) => {
                    const lang = event.target.value;
                    const recommended = getRecommendedSubtitleSttModel(lang, draft.sttModel);
                    const nextDraft: AppSettings = {
                      ...draft,
                      sourceLang: lang,
                      sttModel: recommended,
                    };
                    if (isTranslationEnabled(draft) && draft.targetLang === draft.sourceLang) {
                      nextDraft.targetLang = getDefaultSubtitleTargetLang(lang);
                    }
                    setDraft(nextDraft);
                  }}>
                    <option value="auto">自動偵測</option>
                    <option value="en">English</option>
                    <option value="zh-TW">繁體中文</option>
                    <option value="ja">日本語</option>
                    <option value="ko">한국어</option>
                  </select>
                </label>
                <label>
                  目標語言
                  <select value={draft.targetLang} onChange={(event) => setDraft({ ...draft, targetLang: event.target.value })} disabled={!translationOn}>
                    <option value="zh-TW">繁體中文</option>
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                    <option value="ko">한국어</option>
                  </select>
                </label>
              </div>
              <div className="settings-subgroup settings-subgroup-compact settings-toggle-stack">
                <label className="toggle-row settings-toggle-block">
                  <input
                    type="checkbox"
                    checked={translationOn}
                    onChange={(event) => setDraft({
                      ...draft,
                      translateModel: event.target.checked ? 'google' : 'disabled',
                      targetLang: event.target.checked
                        ? (draft.targetLang === draft.sourceLang
                          ? getDefaultSubtitleTargetLang(draft.sourceLang)
                          : draft.targetLang)
                        : draft.targetLang,
                    })}
                  />
                  <span>
                    啟用雙語字幕
                  </span>
                </label>
                <label className="toggle-row settings-toggle-block">
                  <input
                    type="checkbox"
                    checked={!overlaySuppressedLocal}
                    onChange={(event) => {
                      const shouldShow = event.target.checked;
                      if (shouldShow) {
                        window.app.showOverlay();
                        setOverlaySuppressedLocal(false);
                      } else {
                        window.app.hideOverlay();
                        setOverlaySuppressedLocal(true);
                      }
                    }}
                  />
                  <span>
                    顯示字幕
                  </span>
                </label>
              </div>
              <div className="dictation-inline-grid">
                <label>
                  透明度
                  <input type="range" min="0.3" max="1" step="0.05" value={draft.overlayOpacity} onChange={(event) => setDraft({ ...draft, overlayOpacity: Number(event.target.value) })} />
                </label>
                <label>
                  字體大小
                  <input type="range" min="0.8" max="1.8" step="0.1" value={draft.overlayFontScale} onChange={(event) => setDraft({ ...draft, overlayFontScale: Number(event.target.value) })} />
                </label>
              </div>
            </article>
          </div>

          <div className="dictation-detail-stack">
            <article className="dictation-section">
              <h3 className="dictation-section-title">進階</h3>
              <label>
                語音辨識引擎
                <select
                  value={draft.sttModel}
                  onChange={(event) => {
                    const nextModel = event.target.value;
                    if (nextModel === 'moonshine') {
                      setDraft({
                        ...draft,
                        sttModel: 'moonshine',
                        sourceLang: 'en',
                        targetLang: isTranslationEnabled(draft) ? getDefaultSubtitleTargetLang('en') : draft.targetLang,
                      });
                      return;
                    }
                    setDraft({ ...draft, sttModel: nextModel });
                  }}
                >
                  <option value="moonshine">Moonshine（實驗性）</option>
                  <option value="apple-stt">SFSpeechRecognizer</option>
                  <option value="sensevoice">SenseVoice</option>
                </select>
              </label>
              {draft.sttModel === 'moonshine' && (
                <p className="model-hint">目前 Moonshine 先固定走英文串流辨識。切換到 Moonshine 時會自動把來源語言設成 English。</p>
              )}
              {draft.sttModel === 'apple-stt' && (
                <>
                  <label>
                    翻譯觸發延遲（{draft.partialStableMs}ms）
                    <input type="range" min="200" max="2000" step="100" value={draft.partialStableMs} onChange={(event) => setDraft({ ...draft, partialStableMs: Number(event.target.value) })} />
                  </label>
                  <p className="model-hint">Apple STT 不支援多語自動判斷。</p>
                </>
              )}
              <div className="settings-subgroup settings-subgroup-compact save-settings-stack">
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
              </div>
            </article>
          </div>
        </div>
        )}

        {activeSettingsTab === 'meeting' && (
          <div className="dictation-workspace settings-content-grid">
            <div className="dictation-flow-grid">
              <article className="dictation-section dictation-section-primary">
                <h3 className="dictation-section-title">來源</h3>
                <div className="dictation-inline-grid">
                  <label>
                    麥克風
                    <select
                      value={draft.meetingMicDeviceId}
                      onChange={(event) => setDraft({ ...draft, meetingMicDeviceId: event.target.value })}
                    >
                      {inputDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    系統音訊
                    <select
                      value={draft.meetingSystemAudioDeviceId}
                      onChange={(event) => setDraft({ ...draft, meetingSystemAudioDeviceId: event.target.value })}
                    >
                      <option value="">系統預設</option>
                      {loopbackDevices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="dictation-inline-grid">
                  <label>
                    收音模式
                    <select
                      value={draft.meetingSourceMode}
                      onChange={(event) => setDraft({ ...draft, meetingSourceMode: event.target.value as AppSettings['meetingSourceMode'] })}
                    >
                      <option value="dual">雙來源</option>
                      <option value="system-audio">只收系統音訊</option>
                      <option value="microphone">只收麥克風</option>
                    </select>
                  </label>
                  <label>
                    目標語言
                    <select
                      value={draft.meetingTargetLang}
                      onChange={(event) => setDraft({ ...draft, meetingTargetLang: event.target.value })}
                    >
                      <option value="zh-TW">繁體中文</option>
                      <option value="en">English</option>
                      <option value="ja">日本語</option>
                      <option value="ko">한국어</option>
                    </select>
                  </label>
                </div>
              </article>

              <article className="dictation-section">
                <h3 className="dictation-section-title">會議記錄</h3>
                <div className="settings-subgroup settings-subgroup-compact settings-toggle-stack">
                  <label className="toggle-row settings-toggle-block">
                    <input
                      type="checkbox"
                      checked={draft.meetingSpeakerLabelsEnabled}
                      onChange={(event) => setDraft({ ...draft, meetingSpeakerLabelsEnabled: event.target.checked })}
                    />
                    <span>辨識發言者標籤</span>
                  </label>
                  <label className="toggle-row settings-toggle-block settings-toggle-compact">
                    <input
                      type="checkbox"
                      checked={draft.meetingSaveTranscript}
                      onChange={(event) => setDraft({ ...draft, meetingSaveTranscript: event.target.checked })}
                    />
                    <span>保存會議逐字稿</span>
                  </label>
                </div>
                <div className="dictation-inline-grid">
                  <label>
                    我方標籤
                    <input
                      type="text"
                      value={draft.meetingMicrophoneLabel}
                      onChange={(event) => setDraft({ ...draft, meetingMicrophoneLabel: event.target.value })}
                      placeholder="我方"
                    />
                  </label>
                  <label>
                    遠端標籤
                    <input
                      type="text"
                      value={draft.meetingSystemLabel}
                      onChange={(event) => setDraft({ ...draft, meetingSystemLabel: event.target.value })}
                      placeholder="遠端"
                    />
                  </label>
                </div>
                <label>
                  預設會議記錄 Prompt
                  <textarea
                    rows={6}
                    value={draft.meetingNotesPrompt}
                    onChange={(event) => setDraft({ ...draft, meetingNotesPrompt: event.target.value })}
                  />
                </label>
                {draft.meetingSaveTranscript && (
                  <div className="settings-subgroup settings-subgroup-compact save-settings-stack">
                    <label className="toggle-row">
                      <span>逐字稿儲存位置</span>
                    </label>
                    <div className="save-path-row">
                      <span className="save-path-text">{draft.meetingTranscriptDirectory || '未設定'}</span>
                      <button
                        className="secondary"
                        onClick={async () => {
                          const dir = await window.app.chooseSaveDirectory();
                          if (dir) {
                            setDraft({ ...draft, meetingTranscriptDirectory: dir });
                          }
                        }}
                      >
                        選擇
                      </button>
                    </div>
                  </div>
                )}
                <div className="meeting-transcript-panel">
                  <div className="meeting-transcript-head">
                    <strong>即時逐字稿</strong>
                    <span className="meeting-transcript-status">
                      {meetingViewState.sessionState === 'streaming'
                        ? '會議進行中'
                        : meetingViewState.sessionState === 'connecting'
                          ? '準備中'
                          : '尚未開始'}
                    </span>
                  </div>
                  <div className="meeting-transcript-list">
                    {meetingViewState.entries.length === 0 && !meetingViewState.partial ? (
                      <p className="meeting-transcript-empty">開始會議字幕後，這裡會顯示即時逐字稿與翻譯。</p>
                    ) : (
                      <>
                        {meetingViewState.entries.map((entry) => (
                          <article key={entry.id} className="meeting-transcript-item">
                            <p className="meeting-transcript-translation">
                              {getMeetingSpeakerLabel(draft, entry.source, entry.speakerLabel)}
                            </p>
                            <p className="meeting-transcript-source">{entry.sourceText}</p>
                            {entry.translatedText ? (
                              <p className="meeting-transcript-translation">{entry.translatedText}</p>
                            ) : null}
                          </article>
                        ))}
                        {meetingViewState.partial ? (
                          <article className="meeting-transcript-item meeting-transcript-item-partial">
                            <p className="meeting-transcript-translation">
                              {getMeetingSpeakerLabel(draft, meetingViewState.partial.source, meetingViewState.partial.speakerLabel)}
                            </p>
                            <p className="meeting-transcript-source">{meetingViewState.partial.sourceText}</p>
                          </article>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
                <div className="meeting-transcript-panel">
                  <div className="meeting-transcript-head">
                    <strong>會議記錄預覽</strong>
                    <span className="meeting-transcript-status">
                      {meetingNotesStatus === 'generating'
                        ? '產生中'
                        : meetingNotesStatus === 'ready'
                          ? '已更新'
                          : meetingNotesStatus === 'error'
                            ? '產生失敗'
                            : '尚未產生'}
                    </span>
                  </div>
                  <div className="meeting-transcript-list">
                    {meetingNotesError ? (
                      <p className="meeting-transcript-empty">{meetingNotesError}</p>
                    ) : meetingNotesResult ? (
                      <article className="meeting-transcript-item">
                        <p className="meeting-transcript-source">{meetingNotesResult.summary}</p>
                        {meetingNotesResult.decisions.length > 0 ? (
                          <p className="meeting-transcript-translation">決策：{meetingNotesResult.decisions.join('；')}</p>
                        ) : null}
                        {meetingNotesResult.actionItems.length > 0 ? (
                          <p className="meeting-transcript-translation">待辦：{meetingNotesResult.actionItems.join('；')}</p>
                        ) : null}
                        {meetingNotesResult.risks.length > 0 ? (
                          <p className="meeting-transcript-translation">風險：{meetingNotesResult.risks.join('；')}</p>
                        ) : null}
                      </article>
                    ) : (
                      <p className="meeting-transcript-empty">停止會議後可直接用目前 prompt 產生會議記錄，並輸出到逐字稿同資料夾。</p>
                    )}
                  </div>
                  {meetingReportMessage ? (
                    <p className="meeting-transcript-empty">{meetingReportMessage}</p>
                  ) : null}
                </div>
              </article>
            </div>

            <div className="dictation-detail-stack">
              <article className="dictation-section">
                <h3 className="dictation-section-title">進階</h3>
                <div className="dictation-inline-grid">
                  <label>
                    串流辨識引擎
                    <select
                      value={draft.meetingSttModel}
                      onChange={(event) => setDraft({ ...draft, meetingSttModel: event.target.value })}
                    >
                      <option value="moonshine">Moonshine</option>
                      <option value="sensevoice">SenseVoice</option>
                      <option value="apple-stt">SFSpeechRecognizer</option>
                    </select>
                  </label>
                  <label>
                    翻譯引擎
                    <select
                      value={draft.meetingTranslateModel}
                      onChange={(event) => setDraft({ ...draft, meetingTranslateModel: event.target.value })}
                    >
                      <option value="google">Google Translate</option>
                      <option value="disabled">關閉翻譯</option>
                    </select>
                  </label>
                </div>
                <label>
                  來源語言
                  <select
                    value={draft.meetingSourceLang}
                    onChange={(event) => setDraft({ ...draft, meetingSourceLang: event.target.value })}
                  >
                    <option value="auto">自動偵測</option>
                    <option value="en">English</option>
                    <option value="zh-TW">繁體中文</option>
                    <option value="ja">日本語</option>
                    <option value="ko">한국어</option>
                  </select>
                </label>
                <p className="model-hint">目前先提供單 session 會議字幕骨架。speaker attribution、會議記錄生成與雙來源混流會在後續 milestone 補齊。</p>
              </article>
            </div>
          </div>
        )}

        {activeSettingsTab === 'models' && (
          <div className="models-workspace">
            <article className="dictation-section dictation-section-primary">
              <h3 className="dictation-section-title">模型庫</h3>
              <p className="model-hint">
                模型下載是整個 app 共用的資源。雙語字幕、語音輸入與會議字幕都會使用這裡的模型狀態。
              </p>
              {isDownloading && downloadProgress && (
                <div className="model-download-banner" role="status" aria-live="polite">
                  <div className="progress-bar-container">
                    <div className="progress-bar-fill" style={{ width: `${downloadProgress.percent}%` }} />
                  </div>
                  <p className="model-hint">{getDownloadLabel(downloadProgress)}</p>
                </div>
              )}
              {downloadError && <p className="error-text">{downloadError}</p>}
              <div className="model-catalog">
                {subtitleModelEntries.map(({ key, label, ready, sizeLabel, description }) => (
                  <section key={key} className="model-card">
                    <div className="model-card-head">
                      <div className="model-card-copy">
                        <h4>{label}</h4>
                        <p>{description}</p>
                      </div>
                      <span className={ready ? 'model-badge model-badge-ready' : 'model-badge'}>
                        {ready ? '已下載' : '尚未下載'}
                      </span>
                    </div>
                    <div className="model-card-meta">
                      <span>大小 {sizeLabel}</span>
                      {key === 'moonshine' && <span>目前走官方 moonshine-voice 套件與專案內 model cache</span>}
                      {key === 'sensevoice' && <span>推薦用於繁體中文與混語</span>}
                      {key === 'vad' && <span>字幕、語音輸入與會議字幕都需要</span>}
                    </div>
                    <div className="model-card-actions">
                      {key === 'moonshine' ? (
                        <button className="secondary" disabled>
                          啟用時自動準備
                        </button>
                      ) : !ready ? (
                        <button
                          className="secondary"
                          disabled={isDownloading}
                          onClick={() => window.app.downloadModel(key)}
                        >
                          下載
                        </button>
                      ) : (
                        <button
                          className="secondary"
                          disabled={isDownloading}
                          onClick={() => window.app.downloadModel(key)}
                        >
                          重新下載
                        </button>
                      )}
                    </div>
                  </section>
                ))}
              </div>
            </article>
          </div>
        )}
        </div>
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
        ) : activeSettingsTab === 'models' ? (
          <>
            <button
              disabled={isDownloading}
              onClick={() => window.app.downloadModels()}
            >
              {isDownloading ? '下載中' : '下載所有模型'}
            </button>
          </>
        ) : activeSettingsTab === 'meeting' ? (
          <>
            <button
              disabled={!meetingModelsReady}
              onClick={async () => {
                const nextSettings = {
                  ...draft,
                };
                await onSave(nextSettings);
                await window.app.startSession(buildSessionConfig(nextSettings, 'meeting'));
              }}
            >
              {!meetingModelsReady
                ? '需要下載模型'
                : meetingViewState.sessionState === 'streaming' || meetingViewState.sessionState === 'connecting'
                  ? '重新開始'
                  : '開始會議字幕'}
            </button>
            <button
              className="secondary"
              disabled={meetingViewState.sessionState !== 'streaming' && meetingViewState.sessionState !== 'connecting'}
              onClick={() => window.app.stopSession()}
            >
              停止
            </button>
            <button
              className="secondary"
              disabled={meetingNotesStatus === 'generating'}
              onClick={async () => {
                try {
                  setMeetingNotesStatus('generating');
                  setMeetingNotesError(null);
                  const result = await window.app.generateMeetingNotes({
                    transcriptId: meetingViewState.activeSessionId ?? 'latest',
                    targetLang: draft.meetingTargetLang,
                    promptTemplate: draft.meetingNotesPrompt,
                    includeActionItems: true,
                    includeRisks: true,
                    includeSpeakerNames: draft.meetingSpeakerLabelsEnabled,
                    transcriptText: meetingViewState.entries.map((entry) => {
                      const speakerLabel = getMeetingSpeakerLabel(draft, entry.source, entry.speakerLabel);
                      const translated = entry.translatedText ? `\n> ${entry.translatedText}` : '';
                      return `## ${speakerLabel}\n${entry.sourceText}${translated}`;
                    }).join('\n\n'),
                  });
                  setMeetingNotesResult(result);
                  setMeetingNotesStatus('ready');
                } catch (error) {
                  setMeetingNotesStatus('error');
                  setMeetingNotesError(error instanceof Error ? error.message : 'Failed to generate meeting notes.');
                }
              }}
            >
              {meetingNotesStatus === 'generating' ? '產生中…' : '產生會議記錄'}
            </button>
            <button
              className="secondary"
              disabled={meetingReportStatus === 'exporting'}
              onClick={async () => {
                try {
                  setMeetingReportStatus('exporting');
                  const transcriptText = meetingViewState.entries.map((entry) => {
                    const speakerLabel = getMeetingSpeakerLabel(draft, entry.source, entry.speakerLabel);
                    const translated = entry.translatedText ? `\n> ${entry.translatedText}` : '';
                    return `## ${speakerLabel}\n${entry.sourceText}${translated}`;
                  }).join('\n\n');
                  const result = await window.app.exportMeetingReport({
                    transcriptId: meetingViewState.activeSessionId ?? 'latest',
                    transcriptText,
                    notes: meetingNotesResult,
                    title: 'BiCaption Meeting Report',
                  });
                  setMeetingReportStatus('done');
                  setMeetingReportMessage(`已匯出 HTML 報告：${result.path}`);
                } catch (error) {
                  setMeetingReportStatus('error');
                  setMeetingReportMessage(error instanceof Error ? error.message : 'Failed to export meeting report.');
                }
              }}
            >
              {meetingReportStatus === 'exporting' ? '匯出中…' : '匯出 HTML 報告'}
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
      </section>
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
  const meetingState = useMeetingState();
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
      if (!loadedSettings.meetingMicDeviceId || !inputDeviceIds.has(loadedSettings.meetingMicDeviceId)) {
        loadedSettings = { ...loadedSettings, meetingMicDeviceId: preferred?.id ?? '' };
      }
      if (loadedSettings.outputDeviceId && !outputDeviceIds.has(loadedSettings.outputDeviceId)) {
        loadedSettings = { ...loadedSettings, outputDeviceId: '' };
      }
      if (loadedSettings.meetingSystemAudioDeviceId && !outputDeviceIds.has(loadedSettings.meetingSystemAudioDeviceId)) {
        loadedSettings = { ...loadedSettings, meetingSystemAudioDeviceId: '' };
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

  return <SettingsView settings={settings} devices={devices} viewState={captionState} dictationViewState={dictationState} meetingViewState={meetingState} modelStatus={modelStatus} onSave={onSave} />;
}
