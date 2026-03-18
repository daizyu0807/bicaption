import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell, systemPreferences } from 'electron';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SidecarBridge } from './sidecar.js';
import { NativeHotkeyBridge } from './native-hotkey.js';
import { loadSettings, saveSettings } from './settings.js';
import { ModelDownloader } from './model-downloader.js';
import { getSidecarCommand, getGlobalHotkeyCommand, getModelDir, getSpawnCwd } from './paths.js';
import type { AppSettings, CaptionConfig, DictationHotkeyBinding, DictationHotkeyEvent, DictationOutputAction, DictationOutputStatusEvent, ModelDownloadProgress, OverlayBounds, SessionMode, SidecarEvent } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const isPackaged = app.isPackaged;
const rendererEntry = process.env.VITE_DEV_SERVER_URL ?? `file://${join(__dirname, '../renderer/index.html')}`;
const projectRoot = join(__dirname, '../..');
const preloadPath = isPackaged
  ? join(app.getAppPath(), 'electron', 'preload.cjs')
  : join(projectRoot, 'electron', 'preload.cjs');

let settingsWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlaySuppressed = false;
let saveFilePath: string | null = null;
let isQuitting = false;
let activeSessionMode: SessionMode | null = null;
let activeSessionId: string | null = null;
let sessionTransitionPromise: Promise<void> | null = null;
let hotkeyListenerMode: 'dictation' | 'test' | 'idle' = 'idle';
let pendingDictationStop = false;
let pendingDictationPasteTarget: { appName: string; windowTitle: string | null } | null = null;

const bridge = new SidecarBridge();
const nativeHotkeyBridge = new NativeHotkeyBridge();
const modelDownloader = new ModelDownloader(getModelDir());

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
  if (!saveFilePath || event.type !== 'final_caption' || event.mode !== 'subtitle') {
    return;
  }
  const settings = loadSettings();
  const translationEnabled = settings.translateModel !== 'disabled'
    && (settings.sourceLang === 'auto' || settings.targetLang !== settings.sourceLang);
  // When translation is enabled, wait for the second emit that carries
  // translatedText — skip the first emit (sourceText only) to avoid
  // duplicate English lines in the saved file.
  if (translationEnabled && !event.translatedText) {
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

function handleDictationFinal(event: SidecarEvent) {
  if (event.type !== 'dictation_final') {
    return;
  }
  const settings = loadSettings();
  const outputAction = settings.dictationOutputAction;
  if (event.text.trim()) {
    clipboard.writeText(event.text);
    if (outputAction === 'copy') {
      sendToWindows('dictation:output-status', {
        type: 'dictation_output_status',
        action: outputAction,
        status: 'copied',
      } satisfies DictationOutputStatusEvent);
    } else {
      const pasted = tryPasteClipboard(outputAction, pendingDictationPasteTarget);
      sendToWindows('dictation:output-status', {
        type: 'dictation_output_status',
        action: outputAction,
        status: pasted ? 'pasted' : 'fallback',
        detail: pasted ? 'Pasted into foreground app.' : getPasteFallbackDetail(),
      } satisfies DictationOutputStatusEvent);
    }
  }
  pendingDictationPasteTarget = null;
  sendToWindows('sidecar:event', event);
}

function getFrontmostFocusSnapshot() {
  try {
    const output = execFileSync('osascript', [
      '-e',
      'tell application "System Events"',
      '-e',
      'set frontApp to first application process whose frontmost is true',
      '-e',
      'set appName to name of frontApp',
      '-e',
      'set windowTitle to ""',
      '-e',
      'try',
      '-e',
      'set windowTitle to name of front window of frontApp',
      '-e',
      'end try',
      '-e',
      'return appName & linefeed & windowTitle',
      '-e',
      'end tell',
    ], {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
    }).trimEnd();
    const [appName, windowTitle] = output.split('\n');
    if (!appName) {
      return null;
    }
    return {
      appName,
      windowTitle: windowTitle || null,
    };
  } catch {
    return null;
  }
}

function getPasteFallbackDetail() {
  if (!pendingDictationPasteTarget) {
    return 'Paste unavailable, kept clipboard copy.';
  }
  const currentFocus = getFrontmostFocusSnapshot();
  if (currentFocus && currentFocus.appName !== pendingDictationPasteTarget.appName) {
    return `Focus changed from ${pendingDictationPasteTarget.appName} to ${currentFocus.appName}, kept clipboard copy.`;
  }
  if (
    currentFocus
    && pendingDictationPasteTarget.windowTitle
    && currentFocus.windowTitle
    && currentFocus.windowTitle !== pendingDictationPasteTarget.windowTitle
  ) {
    return `Window changed from ${pendingDictationPasteTarget.windowTitle} to ${currentFocus.windowTitle}, kept clipboard copy.`;
  }
  return 'Paste unavailable, kept clipboard copy.';
}

function tryPasteClipboard(action: DictationOutputAction, expectedTarget: { appName: string; windowTitle: string | null } | null) {
  if (action === 'copy') {
    return false;
  }
  const accessibility = checkAccessibilityPermission();
  if (!accessibility.trusted) {
    return false;
  }
  if (expectedTarget) {
    const currentFocus = getFrontmostFocusSnapshot();
    if (!currentFocus || currentFocus.appName !== expectedTarget.appName) {
      return false;
    }
    if (
      expectedTarget.windowTitle
      && currentFocus.windowTitle
      && currentFocus.windowTitle !== expectedTarget.windowTitle
    ) {
      return false;
    }
  }
  try {
    execFileSync('osascript', [
      '-e',
      'tell application "System Events" to keystroke "v" using command down',
    ], {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

function buildSessionConfig(settings: AppSettings, mode: SessionMode): CaptionConfig {
  return {
    mode,
    sessionId: randomUUID(),
    deviceId: mode === 'dictation' ? settings.dictationDeviceId : settings.subtitleDeviceId,
    outputDeviceId: settings.outputDeviceId,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    sttModel: settings.sttModel,
    translateModel: settings.translateModel,
    chunkMs: settings.chunkMs,
    partialStableMs: settings.partialStableMs,
    beamSize: settings.beamSize,
    bestOf: settings.bestOf,
    vadFilter: settings.vadFilter,
    conditionOnPrev: settings.conditionOnPrev,
  };
}

function prepareSession(config: CaptionConfig) {
  overlaySuppressed = config.mode === 'subtitle' ? false : overlaySuppressed;
  if (config.mode === 'subtitle') {
    initSaveFile();
  } else {
    saveFilePath = null;
  }
  activeSessionMode = config.mode;
  activeSessionId = config.sessionId;
}

function clearActiveSession(sessionId?: string) {
  if (!sessionId || !activeSessionId || sessionId === activeSessionId) {
    activeSessionMode = null;
    activeSessionId = null;
    pendingDictationPasteTarget = null;
  }
}

async function stopActiveSession() {
  if (!activeSessionMode) {
    return;
  }
  await bridge.stopSession();
}

function runSessionTransition(task: () => Promise<void>) {
  if (sessionTransitionPromise) {
    return sessionTransitionPromise;
  }
  sessionTransitionPromise = (async () => {
    try {
      await task();
    } finally {
      sessionTransitionPromise = null;
    }
  })();
  return sessionTransitionPromise;
}

async function startDictationFromHotkey() {
  await runSessionTransition(async () => {
    if (activeSessionMode === 'dictation') {
      return;
    }
    if (activeSessionMode) {
      await stopActiveSession();
    }
    const settings = loadSettings();
    const config = buildSessionConfig(settings, 'dictation');
    pendingDictationPasteTarget = null;
    prepareSession(config);
    bridge.startSession(config);
  });
  if (pendingDictationStop && activeSessionMode === 'dictation') {
    pendingDictationStop = false;
    await stopDictationFromHotkey();
  }
}

async function stopDictationFromHotkey() {
  if (sessionTransitionPromise) {
    pendingDictationStop = true;
    return;
  }
  const currentFocus = getFrontmostFocusSnapshot();
  pendingDictationPasteTarget = currentFocus;
  await runSessionTransition(async () => {
    if (activeSessionMode !== 'dictation') {
      return;
    }
    await stopActiveSession();
  });
  pendingDictationStop = false;
}

function restartDictationHotkeyListener() {
  hotkeyListenerMode = 'dictation';
  nativeHotkeyBridge.startListening(loadSettings().dictationHotkey);
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
    width: 380,
    height: 820,
    minHeight: 600,
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
    if (event.type === 'partial_caption' && event.mode === 'subtitle') {
      setOverlayVisible(true);
    }
    sendToWindows('sidecar:event', event);
  });
  bridge.on('final_caption', (event: SidecarEvent) => {
    if (event.type === 'final_caption' && event.mode === 'subtitle') {
      setOverlayVisible(true);
    }
    appendCaption(event);
    sendToWindows('sidecar:event', event);
  });
  bridge.on('metrics', forwardEvent);
  bridge.on('session_state', (event: SidecarEvent) => {
    if (event.type === 'session_state' && event.mode === 'subtitle') {
      if (event.state === 'streaming') {
        setOverlayVisible(true);
      } else {
        setOverlayVisible(false);
      }
    }
    if (event.type === 'session_state' && event.state === 'error') {
      clearActiveSession(event.sessionId);
    }
    sendToWindows('sidecar:event', event);
  });
  bridge.on('dictation_state', forwardEvent);
  bridge.on('dictation_final', handleDictationFinal);
  bridge.on('session_stopped_ack', (event: SidecarEvent) => {
    if (event.type === 'session_stopped_ack') {
      clearActiveSession(event.sessionId);
    }
    forwardEvent(event);
  });
  bridge.on('error', (event: SidecarEvent) => {
    if (event.type === 'error' && event.mode === 'subtitle' && !event.recoverable) {
      setOverlayVisible(false);
    }
    if (event.type === 'error' && !event.recoverable) {
      clearActiveSession(event.sessionId);
    }
    sendToWindows('sidecar:event', event);
  });
  bridge.start();
}

function forwardEvent(event: SidecarEvent) {
  sendToWindows('sidecar:event', event);
}

function forwardHotkeyEvent(event: DictationHotkeyEvent) {
  sendToWindows('dictation:hotkey-event', event);
  if (hotkeyListenerMode !== 'dictation') {
    return;
  }
  if (event.type === 'hotkey_down') {
    void startDictationFromHotkey();
  } else if (event.type === 'hotkey_up') {
    void stopDictationFromHotkey();
  }
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

function checkAccessibilityPermission() {
  if (process.platform !== 'darwin') {
    return { trusted: true, status: 'not-applicable' };
  }
  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  return {
    trusted,
    status: trusted ? 'granted' : 'denied',
  };
}

function checkInputMonitoringPermission() {
  if (process.platform !== 'darwin') {
    return { trusted: true, available: true, detail: 'not-applicable' };
  }

  const { command, args } = getGlobalHotkeyCommand();
  if (!existsSync(command)) {
    return {
      trusted: false,
      available: false,
      detail: `Missing global-hotkey helper at ${command}`,
    };
  }
  try {
    const output = execFileSync(command, [...args, '--check-access'], {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
    }).trim();
    const parsed = JSON.parse(output) as { trusted?: boolean };
    return {
      trusted: Boolean(parsed.trusted),
      available: true,
    };
  } catch (error) {
    return {
      trusted: false,
      available: false,
      detail: error instanceof Error ? error.message : 'Unknown global-hotkey helper error',
    };
  }
}

function requestInputMonitoringPermission() {
  if (process.platform !== 'darwin') {
    return { trusted: true, available: true, detail: 'not-applicable' };
  }

  const { command, args } = getGlobalHotkeyCommand();
  if (!existsSync(command)) {
    return {
      trusted: false,
      available: false,
      detail: `Missing global-hotkey helper at ${command}`,
    };
  }
  try {
    const output = execFileSync(command, [...args, '--request-access'], {
      cwd: getSpawnCwd(),
      encoding: 'utf-8',
    }).trim();
    const parsed = JSON.parse(output) as { trusted?: boolean };
    return {
      trusted: Boolean(parsed.trusted),
      available: true,
    };
  } catch (error) {
    return {
      trusted: false,
      available: false,
      detail: error instanceof Error ? error.message : 'Unknown global-hotkey helper error',
    };
  }
}

async function openInputMonitoringSettings() {
  if (process.platform !== 'darwin') {
    return { ok: false };
  }
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  return { ok: true };
}

app.whenReady().then(() => {
  createSettingsWindow();
  createOverlayWindow();

  ipcMain.handle('settings:load', () => loadSettings());
  ipcMain.handle('settings:save', (_event, partial) => {
    const settings = saveSettings(partial);
    if (hotkeyListenerMode !== 'test') {
      restartDictationHotkeyListener();
    }
    sendToWindows('settings:changed', settings);
    return settings;
  });
  ipcMain.handle('permissions:check-accessibility', () => checkAccessibilityPermission());
  ipcMain.handle('permissions:check-input-monitoring', () => checkInputMonitoringPermission());
  ipcMain.handle('permissions:request-input-monitoring', () => requestInputMonitoringPermission());
  ipcMain.handle('permissions:open-input-monitoring', () => openInputMonitoringSettings());
  ipcMain.handle('dictation:test-hotkey', (_event, binding: DictationHotkeyBinding) => {
    hotkeyListenerMode = 'test';
    nativeHotkeyBridge.startListening(binding);
    return { ok: true };
  });
  ipcMain.handle('dictation:stop-hotkey-test', () => {
    nativeHotkeyBridge.stopListening();
    restartDictationHotkeyListener();
    return { ok: true };
  });
  ipcMain.handle('session:start', async (_event, config: CaptionConfig) => {
    await runSessionTransition(async () => {
      if (activeSessionMode) {
        await stopActiveSession();
      }
      prepareSession(config);
      bridge.startSession(config);
    });
    return { ok: true };
  });
  ipcMain.handle('session:stop', async () => {
    await runSessionTransition(async () => {
      await stopActiveSession();
    });
    return { ok: true };
  });
  ipcMain.handle('session:devices', async () => {
    const hasAccess = await ensureMicrophoneAccess();
    if (!hasAccess) {
      throw new Error('Microphone permission was denied. Allow microphone access in System Settings and restart the app.');
    }

    const { command: sidecarCmd, args: sidecarArgs } = getSidecarCommand();
    const output = execFileSync(sidecarCmd, [...sidecarArgs, '--list-devices'], {
      cwd: getSpawnCwd(),
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
  ipcMain.handle('models:download-one', (_event, modelKey: string) => {
    modelDownloader.downloadOne(modelKey).catch((err: Error) => {
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
  nativeHotkeyBridge.on('event', forwardHotkeyEvent);
  restartDictationHotkeyListener();

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

  // Start sidecar AFTER all IPC handlers are registered
  try {
    bindBridge();
  } catch (err) {
    console.error('Failed to start sidecar bridge:', err);
  }
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
  nativeHotkeyBridge.stopListening();
  bridge.dispose();
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});
