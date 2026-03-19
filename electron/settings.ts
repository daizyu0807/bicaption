import Store from 'electron-store';
import type { AppSettings } from './types.js';

function normalizeDictationRewriteMode(mode: AppSettings['dictationRewriteMode'] | undefined): AppSettings['dictationRewriteMode'] {
  if (mode === 'rules-and-local-llm') {
    return mode;
  }
  return 'rules';
}

export const defaultSettings: AppSettings = {
  deviceId: '',
  subtitleDeviceId: '',
  dictationDeviceId: '',
  outputDeviceId: '',
  dictationSttModel: 'apple-stt',
  dictationSourceLang: 'zh',
  dictationHotkey: {
    keyCode: 59,
    modifiers: [],
  },
  sourceLang: 'zh',
  targetLang: 'zh-TW',
  sttModel: 'apple-stt',
  translateModel: 'disabled',
  subtitleChunkMs: 400,
  subtitlePartialStableMs: 500,
  subtitleVadMode: 'aggressive',
  dictationChunkMs: 400,
  dictationEndpointMs: 1200,
  dictationVadMode: 'conservative',
  chunkMs: 400,
  partialStableMs: 500,
  beamSize: 1,
  bestOf: 1,
  vadFilter: false,
  conditionOnPrev: false,
  dictationOutputAction: 'copy',
  dictationRewriteMode: 'rules',
  dictationDictionaryEnabled: true,
  dictationCloudEnhancementEnabled: false,
  dictationOutputStyle: 'polished',
  dictationMaxRewriteExpansionRatio: 1.3,
  dictationDictionaryText: '',
  dictationLocalLlmModel: 'mlx-community/Qwen2.5-0.5B-Instruct-4bit',
  dictationLocalLlmRunner: '',
  saveEnabled: false,
  saveDirectory: '',
  overlayOpacity: 0.9,
  overlayFontScale: 1,
  overlayPosition: 'bottom',
  overlayX: 0,
  overlayY: 0,
  overlayWidth: 900,
  overlayHeight: 220,
};

const store = new Store<AppSettings>({
  name: 'settings',
  defaults: defaultSettings,
});

export function loadSettings(): AppSettings {
  const stored = store.store as Partial<AppSettings> & { deviceId?: string };
  const legacyDeviceId = stored.deviceId ?? '';
  const current = {
    ...defaultSettings,
    ...stored,
    subtitleDeviceId: stored.subtitleDeviceId ?? legacyDeviceId ?? '',
    dictationDeviceId: stored.dictationDeviceId ?? legacyDeviceId ?? '',
    dictationSourceLang: stored.dictationSourceLang ?? stored.sourceLang ?? defaultSettings.dictationSourceLang,
    subtitleChunkMs: stored.subtitleChunkMs ?? stored.chunkMs ?? defaultSettings.subtitleChunkMs,
    subtitlePartialStableMs: stored.subtitlePartialStableMs ?? stored.partialStableMs ?? defaultSettings.subtitlePartialStableMs,
    dictationChunkMs: stored.dictationChunkMs ?? stored.chunkMs ?? defaultSettings.dictationChunkMs,
    dictationRewriteMode: normalizeDictationRewriteMode(stored.dictationRewriteMode),
    dictationCloudEnhancementEnabled: false,
  };
  return current;
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  store.set(partial);
  return loadSettings();
}
