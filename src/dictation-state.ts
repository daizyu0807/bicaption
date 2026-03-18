import type { SidecarEvent } from '../electron/types.js';

export interface DictationViewState {
  sessionState: string;
  dictationState: string;
  activeSessionId: string | null;
  detail: string | null;
  finalText: string;
  finalLatencyMs: number | null;
  finalChunkCount: number | null;
  lastError: string | null;
}

export const initialDictationViewState: DictationViewState = {
  sessionState: 'idle',
  dictationState: 'idle',
  activeSessionId: null,
  detail: null,
  finalText: '',
  finalLatencyMs: null,
  finalChunkCount: null,
  lastError: null,
};

export function reduceDictationEvent(state: DictationViewState, event: SidecarEvent): DictationViewState {
  if (event.mode !== 'dictation') {
    return state;
  }

  switch (event.type) {
    case 'session_state':
      if (event.state === 'connecting') {
        return {
          ...state,
          sessionState: event.state,
          dictationState: 'idle',
          activeSessionId: event.sessionId,
          detail: event.detail ?? null,
          finalText: '',
          finalLatencyMs: null,
          finalChunkCount: null,
          lastError: null,
        };
      }
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        sessionState: event.state,
        detail: event.detail ?? state.detail,
        lastError: event.state === 'error' ? event.detail ?? 'Unknown error' : state.lastError,
      };
    case 'dictation_state':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        activeSessionId: state.activeSessionId ?? event.sessionId,
        dictationState: event.state,
        detail: event.detail ?? state.detail,
      };
    case 'dictation_final':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        activeSessionId: state.activeSessionId ?? event.sessionId,
        dictationState: state.dictationState === 'error' ? state.dictationState : 'done',
        detail: state.detail,
        finalText: event.text,
        finalLatencyMs: event.latencyMs,
        finalChunkCount: event.chunkCount ?? null,
      };
    case 'session_stopped_ack':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        sessionState: 'stopped',
      };
    case 'error':
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) {
        return state;
      }
      return {
        ...state,
        activeSessionId: state.activeSessionId ?? event.sessionId,
        dictationState: 'error',
        lastError: event.message,
      };
    case 'partial_caption':
    case 'final_caption':
    case 'metrics':
      return state;
  }
}
