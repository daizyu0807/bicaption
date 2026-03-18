import test from 'node:test';
import assert from 'node:assert/strict';
import { getDictationHotkeyLabel, validateDictationHotkey } from '../src/dictation-hotkey.js';

test('dictation hotkey label formats supported keys', () => {
  assert.equal(getDictationHotkeyLabel({ keyCode: 49, modifiers: ['cmd', 'shift'] }), 'Cmd+Shift+Space');
  assert.equal(getDictationHotkeyLabel({ keyCode: 36, modifiers: ['ctrl'] }), 'Ctrl+Return');
});

test('dictation hotkey validation requires at least one modifier', () => {
  const result = validateDictationHotkey({ keyCode: 49, modifiers: [] });
  assert.equal(result.isValid, false);
  assert.match(result.error ?? '', /at least one modifier/i);
});

test('dictation hotkey validation warns on known conflicts', () => {
  const result = validateDictationHotkey({ keyCode: 49, modifiers: ['cmd'] });
  assert.equal(result.isValid, true);
  assert.match(result.warning ?? '', /Spotlight/);
});
