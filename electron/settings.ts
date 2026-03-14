import Store from 'electron-store';
import type { AppSettings } from './types.js';

export const defaultSettings: AppSettings = {
  deviceId: 'blackhole',
  sourceLang: 'en',
  targetLang: 'zh-TW',
  sttModel: 'small',
  translateModel: 'marian-en-zh',
  chunkMs: 1800,
  overlayOpacity: 0.9,
  overlayFontScale: 1,
  overlayPosition: 'bottom',
};

const store = new Store<AppSettings>({
  name: 'settings',
  defaults: defaultSettings,
});

export function loadSettings(): AppSettings {
  return {
    ...defaultSettings,
    ...store.store,
  };
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  store.set(partial);
  return loadSettings();
}
