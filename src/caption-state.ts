import type { CSSProperties } from 'react';
import type { AppSettings, CaptionRecord, SidecarEvent } from '../electron/types.js';

export interface CaptionViewState {
  captions: CaptionRecord[];
  partial: CaptionRecord | null;
  sessionState: string;
  activeSessionId: string | null;
  metrics: {
    inputLevel: number;
    processingLagMs: number;
    queueDepth: number;
  };
  lastError: string | null;
}

export const initialViewState: CaptionViewState = {
  captions: [],
  partial: null,
  sessionState: 'idle',
  activeSessionId: null,
  metrics: {
    inputLevel: 0,
    processingLagMs: 0,
    queueDepth: 0,
  },
  lastError: null,
};

export function reduceSidecarEvent(state: CaptionViewState, event: SidecarEvent): CaptionViewState {
  if (event.mode !== 'subtitle') {
    return state;
  }

  switch (event.type) {
    case 'partial_caption':
      if (!state.activeSessionId || event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        partial: {
          segmentId: event.segmentId,
          sourceText: event.sourceText,
          startedAtMs: event.startedAtMs,
          endedAtMs: event.updatedAtMs,
          isFinal: false,
        },
      };
    case 'final_caption': {
      if (!state.activeSessionId || event.sessionId !== state.activeSessionId) {
        return state;
      }
      // When the first final_caption arrives (translatedText=""), preserve
      // any existing translation so subtitles don't flicker between the
      // initial emit and the translation-worker emit.
      const existing = state.captions.find((c) => c.segmentId === event.segmentId);
      const translatedText = event.translatedText || existing?.translatedText || '';
      return {
        ...state,
        partial: state.partial?.segmentId === event.segmentId ? null : state.partial,
        captions: [
          ...state.captions.filter((caption) => caption.segmentId !== event.segmentId),
          {
            segmentId: event.segmentId,
            sourceText: event.sourceText,
            translatedText,
            startedAtMs: event.startedAtMs,
            endedAtMs: event.endedAtMs,
            isFinal: true,
          },
        ],
      };
    }
    case 'metrics':
      if (!state.activeSessionId || event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        metrics: {
          inputLevel: event.inputLevel,
          processingLagMs: event.processingLagMs,
          queueDepth: event.queueDepth,
        },
      };
    case 'session_state':
      if (event.state === 'connecting') {
        return {
          ...state,
          captions: [],
          partial: null,
          activeSessionId: event.sessionId,
          sessionState: event.state,
          lastError: null,
        };
      }
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        sessionState: event.state,
        lastError: event.state === 'error' ? event.detail ?? 'Unknown error' : state.lastError,
      };
    case 'session_stopped_ack':
    case 'dictation_state':
    case 'dictation_final':
    case 'meeting_caption':
      return state;
    case 'error':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        lastError: event.message,
        sessionState: event.recoverable ? state.sessionState : 'error',
      };
    default:
      return state;
  }
}

export function applySettingsOverlayStyle(settings: AppSettings): CSSProperties {
  return {
    opacity: settings.overlayOpacity,
    fontSize: `${settings.overlayFontScale}rem`,
    justifyContent: settings.overlayPosition === 'top' ? 'flex-start' : 'flex-end',
  };
}
