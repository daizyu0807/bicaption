import test from 'node:test';
import assert from 'node:assert/strict';
import { initialViewState, reduceSidecarEvent } from '../src/caption-state.js';

test('partial captions replace current partial state', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const state = reduceSidecarEvent(connected, {
    type: 'partial_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-1',
    sourceText: 'Hello',
    startedAtMs: 1,
    updatedAtMs: 2,
  });

  assert.equal(state.partial?.sourceText, 'Hello');
  assert.equal(state.captions.length, 0);
});

test('final captions are retained and clear matching partial', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const withPartial = reduceSidecarEvent(connected, {
    type: 'partial_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-1',
    sourceText: 'Hel',
    startedAtMs: 1,
    updatedAtMs: 2,
  });
  const state = reduceSidecarEvent(withPartial, {
    type: 'final_caption',
    mode: 'subtitle',
    sessionId: 'session-1',
    segmentId: 'seg-1',
    sourceText: 'Hello',
    translatedText: '你好',
    startedAtMs: 1,
    endedAtMs: 3,
    latencyMs: 1200,
  });

  assert.equal(state.partial, null);
  assert.equal(state.captions[0]?.translatedText, '你好');
});

test('non-subtitle events are ignored by caption reducer', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const state = reduceSidecarEvent(connected, {
    type: 'final_caption',
    mode: 'dictation',
    sessionId: 'session-2',
    segmentId: 'seg-1',
    sourceText: 'Hello',
    translatedText: '',
    startedAtMs: 1,
    endedAtMs: 2,
    latencyMs: 1,
  });

  assert.deepEqual(state, connected);
});

test('dictation events are ignored by subtitle caption reducer', () => {
  const connected = reduceSidecarEvent(initialViewState, {
    type: 'session_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'connecting',
  });
  const afterState = reduceSidecarEvent(connected, {
    type: 'dictation_state',
    mode: 'subtitle',
    sessionId: 'session-1',
    state: 'recording',
  });
  const afterFinal = reduceSidecarEvent(afterState, {
    type: 'dictation_final',
    mode: 'subtitle',
    sessionId: 'session-1',
    text: 'Hello',
    startedAtMs: 1,
    endedAtMs: 2,
    latencyMs: 1,
  });

  assert.deepEqual(afterState, connected);
  assert.deepEqual(afterFinal, connected);
});
