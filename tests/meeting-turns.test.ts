import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetingTurns } from '../src/meeting-turns.js';

test('buildMeetingTurns merges consecutive entries with the same turn id', () => {
  const turns = buildMeetingTurns([
    {
      id: 'seg-1',
      turnId: 'turn-1',
      speakerId: 'microphone',
      speakerLabel: 'Dave',
      speakerKind: 'verified-local',
      source: 'microphone',
      sourceText: 'hello',
      translatedText: '你好',
      startedAtMs: 10,
      endedAtMs: 20,
      isFinal: true,
    },
    {
      id: 'seg-2',
      turnId: 'turn-1',
      speakerId: 'microphone',
      speakerLabel: 'Dave',
      speakerKind: 'verified-local',
      source: 'microphone',
      sourceText: 'team',
      translatedText: '團隊',
      startedAtMs: 21,
      endedAtMs: 30,
      isFinal: true,
    },
    {
      id: 'seg-3',
      turnId: 'turn-2',
      speakerId: 'system',
      speakerLabel: 'Client',
      speakerKind: 'remote-default',
      source: 'system',
      sourceText: 'thanks',
      translatedText: '謝謝',
      startedAtMs: 40,
      endedAtMs: 55,
      isFinal: true,
    },
  ]);

  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0]?.segmentIds, ['seg-1', 'seg-2']);
  assert.equal(turns[0]?.sourceText, 'hello team');
  assert.equal(turns[0]?.translatedText, '你好 團隊');
  assert.equal(turns[1]?.id, 'turn-2');
});
