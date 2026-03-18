const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('app', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  startSession: (config) => ipcRenderer.invoke('session:start', config),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  listDevices: () => ipcRenderer.invoke('session:devices'),
  showSettings: () => ipcRenderer.invoke('app:show-settings'),
  getOverlayPosition: () => ipcRenderer.invoke('overlay:get-position'),
  setOverlayPosition: (x, y) => ipcRenderer.invoke('overlay:set-position', x, y),
  getOverlayBounds: () => ipcRenderer.invoke('overlay:get-bounds'),
  setOverlayBounds: (bounds) => ipcRenderer.invoke('overlay:set-bounds', bounds),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  chooseSaveDirectory: () => ipcRenderer.invoke('save:choose-directory'),
  openSaveDirectory: () => ipcRenderer.invoke('save:open-directory'),
  checkModels: () => ipcRenderer.invoke('models:check'),
  downloadModels: () => ipcRenderer.invoke('models:download'),
  downloadModel: (modelKey) => ipcRenderer.invoke('models:download-one', modelKey),
  checkAccessibilityPermission: () => ipcRenderer.invoke('permissions:check-accessibility'),
  checkInputMonitoringPermission: () => ipcRenderer.invoke('permissions:check-input-monitoring'),
  requestInputMonitoringPermission: () => ipcRenderer.invoke('permissions:request-input-monitoring'),
  openInputMonitoringSettings: () => ipcRenderer.invoke('permissions:open-input-monitoring'),
  testDictationHotkey: (binding) => ipcRenderer.invoke('dictation:test-hotkey', binding),
  stopDictationHotkeyTest: () => ipcRenderer.invoke('dictation:stop-hotkey-test'),
  subscribe: (eventName, handler) => on(eventName, handler),
});
