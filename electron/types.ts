export type SessionState = 'idle' | 'connecting' | 'streaming' | 'error' | 'stopped';
export type SessionMode = 'subtitle' | 'dictation';
export type DictationOutputAction = 'copy' | 'paste' | 'copy-and-paste';

export interface DictationHotkeyBinding {
  keyCode: number;
  modifiers: string[];
}

export interface DictationHotkeyEvent {
  type: 'listener_ready' | 'hotkey_down' | 'hotkey_up' | 'permission_status' | 'error' | 'listener_stopped';
  keyCode?: number;
  modifiers?: Record<string, boolean>;
  trusted?: boolean;
  message?: string;
}

export interface CaptionConfig {
  mode: SessionMode;
  sessionId: string;
  deviceId: string;
  outputDeviceId: string;
  sourceLang: string;
  targetLang: string;
  sttModel: string;
  translateModel: string;
  chunkMs: number;
  partialStableMs: number;
  beamSize: number;
  bestOf: number;
  vadFilter: boolean;
  conditionOnPrev: boolean;
}

interface SessionScopedEvent {
  mode: SessionMode;
  sessionId: string;
}

export interface PartialCaptionEvent extends SessionScopedEvent {
  type: 'partial_caption';
  segmentId: string;
  sourceText: string;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface FinalCaptionEvent extends SessionScopedEvent {
  type: 'final_caption';
  segmentId: string;
  sourceText: string;
  translatedText: string;
  startedAtMs: number;
  endedAtMs: number;
  latencyMs: number;
  confidence?: number;
  detectedLang?: string;
}

export interface MetricsEvent extends SessionScopedEvent {
  type: 'metrics';
  inputLevel: number;
  processingLagMs: number;
  queueDepth: number;
}

export interface SessionStateEvent extends SessionScopedEvent {
  type: 'session_state';
  state: SessionState;
  detail?: string;
}

export interface DictationStateEvent extends SessionScopedEvent {
  type: 'dictation_state';
  state: 'idle' | 'recording' | 'capturing' | 'processing' | 'done' | 'stopped' | 'error';
  detail?: string;
}

export interface DictationFinalEvent extends SessionScopedEvent {
  type: 'dictation_final';
  text: string;
  chunkCount?: number;
  startedAtMs: number;
  endedAtMs: number;
  latencyMs: number;
}

export interface SessionStoppedAckEvent extends SessionScopedEvent {
  type: 'session_stopped_ack';
}

export interface ErrorEvent extends SessionScopedEvent {
  type: 'error';
  code: string;
  message: string;
  recoverable: boolean;
}

export type SidecarEvent =
  | PartialCaptionEvent
  | FinalCaptionEvent
  | MetricsEvent
  | SessionStateEvent
  | DictationStateEvent
  | DictationFinalEvent
  | SessionStoppedAckEvent
  | ErrorEvent;

export interface CaptionRecord {
  segmentId: string;
  sourceText: string;
  translatedText?: string;
  startedAtMs: number;
  endedAtMs?: number;
  isFinal: boolean;
}

export interface AppSettings {
  deviceId: string;
  outputDeviceId: string;
  sourceLang: string;
  targetLang: string;
  sttModel: string;
  translateModel: string;
  chunkMs: number;
  partialStableMs: number;
  beamSize: number;
  bestOf: number;
  vadFilter: boolean;
  conditionOnPrev: boolean;
  dictationOutputAction: DictationOutputAction;
  saveEnabled: boolean;
  saveDirectory: string;
  overlayOpacity: number;
  overlayFontScale: number;
  overlayPosition: 'top' | 'bottom';
  overlayX: number;
  overlayY: number;
  overlayWidth: number;
  overlayHeight: number;
}

export interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ModelStatus {
  sensevoice: boolean;
  whisperTinyEn: boolean;
  whisperSmall: boolean;
  zipformerKo: boolean;
  vad: boolean;
  ready: boolean;
}

export interface ModelDownloadProgress {
  stage: 'sensevoice' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad' | 'extracting';
  percent: number;
  downloadedMB: number;
  totalMB: number;
}
