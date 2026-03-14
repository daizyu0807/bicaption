import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarBridge } from './sidecar.js';
import { loadSettings, saveSettings } from './settings.js';
import type { CaptionConfig, SidecarEvent } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const rendererEntry = process.env.VITE_DEV_SERVER_URL ?? `file://${join(__dirname, '../renderer/index.html')}`;
const preloadPath = join(__dirname, 'preload.js');

let settingsWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

const bridge = new SidecarBridge();

function sendToWindows(channel: string, payload: unknown) {
  settingsWindow?.webContents.send(channel, payload);
  overlayWindow?.webContents.send(channel, payload);
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Realtime Bilingual Subtitles',
    webPreferences: {
      preload: preloadPath,
    },
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  void settingsWindow.loadURL(rendererEntry);
  if (isDev) {
    settingsWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createOverlayWindow() {
  const primary = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    width: 900,
    height: 220,
    x: Math.round((primary.workArea.width - 900) / 2),
    y: primary.workArea.height - 260,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: preloadPath,
    },
  });
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  void overlayWindow.loadURL(`${rendererEntry}#overlay`);
}

function bindBridge() {
  const forwardEvent = (event: SidecarEvent) => sendToWindows('sidecar:event', event);
  bridge.on('partial_caption', forwardEvent);
  bridge.on('final_caption', forwardEvent);
  bridge.on('metrics', forwardEvent);
  bridge.on('session_state', forwardEvent);
  bridge.on('error', forwardEvent);
  bridge.start();
}

app.whenReady().then(() => {
  createSettingsWindow();
  createOverlayWindow();
  bindBridge();

  ipcMain.handle('settings:load', () => loadSettings());
  ipcMain.handle('settings:save', (_event, partial) => {
    const settings = saveSettings(partial);
    sendToWindows('settings:changed', settings);
    return settings;
  });
  ipcMain.handle('session:start', (_event, config: CaptionConfig) => {
    bridge.startSession(config);
    return { ok: true };
  });
  ipcMain.handle('session:stop', () => {
    bridge.stopSession();
    return { ok: true };
  });
  ipcMain.handle('session:devices', () => {
    return [
      { id: 'blackhole', label: 'BlackHole 2ch' },
      { id: 'default', label: 'System Default' },
    ];
  });
  ipcMain.handle('app:show-settings', () => {
    settingsWindow?.show();
    settingsWindow?.focus();
    return { ok: true };
  });
});

app.on('window-all-closed', () => {
  bridge.dispose();
  app.quit();
});
