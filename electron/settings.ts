import Store from 'electron-store';
import type { AppSettings } from './types.js';

export const defaultSettings: AppSettings = {
  deviceId: 'blackhole',
  sourceLang: 'en',
  targetLang: 'zh-TW',
  sttModel: 'tiny',
  translateModel: 'disabled',
  chunkMs: 900,
  beamSize: 1,
  bestOf: 1,
  vadFilter: false,
  conditionOnPrev: false,
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
  const current = {
    ...defaultSettings,
    ...store.store,
  };
  return current;
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  store.set(partial);
  return loadSettings();
}
