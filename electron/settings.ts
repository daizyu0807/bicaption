import Store from 'electron-store';
import type { AppSettings } from './types.js';

function normalizeDictationRewriteMode(mode: AppSettings['dictationRewriteMode'] | undefined): AppSettings['dictationRewriteMode'] {
  if (mode === 'rules-and-local-llm') {
    return mode;
  }
  return 'rules';
}

export const defaultSettings: AppSettings = {
  deviceId: '',
  subtitleDeviceId: '',
  dictationDeviceId: '',
  outputDeviceId: '',
  dictationSttModel: 'sensevoice',
  dictationSourceLang: 'zh-TW',
  dictationHotkey: {
    keyCode: 59,
    modifiers: [],
  },
  sourceLang: 'zh-TW',
  targetLang: 'zh-TW',
  sttModel: 'sensevoice',
  translateModel: 'disabled',
  subtitleChunkMs: 400,
  subtitlePartialStableMs: 500,
  subtitleVadMode: 'aggressive',
  dictationChunkMs: 400,
  dictationEndpointMs: 1200,
  dictationVadMode: 'conservative',
  chunkMs: 400,
  partialStableMs: 500,
  beamSize: 1,
  bestOf: 1,
  vadFilter: false,
  conditionOnPrev: false,
  dictationOutputAction: 'copy',
  dictationRewriteMode: 'rules-and-local-llm',
  dictationDictionaryEnabled: true,
  dictationCloudEnhancementEnabled: false,
  dictationOutputStyle: 'polished',
  dictationMaxRewriteExpansionRatio: 1.3,
  dictationDictionaryText: '',
  dictationLocalLlmModel: 'mlx-community/Qwen2.5-3B-Instruct-4bit',
  dictationLocalLlmRunner: '',
  meetingMicDeviceId: '',
  meetingSystemAudioDeviceId: '',
  meetingSourceMode: 'dual',
  meetingSourceLang: 'auto',
  meetingTargetLang: 'zh-TW',
  meetingSttModel: 'moonshine',
  meetingTranslateModel: 'google',
  meetingSpeakerLabelsEnabled: true,
  meetingMicrophoneLabel: '我方',
  meetingSystemLabel: '遠端',
  meetingNotesPrompt: `請根據以下會議逐字稿整理成結構化會議記錄。

輸出要求：
1. 先給一段中文摘要
2. 列出主要決策
3. 列出 action items 與負責人
4. 列出待確認事項與風險
5. 若 transcript 中有 speaker label，請保留`,
  meetingSaveTranscript: true,
  meetingTranscriptDirectory: '',
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
    dictationSourceLang: stored.dictationSourceLang ?? stored.sourceLang ?? defaultSettings.dictationSourceLang,
    subtitleChunkMs: stored.subtitleChunkMs ?? stored.chunkMs ?? defaultSettings.subtitleChunkMs,
    subtitlePartialStableMs: stored.subtitlePartialStableMs ?? stored.partialStableMs ?? defaultSettings.subtitlePartialStableMs,
    dictationChunkMs: stored.dictationChunkMs ?? stored.chunkMs ?? defaultSettings.dictationChunkMs,
    dictationRewriteMode: normalizeDictationRewriteMode(stored.dictationRewriteMode),
    dictationCloudEnhancementEnabled: false,
    meetingMicDeviceId: stored.meetingMicDeviceId ?? legacyDeviceId ?? '',
    meetingSystemAudioDeviceId: stored.meetingSystemAudioDeviceId ?? stored.outputDeviceId ?? '',
    meetingSourceLang: stored.meetingSourceLang ?? stored.sourceLang ?? defaultSettings.meetingSourceLang,
    meetingTargetLang: stored.meetingTargetLang ?? stored.targetLang ?? defaultSettings.meetingTargetLang,
    meetingSttModel: stored.meetingSttModel ?? defaultSettings.meetingSttModel,
    meetingTranslateModel: stored.meetingTranslateModel ?? stored.translateModel ?? defaultSettings.meetingTranslateModel,
    meetingSourceMode: stored.meetingSourceMode ?? defaultSettings.meetingSourceMode,
    meetingSpeakerLabelsEnabled: stored.meetingSpeakerLabelsEnabled ?? defaultSettings.meetingSpeakerLabelsEnabled,
    meetingMicrophoneLabel: stored.meetingMicrophoneLabel ?? defaultSettings.meetingMicrophoneLabel,
    meetingSystemLabel: stored.meetingSystemLabel ?? defaultSettings.meetingSystemLabel,
    meetingNotesPrompt: stored.meetingNotesPrompt ?? defaultSettings.meetingNotesPrompt,
    meetingSaveTranscript: stored.meetingSaveTranscript ?? defaultSettings.meetingSaveTranscript,
    meetingTranscriptDirectory: stored.meetingTranscriptDirectory ?? stored.saveDirectory ?? defaultSettings.meetingTranscriptDirectory,
  };
  return current;
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  store.set(partial);
  return loadSettings();
}
