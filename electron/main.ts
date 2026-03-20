import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Tray, nativeImage, screen, shell, systemPreferences } from 'electron';
import type { MessageBoxOptions } from 'electron';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import electronUpdater from 'electron-updater';
import { SidecarBridge } from './sidecar.js';
import { NativeHotkeyBridge } from './native-hotkey.js';
import { loadSettings, saveSettings } from './settings.js';
import { ModelDownloader } from './model-downloader.js';
import { getDebugTracePath, getSidecarCommand, getGlobalHotkeyCommand, getModelDir, getSpawnCwd } from './paths.js';
import type { AppSettings, CaptionConfig, DictationHotkeyBinding, DictationHotkeyEvent, DictationOutputAction, DictationOutputStatusEvent, MeetingEnrollSpeakerRequest, MeetingEnrollSpeakerResult, MeetingNotesRequest, MeetingNotesResult, MeetingReportRequest, MeetingReportResult, ModelDownloadProgress, OverlayBounds, SessionMode, SidecarEvent } from './types.js';

const { autoUpdater } = electronUpdater;

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
let meetingTranscriptFilePath: string | null = null;
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
let dictationOverlayBoundsCache: OverlayBounds | null = null;
let tray: Tray | null = null;
let updateStatus: 'idle' | 'checking' | 'downloading' | 'downloaded' = 'idle';
let manualUpdateCheckPending = false;

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

function createTrayTemplateImage() {
  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 5.25h12" stroke-width="1.8"/>
        <path d="M3 12.75h12" stroke-width="1.8"/>
        <path d="M5.25 9c1.1-1.2 2.2-1.2 3.3 0s2.2 1.2 3.3 0 2.2-1.2 3.3 0" stroke-width="1.8"/>
      </g>
    </svg>
  `.trim();
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  image.setTemplateImage(true);
  return image.resize({ width: 18, height: 18 });
}

function describeNativeImage(image: Electron.NativeImage) {
  const size = image.getSize();
  return `empty=${String(image.isEmpty())} size=${size.width}x${size.height} template=${String(image.isTemplateImage())}`;
}

function createNamedTrayImage() {
  const image = nativeImage.createFromNamedImage('NSImageNameActionTemplate');
  image.setTemplateImage(true);
  return image.resize({ width: 18, height: 18 });
}

function createTrayImage() {
  const systemImage = createNamedTrayImage();
  if (!systemImage.isEmpty()) {
    traceMain(`createTrayImage source=named ${describeNativeImage(systemImage)}`);
    return systemImage;
  }
  const inlineImage = createTrayTemplateImage();
  traceMain(`createTrayImage source=inline ${describeNativeImage(inlineImage)}`);
  return inlineImage;
}

function formatSaveFilename(date: Date): string {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${min}.txt`;
}

function formatMeetingTranscriptFilename(date: Date) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${min}_meeting.md`;
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

function initMeetingTranscriptFile() {
  const settings = loadSettings();
  if (!settings.meetingSaveTranscript || !settings.meetingTranscriptDirectory) {
    meetingTranscriptFilePath = null;
    return;
  }
  if (!existsSync(settings.meetingTranscriptDirectory)) {
    mkdirSync(settings.meetingTranscriptDirectory, { recursive: true });
  }
  meetingTranscriptFilePath = join(settings.meetingTranscriptDirectory, formatMeetingTranscriptFilename(new Date()));
  appendFileSync(meetingTranscriptFilePath, `# Meeting Transcript\n\nStarted: ${new Date().toISOString()}\n\n`, 'utf-8');
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

function formatTimeLabel(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString('zh-TW', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function appendMeetingCaption(event: SidecarEvent) {
  if (!meetingTranscriptFilePath || event.type !== 'meeting_caption' || event.mode !== 'meeting') {
    return;
  }
  const settings = loadSettings();
  const translationEnabled = settings.meetingTranslateModel !== 'disabled'
    && settings.meetingTranslateModel !== 'off'
    && settings.meetingTranslateModel !== 'none'
    && settings.meetingTargetLang !== settings.meetingSourceLang;
  if (translationEnabled && !event.translatedText) {
    return;
  }
  const label = event.speakerKind === 'verified-local'
    ? settings.meetingMicrophoneLabel || event.speakerLabel || '我方'
    : event.source === 'microphone'
      ? settings.meetingMicrophoneLabel
      : settings.meetingSystemLabel;
  const startedAt = formatTimeLabel(event.tsStartMs);
  const endedAt = formatTimeLabel(event.tsEndMs);
  let block = `## [${startedAt} - ${endedAt}] ${label}\n\n${event.text}`;
  if (event.translatedText) {
    block += `\n\n> ${event.translatedText}`;
  }
  appendFileSync(meetingTranscriptFilePath, block + '\n\n', 'utf-8');
}

function getLatestMeetingTranscriptPath() {
  const settings = loadSettings();
  const baseDir = settings.meetingTranscriptDirectory;
  if (!baseDir || !existsSync(baseDir)) {
    return null;
  }
  const candidates = readdirSync(baseDir)
    .filter((entry) => entry.endsWith('_meeting.md'))
    .map((entry) => {
      const path = join(baseDir, entry);
      return {
        path,
        mtimeMs: statSync(path).mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path ?? null;
}

function buildMeetingNotesPrompt(transcript: string, request: MeetingNotesRequest) {
  return [
    'You are a deterministic meeting notes generator.',
    `Target language: ${request.targetLang}.`,
    'Return a minified JSON object with this exact shape:',
    '{"summary":"string","decisions":["string"],"actionItems":["string"],"risks":["string"]}',
    'Rules:',
    '1. Base everything strictly on the transcript.',
    '2. Do not invent owners, dates, or decisions that are not supported by the transcript.',
    `3. ${request.includeActionItems ? 'Include concrete action items when present.' : 'Leave actionItems empty.'}`,
    `4. ${request.includeRisks ? 'Include open risks or unresolved questions when present.' : 'Leave risks empty.'}`,
    `5. ${request.includeSpeakerNames ? 'Preserve speaker labels when they help clarity.' : 'Do not emphasize speaker labels.'}`,
    '6. Keep the summary concise but useful.',
    'Additional instructions:',
    request.promptTemplate.trim() || 'Summarize the meeting into an executive summary with decisions and follow-ups.',
    'Transcript:',
    transcript.trim(),
  ].join('\n');
}

function formatMeetingNotesMarkdown(result: MeetingNotesResult) {
  const sections = [
    '# Meeting Notes',
    '',
    '## Summary',
    result.summary || 'No summary generated.',
    '',
    '## Decisions',
    ...(result.decisions.length > 0 ? result.decisions.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Action Items',
    ...(result.actionItems.length > 0 ? result.actionItems.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Risks',
    ...(result.risks.length > 0 ? result.risks.map((item) => `- ${item}`) : ['- None']),
    '',
  ];
  return sections.join('\n');
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildMeetingReportHtml(title: string, transcript: string, notes: MeetingNotesResult | null) {
  const transcriptBlocks = transcript
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<article class="transcript-block"><pre>${escapeHtml(block)}</pre></article>`)
    .join('\n');

  const renderList = (items: string[]) => (
    items.length > 0
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="muted">None</p>'
  );

  const notesSection = notes ? `
    <section class="card">
      <h2>Summary</h2>
      <p>${escapeHtml(notes.summary || 'No summary generated.')}</p>
      <h3>Decisions</h3>
      ${renderList(notes.decisions)}
      <h3>Action Items</h3>
      ${renderList(notes.actionItems)}
      <h3>Risks</h3>
      ${renderList(notes.risks)}
    </section>
  ` : `
    <section class="card">
      <h2>Summary</h2>
      <p class="muted">No meeting notes were generated.</p>
    </section>
  `;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f1e8; color: #1f1d1a; }
      main { max-width: 980px; margin: 0 auto; padding: 40px 24px 80px; }
      h1, h2, h3 { margin: 0 0 12px; }
      .hero { margin-bottom: 24px; padding: 28px; border-radius: 24px; background: linear-gradient(135deg, #fff9ef, #efe1c6); border: 1px solid #d8c8a7; }
      .grid { display: grid; gap: 20px; }
      .card { padding: 24px; border-radius: 20px; background: rgba(255,255,255,0.8); border: 1px solid #d8c8a7; box-shadow: 0 10px 30px rgba(78, 57, 24, 0.08); }
      .muted { color: #6b6256; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
      ul { margin: 0; padding-left: 20px; }
      .transcript-list { display: grid; gap: 12px; }
      .transcript-block { padding: 16px; border-radius: 14px; background: #fffdf8; border: 1px solid #e4d7bd; }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>${escapeHtml(title)}</h1>
        <p class="muted">Exported from BiCaption meeting mode.</p>
      </section>
      <div class="grid">
        ${notesSection}
        <section class="card">
          <h2>Transcript</h2>
          <div class="transcript-list">
            ${transcriptBlocks || '<p class="muted">No transcript available.</p>'}
          </div>
        </section>
      </div>
    </main>
  </body>
</html>`;
}

function runMeetingNotesGeneration(request: MeetingNotesRequest): MeetingNotesResult {
  const transcriptPath = meetingTranscriptFilePath ?? getLatestMeetingTranscriptPath();
  const transcript = (request.transcriptText ?? '').trim() || (
    transcriptPath && existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf-8').trim() : ''
  );
  if (!transcript) {
    throw new Error('No meeting transcript is available yet.');
  }

  const prompt = buildMeetingNotesPrompt(transcript, request);
  const localLlmScript = join(projectRoot, 'python', 'local-llm-rewrite.py');
  if (!existsSync(localLlmScript)) {
    throw new Error('Meeting notes generator script is unavailable.');
  }

  const venvPython = join(projectRoot, '.venv', 'bin', 'python');
  const pythonBin = existsSync(venvPython) ? venvPython : 'python3';
  const command = app.isPackaged ? pythonBin : '/usr/bin/arch';
  const args = app.isPackaged ? [localLlmScript] : ['-arm64', pythonBin, localLlmScript];
  const settings = loadSettings();
  const rawOutput = execFileSync(command, args, {
    cwd: getSpawnCwd(),
    encoding: 'utf-8',
    input: JSON.stringify({
      prompt,
      model: settings.dictationLocalLlmModel,
      runner: settings.dictationLocalLlmRunner,
    }),
  }).trim();

  let payloadText = '';
  try {
    const wrapped = JSON.parse(rawOutput) as { text?: string };
    payloadText = String(wrapped.text ?? '').trim();
  } catch {
    payloadText = rawOutput;
  }

  let result: MeetingNotesResult;
  try {
    const parsed = JSON.parse(payloadText) as Partial<MeetingNotesResult>;
    result = {
      summary: String(parsed.summary ?? '').trim(),
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map((item) => String(item).trim()).filter(Boolean) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map((item) => String(item).trim()).filter(Boolean) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.map((item) => String(item).trim()).filter(Boolean) : [],
      rawPrompt: prompt,
    };
  } catch {
    result = {
      summary: payloadText || 'No summary generated.',
      decisions: [],
      actionItems: [],
      risks: [],
      rawPrompt: prompt,
    };
  }

  const notesBasePath = transcriptPath && existsSync(transcriptPath)
    ? transcriptPath
    : join(loadSettings().meetingTranscriptDirectory || getSpawnCwd(), 'latest_meeting.md');
  const notesPath = join(dirname(notesBasePath), `${basename(notesBasePath, extname(notesBasePath))}-notes.md`);
  writeFileSync(notesPath, formatMeetingNotesMarkdown(result), 'utf-8');
  return result;
}

function runMeetingReportExport(request: MeetingReportRequest): MeetingReportResult {
  const transcriptPath = meetingTranscriptFilePath ?? getLatestMeetingTranscriptPath();
  const transcript = (request.transcriptText ?? '').trim() || (
    transcriptPath && existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf-8').trim() : ''
  );
  if (!transcript) {
    throw new Error('No meeting transcript is available yet.');
  }

  const title = request.title?.trim() || `Meeting Report ${new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-')}`;
  const notes = request.notes ?? null;
  const reportBasePath = transcriptPath && existsSync(transcriptPath)
    ? transcriptPath
    : join(loadSettings().meetingTranscriptDirectory || getSpawnCwd(), 'latest_meeting.md');
  const reportPath = join(dirname(reportBasePath), `${basename(reportBasePath, extname(reportBasePath))}-report.html`);
  writeFileSync(reportPath, buildMeetingReportHtml(title, transcript, notes), 'utf-8');
  return { path: reportPath };
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
  const hasStoredPosition = Number.isFinite(settings.overlayX)
    && Number.isFinite(settings.overlayY)
    && !(settings.overlayX === 0 && settings.overlayY === 0);
  return {
    x: hasStoredPosition ? settings.overlayX : defaultX,
    y: hasStoredPosition ? settings.overlayY : defaultY,
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

function getDefaultDictationOverlayBounds() {
  const primary = screen.getPrimaryDisplay();
  const workArea = primary.workArea;
  const x = Math.round(workArea.x + (workArea.width - DICTATION_OVERLAY_SIZE) / 2);
  const y = Math.round(workArea.y + workArea.height - DICTATION_OVERLAY_SIZE - 128);
  return {
    x,
    y,
    width: DICTATION_OVERLAY_SIZE,
    height: DICTATION_OVERLAY_SIZE,
  } satisfies OverlayBounds;
}

function getDictationOverlayBounds() {
  return dictationOverlayBoundsCache ?? getDefaultDictationOverlayBounds();
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
  const isMeeting = mode === 'meeting';
  const meetingPrimaryDeviceId = settings.meetingSourceMode === 'system-audio'
    ? settings.meetingSystemAudioDeviceId
    : settings.meetingMicDeviceId;
  const meetingSecondaryDeviceId = settings.meetingSourceMode === 'dual'
    ? settings.meetingSystemAudioDeviceId
    : '';
  return {
    mode,
    sessionId: randomUUID(),
    deviceId: isMeeting ? meetingPrimaryDeviceId : isDictation ? settings.dictationDeviceId : settings.subtitleDeviceId,
    outputDeviceId: isMeeting ? meetingSecondaryDeviceId : isDictation ? '' : settings.outputDeviceId,
    sourceLang: isMeeting ? settings.meetingSourceLang : isDictation ? settings.dictationSourceLang : settings.sourceLang,
    targetLang: isMeeting ? settings.meetingTargetLang : settings.targetLang,
    sttModel: isMeeting ? settings.meetingSttModel : isDictation ? settings.dictationSttModel : settings.sttModel,
    translateModel: isMeeting ? settings.meetingTranslateModel : settings.translateModel,
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
    meetingSourceMode: isMeeting ? settings.meetingSourceMode : undefined,
    meetingSpeakerLabelsEnabled: isMeeting ? settings.meetingSpeakerLabelsEnabled : undefined,
    meetingLocalSpeakerVerificationEnabled: isMeeting ? settings.meetingLocalSpeakerVerificationEnabled : undefined,
    meetingLocalSpeakerProfileId: isMeeting ? settings.meetingLocalSpeakerProfileId : undefined,
    meetingLocalSpeakerFingerprint: isMeeting ? settings.meetingLocalSpeakerFingerprint : undefined,
    meetingNotesPrompt: isMeeting ? settings.meetingNotesPrompt : undefined,
    meetingSaveTranscript: isMeeting ? settings.meetingSaveTranscript : undefined,
    meetingTranscriptDirectory: isMeeting ? settings.meetingTranscriptDirectory : undefined,
  };
}

function runMeetingLocalSpeakerEnrollment(request: MeetingEnrollSpeakerRequest): MeetingEnrollSpeakerResult {
  const { command: sidecarCmd, args: sidecarArgs } = getSidecarCommand();
  const output = execFileSync(sidecarCmd, [
    ...sidecarArgs,
    '--enroll-speaker',
    '--device-id',
    request.deviceId,
    '--duration-sec',
    String(request.durationSec ?? 8),
  ], {
    cwd: getSpawnCwd(),
    encoding: 'utf-8',
  }).trim();
  const parsed = JSON.parse(output) as Partial<MeetingEnrollSpeakerResult>;
  if (!parsed.profileId || !parsed.fingerprint) {
    throw new Error('Speaker enrollment returned an invalid result.');
  }
  return {
    profileId: String(parsed.profileId),
    fingerprint: String(parsed.fingerprint),
    sampleDurationMs: Number(parsed.sampleDurationMs ?? 0),
    enrolledAtMs: Number(parsed.enrolledAtMs ?? Date.now()),
    speechRatio: parsed.speechRatio == null ? undefined : Number(parsed.speechRatio),
    qualityScore: parsed.qualityScore == null ? undefined : Number(parsed.qualityScore),
  };
}

function prepareSession(config: CaptionConfig) {
  overlaySuppressed = config.mode === 'subtitle' ? false : overlaySuppressed;
  if (config.mode === 'subtitle') {
    initSaveFile();
    meetingTranscriptFilePath = null;
  } else if (config.mode === 'meeting') {
    saveFilePath = null;
    initMeetingTranscriptFile();
  } else {
    saveFilePath = null;
    meetingTranscriptFilePath = null;
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
    overlayWindow.setBounds(getDictationOverlayBounds());
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
  const updateMenuLabel = updateStatus === 'checking'
    ? '檢查更新中…'
    : updateStatus === 'downloading'
      ? '下載更新中…'
      : updateStatus === 'downloaded'
        ? '重新啟動以完成更新'
        : '檢查更新';
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
      label: updateMenuLabel,
      enabled: shouldEnableAutoUpdater() && updateStatus !== 'checking' && updateStatus !== 'downloading',
      click: () => {
        if (updateStatus === 'downloaded') {
          autoUpdater.quitAndInstall();
          return;
        }
        void checkForAppUpdates(true);
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
  const trayIconPath = getTrayIconPath();
  const fileImage = nativeImage.createFromPath(trayIconPath);
  const trayImage = createTrayImage();
  traceMain(`createTray iconPath=${trayIconPath} file=${describeNativeImage(fileImage)} tray=${describeNativeImage(trayImage)}`);
  tray = new Tray(trayImage);
  tray.setTitle('');
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
  const bounds = overlayWindow.getBounds();
  if (overlayMode === 'dictation') {
    dictationOverlayBoundsCache = bounds;
    return;
  }
  subtitleOverlayBoundsCache = bounds;
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
  bridge.on('meeting_caption', (event: SidecarEvent) => {
    appendMeetingCaption(event);
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

function shouldEnableAutoUpdater() {
  return isPackaged && !isDev;
}

async function showUpdateInfo(message: string, detail?: string) {
  const options: MessageBoxOptions = {
    type: 'info',
    message,
    detail,
    buttons: ['知道了'],
    defaultId: 0,
  };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    await dialog.showMessageBox(settingsWindow, options);
    return;
  }
  await dialog.showMessageBox(options);
}

function setupAutoUpdater() {
  if (!shouldEnableAutoUpdater()) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateStatus = 'checking';
    rebuildTrayMenu();
  });

  autoUpdater.on('update-available', async (info) => {
    updateStatus = 'downloading';
    rebuildTrayMenu();
    if (manualUpdateCheckPending) {
      manualUpdateCheckPending = false;
      await showUpdateInfo(
        `發現新版本 ${info.version}`,
        'BiCaption 正在背景下載更新，完成後會提示重新啟動。',
      );
    }
  });

  autoUpdater.on('update-not-available', async () => {
    updateStatus = 'idle';
    rebuildTrayMenu();
    if (manualUpdateCheckPending) {
      manualUpdateCheckPending = false;
      await showUpdateInfo('目前已是最新版本');
    }
  });

  autoUpdater.on('error', async (error) => {
    updateStatus = 'idle';
    rebuildTrayMenu();
    traceMain(`autoUpdater error=${String(error)}`);
    if (manualUpdateCheckPending) {
      manualUpdateCheckPending = false;
      const options: MessageBoxOptions = {
        type: 'error',
        message: '檢查更新失敗',
        detail: error instanceof Error ? error.message : String(error),
        buttons: ['知道了'],
      };
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        await dialog.showMessageBox(settingsWindow, options);
      } else {
        await dialog.showMessageBox(options);
      }
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    updateStatus = 'downloaded';
    rebuildTrayMenu();
    const options: MessageBoxOptions = {
      type: 'info',
      message: `BiCaption ${info.version} 已下載完成`,
      detail: '重新啟動後會自動安裝更新。',
      buttons: ['稍後', '立即重新啟動'],
      defaultId: 1,
      cancelId: 0,
    };
    const result = settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showMessageBox(settingsWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 1) {
      autoUpdater.quitAndInstall();
    }
  });
}

async function checkForAppUpdates(manual = false) {
  if (!shouldEnableAutoUpdater()) {
    if (manual) {
      await showUpdateInfo('目前是開發模式或未打包版本，未啟用自動更新。');
    }
    return;
  }

  manualUpdateCheckPending = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    updateStatus = 'idle';
    rebuildTrayMenu();
    traceMain(`checkForAppUpdates failed=${String(error)}`);
    if (manual) {
      manualUpdateCheckPending = false;
      const options: MessageBoxOptions = {
        type: 'error',
        message: '檢查更新失敗',
        detail: error instanceof Error ? error.message : String(error),
        buttons: ['知道了'],
      };
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        await dialog.showMessageBox(settingsWindow, options);
      } else {
        await dialog.showMessageBox(options);
      }
    }
  }
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

function requestAccessibilityPermission() {
  if (process.platform !== 'darwin') {
    return { trusted: true, status: 'not-applicable' };
  }
  const trusted = systemPreferences.isTrustedAccessibilityClient(true);
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

async function openAccessibilitySettings() {
  if (process.platform !== 'darwin') {
    return { ok: false };
  }
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  return { ok: true };
}

app.whenReady().then(() => {
  traceMain('app.whenReady entered');
  createSettingsWindow();
  createOverlayWindow();
  createTray();
  setupAutoUpdater();
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
  ipcMain.handle('permissions:request-accessibility', () => requestAccessibilityPermission());
  ipcMain.handle('permissions:open-accessibility', () => openAccessibilitySettings());
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
  ipcMain.handle('meeting:enroll-local-speaker', async (_event, request: MeetingEnrollSpeakerRequest) => {
    const hasAccess = await ensureMicrophoneAccess();
    if (!hasAccess) {
      throw new Error('Microphone permission was denied. Allow microphone access in System Settings and restart the app.');
    }
    if (!request?.deviceId) {
      throw new Error('A microphone device must be selected before speaker enrollment.');
    }
    return runMeetingLocalSpeakerEnrollment(request);
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
  ipcMain.handle('meeting:generate-notes', (_event, request: MeetingNotesRequest) => {
    return runMeetingNotesGeneration(request);
  });
  ipcMain.handle('meeting:export-report', (_event, request: MeetingReportRequest) => {
    return runMeetingReportExport(request);
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

  if (shouldEnableAutoUpdater()) {
    setTimeout(() => {
      void checkForAppUpdates(false);
    }, 3000);
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
