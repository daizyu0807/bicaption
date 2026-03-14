import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, CaptionConfig, SidecarEvent } from './types.js';

type Unsubscribe = () => void;

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('app', {
  loadSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:load'),
  saveSettings: (partial: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', partial),
  startSession: (config: CaptionConfig) => ipcRenderer.invoke('session:start', config),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  listDevices: (): Promise<Array<{ id: string; label: string }>> => ipcRenderer.invoke('session:devices'),
  showSettings: () => ipcRenderer.invoke('app:show-settings'),
  subscribe: (eventName: 'sidecar:event' | 'settings:changed', handler: (payload: SidecarEvent | AppSettings) => void) =>
    on(eventName, handler),
});
