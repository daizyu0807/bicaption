import Store from 'electron-store';
import type { AppSettings } from './types.js';

export const defaultSettings: AppSettings = {
  deviceId: '',
  subtitleDeviceId: '',
  dictationDeviceId: '',
  outputDeviceId: '',
  dictationSttModel: 'apple-stt',
  dictationHotkey: {
    keyCode: 59,
    modifiers: [],
  },
  sourceLang: 'zh',
  targetLang: 'zh-TW',
  sttModel: 'apple-stt',
  translateModel: 'disabled',
  chunkMs: 400,
  partialStableMs: 500,
  beamSize: 1,
  bestOf: 1,
  vadFilter: false,
  conditionOnPrev: false,
  dictationOutputAction: 'copy',
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
  };
  return current;
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  store.set(partial);
  return loadSettings();
}
