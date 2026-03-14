export type SessionState = 'idle' | 'connecting' | 'streaming' | 'error' | 'stopped';

export interface CaptionConfig {
  deviceId: string;
  sourceLang: string;
  targetLang: string;
  sttModel: string;
  translateModel: string;
  chunkMs: number;
  beamSize: number;
  bestOf: number;
  vadFilter: boolean;
  conditionOnPrev: boolean;
}

export interface PartialCaptionEvent {
  type: 'partial_caption';
  segmentId: string;
  sourceText: string;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface FinalCaptionEvent {
  type: 'final_caption';
  segmentId: string;
  sourceText: string;
  translatedText: string;
  startedAtMs: number;
  endedAtMs: number;
  latencyMs: number;
  confidence?: number;
}

export interface MetricsEvent {
  type: 'metrics';
  inputLevel: number;
  processingLagMs: number;
  queueDepth: number;
}

export interface SessionStateEvent {
  type: 'session_state';
  state: SessionState;
  detail?: string;
}

export interface ErrorEvent {
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
  sourceLang: string;
  targetLang: string;
  sttModel: string;
  translateModel: string;
  chunkMs: number;
  beamSize: number;
  bestOf: number;
  vadFilter: boolean;
  conditionOnPrev: boolean;
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
