import type { CSSProperties } from 'react';
import type { AppSettings, CaptionRecord, SidecarEvent } from '../electron/types.js';

export interface CaptionViewState {
  captions: CaptionRecord[];
  partial: CaptionRecord | null;
  sessionState: string;
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
  metrics: {
    inputLevel: 0,
    processingLagMs: 0,
    queueDepth: 0,
  },
  lastError: null,
};

export function reduceSidecarEvent(state: CaptionViewState, event: SidecarEvent): CaptionViewState {
  switch (event.type) {
    case 'partial_caption':
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
    case 'final_caption':
      return {
        ...state,
        partial: state.partial?.segmentId === event.segmentId ? null : state.partial,
        captions: [
          ...state.captions.filter((caption) => caption.segmentId !== event.segmentId),
          {
            segmentId: event.segmentId,
            sourceText: event.sourceText,
            translatedText: event.translatedText,
            startedAtMs: event.startedAtMs,
            endedAtMs: event.endedAtMs,
            isFinal: true,
          },
        ],
      };
    case 'metrics':
      return {
        ...state,
        metrics: {
          inputLevel: event.inputLevel,
          processingLagMs: event.processingLagMs,
          queueDepth: event.queueDepth,
        },
      };
    case 'session_state':
      return {
        ...state,
        sessionState: event.state,
        lastError: event.state === 'error' ? event.detail ?? 'Unknown error' : state.lastError,
      };
    case 'error':
      return {
        ...state,
        lastError: event.message,
        sessionState: event.recoverable ? state.sessionState : 'error',
      };
  }
}

export function applySettingsOverlayStyle(settings: AppSettings): CSSProperties {
  return {
    opacity: settings.overlayOpacity,
    fontSize: `${settings.overlayFontScale}rem`,
    justifyContent: settings.overlayPosition === 'top' ? 'flex-start' : 'flex-end',
  };
}
