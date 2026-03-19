import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Tray, nativeImage, screen, shell, systemPreferences } from 'electron';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SidecarBridge } from './sidecar.js';
import { NativeHotkeyBridge } from './native-hotkey.js';
import { loadSettings, saveSettings } from './settings.js';
import { ModelDownloader } from './model-downloader.js';
import { getDebugTracePath, getSidecarCommand, getGlobalHotkeyCommand, getModelDir, getSpawnCwd } from './paths.js';
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
let dictationHotkeyPressed = false;
let pendingDictationPasteTarget: { appName: string; windowTitle: string | null } | null = null;
let dictationOverlayHideTimeout: NodeJS.Timeout | null = null;
let overlayMode: 'hidden' | 'subtitle' | 'dictation' = 'hidden';
let subtitleOverlayBoundsCache: OverlayBounds | null = null;
let tray: Tray | null = null;

const DEFAULT_SUBTITLE_OVERLAY_WIDTH = 900;
const DEFAULT_SUBTITLE_OVERLAY_HEIGHT = 220;
const MIN_SUBTITLE_OVERLAY_WIDTH = 420;
const MIN_SUBTITLE_OVERLAY_HEIGHT = 140;
const DICTATION_OVERLAY_SIZE = 56;

const bridge = new SidecarBridge();
const nativeHotkeyBridge = new NativeHotkeyBridge();
const modelDownloader = new ModelDownloader(getModelDir());
const tracePath = getDebugTracePath();

function traceMain(message: string) {
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${new Date().toISOString()} [electron-main] ${message}\n`, 'utf-8');
  } catch {
    // Ignore trace write failures.
  }
}

traceMain(`module_loaded pid=${process.pid} packaged=${String(app.isPackaged)} cwd=${process.cwd()}`);

function getTrayIconPath() {
  if (isPackaged) {
    return join(process.resourcesPath, 'icon.icns');
  }
  return join(projectRoot, 'build', 'icon.icns');
}

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

function setOverlayMode(mode: 'hidden' | 'subtitle' | 'dictation') {
  if (overlayMode === mode) {
    return;
  }
  overlayMode = mode;
  sendToWindows('overlay:mode', { mode });
}

function isSubtitleSizedBounds(bounds: OverlayBounds | Electron.Rectangle) {
  return bounds.width >= MIN_SUBTITLE_OVERLAY_WIDTH && bounds.height >= MIN_SUBTITLE_OVERLAY_HEIGHT;
}

function getDefaultSubtitleOverlayBounds() {
  const primary = screen.getPrimaryDisplay();
  const settings = loadSettings();
  const width = Math.max(MIN_SUBTITLE_OVERLAY_WIDTH, settings.overlayWidth || DEFAULT_SUBTITLE_OVERLAY_WIDTH);
  const height = Math.max(MIN_SUBTITLE_OVERLAY_HEIGHT, settings.overlayHeight || DEFAULT_SUBTITLE_OVERLAY_HEIGHT);
  const defaultX = Math.round((primary.workArea.width - width) / 2);
  const defaultY = primary.workArea.height - height - 40;
  return {
    x: settings.overlayX ?? defaultX,
    y: settings.overlayY ?? defaultY,
    width,
    height,
  } satisfies OverlayBounds;
}

function getSubtitleOverlayBounds() {
  if (subtitleOverlayBoundsCache && isSubtitleSizedBounds(subtitleOverlayBoundsCache)) {
    return subtitleOverlayBoundsCache;
  }
  return getDefaultSubtitleOverlayBounds();
}

function restoreSubtitleOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }
  const nextBounds = getSubtitleOverlayBounds();
  subtitleOverlayBoundsCache = nextBounds;
  overlayWindow.setBounds(nextBounds);
}

function handleDictationFinal(event: SidecarEvent) {
  if (event.type !== 'dictation_final') {
    return;
  }
  traceMain(`dictation_final session=${event.sessionId} literal=${event.literalTranscript.length} final=${event.finalText.length}`);
  const settings = loadSettings();
  const outputAction = settings.dictationOutputAction;
  const outputText = settings.dictationOutputStyle === 'literal'
    ? event.literalTranscript
    : event.finalText;
  if (outputText.trim()) {
    clipboard.writeText(outputText);
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
  clearActiveSession(event.sessionId);
  dictationHotkeyPressed = false;
  pendingDictationStop = false;
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
  const isDictation = mode === 'dictation';
  return {
    mode,
    sessionId: randomUUID(),
    deviceId: isDictation ? settings.dictationDeviceId : settings.subtitleDeviceId,
    outputDeviceId: isDictation ? '' : settings.outputDeviceId,
    sourceLang: isDictation ? settings.dictationSourceLang : settings.sourceLang,
    targetLang: settings.targetLang,
    sttModel: isDictation ? settings.dictationSttModel : settings.sttModel,
    translateModel: settings.translateModel,
    chunkMs: isDictation ? settings.dictationChunkMs : settings.subtitleChunkMs,
    partialStableMs: isDictation ? settings.dictationEndpointMs : settings.subtitlePartialStableMs,
    beamSize: settings.beamSize,
    bestOf: settings.bestOf,
    vadFilter: settings.vadFilter,
    conditionOnPrev: settings.conditionOnPrev,
    dictationRewriteMode: isDictation ? settings.dictationRewriteMode : undefined,
    dictationDictionaryEnabled: isDictation ? settings.dictationDictionaryEnabled : undefined,
    dictationCloudEnhancementEnabled: isDictation ? settings.dictationCloudEnhancementEnabled : undefined,
    dictationOutputStyle: isDictation ? settings.dictationOutputStyle : undefined,
    dictationDictionaryText: isDictation ? settings.dictationDictionaryText : undefined,
    dictationMaxRewriteExpansionRatio: isDictation ? settings.dictationMaxRewriteExpansionRatio : undefined,
    dictationLocalLlmModel: isDictation ? settings.dictationLocalLlmModel : undefined,
    dictationLocalLlmRunner: isDictation ? settings.dictationLocalLlmRunner : undefined,
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
    traceMain(`clearActiveSession target=${sessionId ?? 'none'} active=${activeSessionId ?? 'none'}`);
    activeSessionMode = null;
    activeSessionId = null;
    pendingDictationStop = false;
    pendingDictationPasteTarget = null;
  }
}

async function stopActiveSession() {
  if (!activeSessionMode) {
    traceMain('stopActiveSession skipped because activeSessionMode is null');
    return;
  }
  traceMain(`stopActiveSession mode=${activeSessionMode} session=${activeSessionId ?? 'none'}`);
  await bridge.stopSession();
  traceMain(`stopActiveSession resolved session=${activeSessionId ?? 'none'}`);
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
  traceMain(`startDictationFromHotkey enter pressed=${String(dictationHotkeyPressed)} activeMode=${activeSessionMode ?? 'none'} pendingStop=${String(pendingDictationStop)} transition=${String(Boolean(sessionTransitionPromise))}`);
  showDictationOverlay();
  await runSessionTransition(async () => {
    if (activeSessionMode) {
      traceMain(`startDictationFromHotkey stopping active session=${activeSessionId ?? 'none'}`);
      await stopActiveSession();
    }
    const settings = loadSettings();
    const config = buildSessionConfig(settings, 'dictation');
    pendingDictationPasteTarget = null;
    prepareSession(config);
    traceMain(`startDictationFromHotkey startSession session=${config.sessionId}`);
    bridge.startSession(config);
  });
  if (pendingDictationStop && activeSessionMode === 'dictation') {
    traceMain(`startDictationFromHotkey detected pending stop for session=${activeSessionId ?? 'none'}`);
    pendingDictationStop = false;
    await stopDictationFromHotkey();
  }
  traceMain(`startDictationFromHotkey exit activeMode=${activeSessionMode ?? 'none'} activeSession=${activeSessionId ?? 'none'}`);
}

async function stopDictationFromHotkey() {
  traceMain(`stopDictationFromHotkey enter pressed=${String(dictationHotkeyPressed)} activeMode=${activeSessionMode ?? 'none'} transition=${String(Boolean(sessionTransitionPromise))}`);
  if (sessionTransitionPromise) {
    traceMain('stopDictationFromHotkey deferred via pendingDictationStop');
    pendingDictationStop = true;
    return;
  }
  const currentFocus = getFrontmostFocusSnapshot();
  pendingDictationPasteTarget = currentFocus;
  await runSessionTransition(async () => {
    if (activeSessionMode !== 'dictation') {
      traceMain(`stopDictationFromHotkey skipped because activeMode=${activeSessionMode ?? 'none'}`);
      return;
    }
    await stopActiveSession();
  });
  pendingDictationStop = false;
  traceMain(`stopDictationFromHotkey exit activeMode=${activeSessionMode ?? 'none'} activeSession=${activeSessionId ?? 'none'}`);
}

function restartDictationHotkeyListener() {
  hotkeyListenerMode = 'dictation';
  nativeHotkeyBridge.startListening(loadSettings().dictationHotkey);
}

function setOverlayVisible(visible: boolean) {
  if (visible) {
    setOverlayMode('subtitle');
    if (overlaySuppressed) {
      return;
    }
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    restoreSubtitleOverlayBounds();
    overlayWindow?.showInactive();
  } else {
    setOverlayMode('hidden');
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  }
}

function clearDictationOverlayHideTimeout() {
  if (dictationOverlayHideTimeout) {
    clearTimeout(dictationOverlayHideTimeout);
    dictationOverlayHideTimeout = null;
  }
}

function showDictationOverlay() {
  clearDictationOverlayHideTimeout();
  setOverlayMode('dictation');
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }
  if (overlayWindow) {
    const currentBounds = overlayWindow.getBounds();
    if (isSubtitleSizedBounds(currentBounds)) {
      subtitleOverlayBoundsCache = currentBounds;
    }
    const current = overlayWindow.getBounds();
    const width = DICTATION_OVERLAY_SIZE;
    const height = DICTATION_OVERLAY_SIZE;
    const x = Math.round(current.x + (current.width - width) / 2);
    const y = Math.round(current.y + current.height - height);
    overlayWindow.setBounds({ x, y, width, height });
  }
  overlayWindow?.showInactive();
}

function hideDictationOverlaySoon(delayMs = 1800) {
  clearDictationOverlayHideTimeout();
  dictationOverlayHideTimeout = setTimeout(() => {
    dictationOverlayHideTimeout = null;
    if (activeSessionMode === 'subtitle') {
      restoreSubtitleOverlayBounds();
      setOverlayMode('subtitle');
      return;
    }
    setOverlayMode('hidden');
    overlayWindow?.hide();
  }, delayMs);
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 980,
    minHeight: 700,
    title: 'BiCaption',
    webPreferences: {
      preload: preloadPath,
    },
  });

  settingsWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      settingsWindow?.hide();
      app.dock?.hide();
    }
  });

  void settingsWindow.loadURL(rendererEntry);
  if (isDev && process.env.OPEN_DEVTOOLS === '1') {
    settingsWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function showSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow();
  }
  app.dock?.show();
  settingsWindow?.show();
  settingsWindow?.focus();
}

function rebuildTrayMenu() {
  if (!tray) {
    return;
  }
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打開設定',
      click: () => showSettingsWindow(),
    },
    {
      label: overlaySuppressed ? '顯示字幕視窗' : '隱藏字幕視窗',
      click: () => {
        overlaySuppressed = !overlaySuppressed;
        if (overlaySuppressed) {
          setOverlayMode('hidden');
          overlayWindow?.hide();
        } else if (overlayMode === 'subtitle') {
          setOverlayVisible(true);
        }
        rebuildTrayMenu();
      },
    },
    {
      label: activeSessionMode === 'subtitle' ? '停止雙語字幕' : '開始雙語字幕',
      click: async () => {
        if (activeSessionMode === 'subtitle') {
          await runSessionTransition(async () => {
            await stopActiveSession();
          });
          return;
        }
        const settings = loadSettings();
        const config = buildSessionConfig(settings, 'subtitle');
        await runSessionTransition(async () => {
          if (activeSessionMode) {
            await stopActiveSession();
          }
          prepareSession(config);
          bridge.startSession(config);
        });
      },
    },
    { type: 'separator' },
    {
      label: '結束 BiCaption',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray) {
    return;
  }
  const trayImage = nativeImage.createFromPath(getTrayIconPath()).resize({ width: 18, height: 18 });
  trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.setTitle('BiCaption');
  tray.setToolTip('BiCaption');
  tray.on('click', () => showSettingsWindow());
  rebuildTrayMenu();
}

function createOverlayWindow() {
  const subtitleBounds = getDefaultSubtitleOverlayBounds();
  overlayWindow = new BrowserWindow({
    width: subtitleBounds.width,
    height: subtitleBounds.height,
    x: subtitleBounds.x,
    y: subtitleBounds.y,
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
  if (overlayMode === 'dictation') {
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
  traceMain('bindBridge called');
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
    rebuildTrayMenu();
    sendToWindows('sidecar:event', event);
  });
  bridge.on('dictation_state', (event: SidecarEvent) => {
    if (event.type === 'dictation_state') {
      showDictationOverlay();
      if (event.state === 'stopped' || event.state === 'error') {
        dictationHotkeyPressed = false;
      }
    }
    forwardEvent(event);
  });
  bridge.on('dictation_final', (event: SidecarEvent) => {
    handleDictationFinal(event);
    hideDictationOverlaySoon();
  });
  bridge.on('session_stopped_ack', (event: SidecarEvent) => {
    if (event.type === 'session_stopped_ack') {
      traceMain(`session_stopped_ack session=${event.sessionId}`);
      clearActiveSession(event.sessionId);
    }
    rebuildTrayMenu();
    forwardEvent(event);
  });
  bridge.on('error', (event: SidecarEvent) => {
    if (event.type === 'error' && event.mode === 'subtitle' && !event.recoverable) {
      setOverlayVisible(false);
    }
    if (event.type === 'error' && !event.recoverable) {
      clearActiveSession(event.sessionId);
    }
    rebuildTrayMenu();
    sendToWindows('sidecar:event', event);
  });
  bridge.start();
}

function forwardEvent(event: SidecarEvent) {
  sendToWindows('sidecar:event', event);
}

function forwardHotkeyEvent(event: DictationHotkeyEvent) {
  traceMain(`hotkey event=${event.type} keyCode=${String(event.keyCode)} pressed=${String(dictationHotkeyPressed)} mode=${hotkeyListenerMode}`);
  sendToWindows('dictation:hotkey-event', event);
  if (hotkeyListenerMode !== 'dictation') {
    return;
  }
  if (event.type === 'hotkey_down') {
    if (dictationHotkeyPressed) {
      return;
    }
    dictationHotkeyPressed = true;
    showDictationOverlay();
    void startDictationFromHotkey();
  } else if (event.type === 'hotkey_up') {
    dictationHotkeyPressed = false;
    void stopDictationFromHotkey();
  } else if (event.type === 'listener_stopped' || event.type === 'error') {
    dictationHotkeyPressed = false;
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
  traceMain('app.whenReady entered');
  createSettingsWindow();
  createOverlayWindow();
  createTray();
  app.dock?.hide();

  ipcMain.handle('settings:load', () => loadSettings());
  ipcMain.handle('settings:save', (_event, partial) => {
    const settings = saveSettings(partial);
    if (hotkeyListenerMode !== 'test') {
      restartDictationHotkeyListener();
    }
    sendToWindows('settings:changed', settings);
    rebuildTrayMenu();
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
    rebuildTrayMenu();
    return { ok: true };
  });
  ipcMain.handle('session:stop', async () => {
    await runSessionTransition(async () => {
      await stopActiveSession();
    });
    rebuildTrayMenu();
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
    showSettingsWindow();
    return { ok: true };
  });
  ipcMain.handle('overlay:get-position', () => {
    return overlayWindow?.getPosition() ?? [0, 0];
  });
  ipcMain.handle('overlay:set-position', (_event, x: number, y: number) => {
    overlayWindow?.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.handle('overlay:get-bounds', () => {
    return overlayWindow?.getBounds() ?? getDefaultSubtitleOverlayBounds();
  });
  ipcMain.handle('overlay:set-bounds', (_event, partial: Partial<OverlayBounds>) => {
    if (!overlayWindow) {
      return getDefaultSubtitleOverlayBounds();
    }
    const current = overlayWindow.getBounds();
    const next = {
      x: partial.x ?? current.x,
      y: partial.y ?? current.y,
      width: Math.max(MIN_SUBTITLE_OVERLAY_WIDTH, partial.width ?? current.width),
      height: Math.max(MIN_SUBTITLE_OVERLAY_HEIGHT, partial.height ?? current.height),
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
    setOverlayMode('subtitle');
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow();
    }
    restoreSubtitleOverlayBounds();
    overlayWindow?.showInactive();
    rebuildTrayMenu();
    return { ok: true };
  });
  ipcMain.handle('overlay:hide', () => {
    overlaySuppressed = true;
    setOverlayMode('hidden');
    overlayWindow?.hide();
    rebuildTrayMenu();
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
  showSettingsWindow();
});

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
