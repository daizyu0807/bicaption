import type { DictationHotkeyBinding } from '../electron/types.js';

export interface DictationHotkeyValidation {
  isValid: boolean;
  error: string | null;
  warning: string | null;
}

function normalizeModifiers(binding: DictationHotkeyBinding) {
  return [...new Set(binding.modifiers)].sort().join('+');
}

export function getDictationHotkeyLabel(binding: DictationHotkeyBinding) {
  const modifierLabels = binding.modifiers.map((modifier) => {
    switch (modifier) {
      case 'cmd':
        return 'Cmd';
      case 'shift':
        return 'Shift';
      case 'ctrl':
        return 'Ctrl';
      case 'alt':
        return 'Option';
      default:
        return modifier;
    }
  });
  const keyLabel = binding.keyCode === 49 ? 'Space' : binding.keyCode === 36 ? 'Return' : `KeyCode ${binding.keyCode}`;
  return [...modifierLabels, keyLabel].join('+');
}

export function validateDictationHotkey(binding: DictationHotkeyBinding): DictationHotkeyValidation {
  if (!binding.keyCode) {
    return {
      isValid: false,
      error: 'Dictation hotkey needs a non-modifier key.',
      warning: null,
    };
  }

  if (binding.modifiers.length === 0) {
    return {
      isValid: false,
      error: 'Dictation hotkey needs at least one modifier key.',
      warning: null,
    };
  }

  const combo = `${normalizeModifiers(binding)}:${binding.keyCode}`;
  const warningMap: Record<string, string> = {
    'cmd:49': 'Cmd+Space commonly conflicts with Spotlight.',
    'cmd:36': 'Cmd+Return often conflicts with send shortcuts in chat apps.',
    'cmd:48': 'Cmd+Tab commonly conflicts with app switching.',
    'cmd:12': 'Cmd+Q commonly conflicts with quit.',
    'cmd:13': 'Cmd+W commonly conflicts with close window.',
  };

  return {
    isValid: true,
    error: null,
    warning: warningMap[combo] ?? null,
  };
}
