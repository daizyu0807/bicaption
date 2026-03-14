import test from 'node:test';
import assert from 'node:assert/strict';
import { initialViewState, reduceSidecarEvent } from '../src/caption-state.js';

test('partial captions replace current partial state', () => {
  const state = reduceSidecarEvent(initialViewState, {
    type: 'partial_caption',
    segmentId: 'seg-1',
    sourceText: 'Hello',
    startedAtMs: 1,
    updatedAtMs: 2,
  });

  assert.equal(state.partial?.sourceText, 'Hello');
  assert.equal(state.captions.length, 0);
});

test('final captions are retained and clear matching partial', () => {
  const withPartial = reduceSidecarEvent(initialViewState, {
    type: 'partial_caption',
    segmentId: 'seg-1',
    sourceText: 'Hel',
    startedAtMs: 1,
    updatedAtMs: 2,
  });
  const state = reduceSidecarEvent(withPartial, {
    type: 'final_caption',
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
