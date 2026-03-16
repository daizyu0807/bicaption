import { app, BrowserWindow, dialog, ipcMain, screen, shell, systemPreferences } from 'electron';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarBridge } from './sidecar.js';
import { loadSettings, saveSettings } from './settings.js';
import { ModelDownloader } from './model-downloader.js';
import type { AppSettings, CaptionConfig, ModelDownloadProgress, OverlayBounds, SidecarEvent } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const rendererEntry = process.env.VITE_DEV_SERVER_URL ?? `file://${join(__dirname, '../renderer/index.html')}`;
const projectRoot = join(__dirname, '../..');
const preloadPath = join(projectRoot, 'electron', 'preload.cjs');
const sidecarScript = join(projectRoot, 'python', 'sidecar.py');
const venvPython = join(projectRoot, '.venv', 'bin', 'python');
const pythonBin = existsSync(venvPython) ? venvPython : 'python3';

let settingsWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlaySuppressed = false;
let saveFilePath: string | null = null;
let isQuitting = false;

const bridge = new SidecarBridge();
const modelDownloader = new ModelDownloader(projectRoot);

function formatSaveFilename(date: Date): string {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${min}.txt`;
}

function initSaveFile() {
  const settings = loadSettings();
  if (!settings.saveEnabled || !settings.saveDirectory) {
    saveFilePath = null;
    return;
  }
  if (!existsSync(settings.saveDirectory)) {
    mkdirSync(settings.saveDirectory, { recursive: true });
  }
  saveFilePath = join(settings.saveDirectory, formatSaveFilename(new Date()));
}

function appendCaption(event: SidecarEvent) {
  if (!saveFilePath || event.type !== 'final_caption') {
    return;
  }
  let line = event.sourceText;
  if (event.translatedText) {
    line += `\n${event.translatedText}`;
  }
  appendFileSync(saveFilePath, line + '\n\n', 'utf-8');
}

function sendToWindows(channel: string, payload: unknown) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, payload);
  }
}

function setOverlayVisible(visible: boolean) {
  if (visible) {
    if (overlaySuppressed) {
      return;
    }
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    overlayWindow?.showInactive();
  } else {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  }
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 360,
    height: 720,
    minHeight: 500,
    title: 'BiCaption',
    webPreferences: {
      preload: preloadPath,
    },
  });

  settingsWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      settingsWindow?.hide();
    }
  });

  void settingsWindow.loadURL(rendererEntry);
  if (isDev && process.env.OPEN_DEVTOOLS === '1') {
    settingsWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createOverlayWindow() {
  const primary = screen.getPrimaryDisplay();
  const settings = loadSettings();
  const initialWidth = settings.overlayWidth || 900;
  const initialHeight = settings.overlayHeight || 220;
  const defaultX = Math.round((primary.workArea.width - initialWidth) / 2);
  const defaultY = primary.workArea.height - initialHeight - 40;
  overlayWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x: settings.overlayX ?? defaultX,
    y: settings.overlayY ?? defaultY,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: preloadPath,
    },
  });
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.hide();
  overlayWindow.on('move', persistOverlayBounds);
  overlayWindow.on('resize', persistOverlayBounds);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  void overlayWindow.loadURL(`${rendererEntry}#overlay`);
}

function persistOverlayBounds() {
  if (!overlayWindow) {
    return;
  }
  const bounds = overlayWindow.getBounds();
  saveSettings({
    overlayX: bounds.x,
    overlayY: bounds.y,
    overlayWidth: bounds.width,
    overlayHeight: bounds.height,
  } satisfies Partial<AppSettings>);
}

function bindBridge() {
  bridge.on('partial_caption', (event: SidecarEvent) => {
    setOverlayVisible(true);
    sendToWindows('sidecar:event', event);
  });
  bridge.on('final_caption', (event: SidecarEvent) => {
    setOverlayVisible(true);
    appendCaption(event);
    sendToWindows('sidecar:event', event);
  });
  bridge.on('metrics', forwardEvent);
  bridge.on('session_state', (event: SidecarEvent) => {
    if (event.type === 'session_state') {
      if (event.state === 'streaming') {
        setOverlayVisible(true);
      } else {
        setOverlayVisible(false);
      }
    }
    sendToWindows('sidecar:event', event);
  });
  bridge.on('error', (event: SidecarEvent) => {
    if (event.type === 'error' && !event.recoverable) {
      setOverlayVisible(false);
    }
    sendToWindows('sidecar:event', event);
  });
  bridge.start();
}

function forwardEvent(event: SidecarEvent) {
  sendToWindows('sidecar:event', event);
}

async function ensureMicrophoneAccess() {
  if (process.platform !== 'darwin') {
    return true;
  }
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') {
    return true;
  }
  return systemPreferences.askForMediaAccess('microphone');
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
    overlaySuppressed = false;
    initSaveFile();
    bridge.startSession(config);
    return { ok: true };
  });
  ipcMain.handle('session:stop', () => {
    bridge.stopSession();
    return { ok: true };
  });
  ipcMain.handle('session:devices', async () => {
    const hasAccess = await ensureMicrophoneAccess();
    if (!hasAccess) {
      throw new Error('Microphone permission was denied. Allow microphone access in System Settings and restart the app.');
    }

    const output = execFileSync('/usr/bin/arch', ['-arm64', pythonBin, sidecarScript, '--list-devices'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    const devices = JSON.parse(output) as Array<{ id: string; label: string; kind: string }>;
    if (devices.length === 0) {
      throw new Error('No audio devices were detected. Check microphone permission and connected audio devices, then restart the app.');
    }
    return devices;
  });
  ipcMain.handle('app:show-settings', () => {
    settingsWindow?.show();
    settingsWindow?.focus();
    return { ok: true };
  });
  ipcMain.handle('overlay:get-position', () => {
    return overlayWindow?.getPosition() ?? [0, 0];
  });
  ipcMain.handle('overlay:set-position', (_event, x: number, y: number) => {
    overlayWindow?.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.handle('overlay:get-bounds', () => {
    return overlayWindow?.getBounds() ?? { x: 0, y: 0, width: 900, height: 220 };
  });
  ipcMain.handle('overlay:set-bounds', (_event, partial: Partial<OverlayBounds>) => {
    if (!overlayWindow) {
      return { x: 0, y: 0, width: 900, height: 220 };
    }
    const current = overlayWindow.getBounds();
    const next = {
      x: partial.x ?? current.x,
      y: partial.y ?? current.y,
      width: Math.max(420, partial.width ?? current.width),
      height: Math.max(140, partial.height ?? current.height),
    };
    overlayWindow.setBounds(next);
    persistOverlayBounds();
    return overlayWindow.getBounds();
  });
  ipcMain.handle('save:choose-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '選擇字幕保存位置',
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle('save:open-directory', () => {
    const settings = loadSettings();
    if (settings.saveDirectory && existsSync(settings.saveDirectory)) {
      shell.openPath(settings.saveDirectory);
    }
    return { ok: true };
  });
  ipcMain.handle('models:check', () => {
    return modelDownloader.checkStatus();
  });
  ipcMain.handle('models:download', () => {
    modelDownloader.downloadAll().catch((err: Error) => {
      sendToWindows('models:error', err.message);
    });
    return { ok: true };
  });
  modelDownloader.on('progress', (progress: ModelDownloadProgress) => {
    sendToWindows('models:progress', progress);
  });
  modelDownloader.on('done', (status: unknown) => {
    sendToWindows('models:done', status);
  });

  ipcMain.handle('overlay:show', () => {
    overlaySuppressed = false;
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    overlayWindow?.showInactive();
    return { ok: true };
  });
  ipcMain.handle('overlay:hide', () => {
    overlaySuppressed = true;
    overlayWindow?.hide();
    return { ok: true };
  });
});

app.on('activate', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
  } else {
    createSettingsWindow();
  }
});

app.dock?.show();

app.on('before-quit', () => {
  isQuitting = true;
  bridge.dispose();
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});
