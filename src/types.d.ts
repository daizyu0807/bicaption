import type { AppSettings, CaptionConfig, DictationHotkeyBinding, DictationHotkeyEvent, DictationOutputStatusEvent, MeetingNotesRequest, MeetingNotesResult, MeetingReportRequest, MeetingReportResult, ModelDownloadProgress, ModelStatus, OverlayBounds, SidecarEvent } from '../electron/types.js';

type SubscribeMap = {
  'sidecar:event': SidecarEvent;
  'dictation:hotkey-event': DictationHotkeyEvent;
  'dictation:output-status': DictationOutputStatusEvent;
  'overlay:mode': { mode: 'hidden' | 'subtitle' | 'dictation' };
  'settings:changed': AppSettings;
  'models:progress': ModelDownloadProgress;
  'models:done': ModelStatus;
  'models:error': string;
};

declare global {
  interface Window {
    app: {
      loadSettings(): Promise<AppSettings>;
      saveSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
      startSession(config: CaptionConfig): Promise<{ ok: boolean }>;
      stopSession(): Promise<{ ok: boolean }>;
      listDevices(): Promise<Array<{ id: string; label: string; kind: string }>>;
      showSettings(): Promise<{ ok: boolean }>;
      getOverlayPosition(): Promise<[number, number]>;
      setOverlayPosition(x: number, y: number): Promise<void>;
      getOverlayBounds(): Promise<OverlayBounds>;
      setOverlayBounds(bounds: Partial<OverlayBounds>): Promise<OverlayBounds>;
      showOverlay(): Promise<{ ok: boolean }>;
      hideOverlay(): Promise<{ ok: boolean }>;
      chooseSaveDirectory(): Promise<string | null>;
      openSaveDirectory(): Promise<{ ok: boolean }>;
      checkModels(): Promise<ModelStatus>;
      downloadModels(): Promise<{ ok: boolean }>;
      downloadModel(modelKey: string): Promise<{ ok: boolean }>;
      checkAccessibilityPermission(): Promise<{ trusted: boolean; status: string }>;
      requestAccessibilityPermission(): Promise<{ trusted: boolean; status: string }>;
      openAccessibilitySettings(): Promise<{ ok: boolean }>;
      checkInputMonitoringPermission(): Promise<{ trusted: boolean; available: boolean; detail?: string }>;
      requestInputMonitoringPermission(): Promise<{ trusted: boolean; available: boolean; detail?: string }>;
      openInputMonitoringSettings(): Promise<{ ok: boolean }>;
      testDictationHotkey(binding: DictationHotkeyBinding): Promise<{ ok: boolean }>;
      stopDictationHotkeyTest(): Promise<{ ok: boolean }>;
      generateMeetingNotes(request: MeetingNotesRequest): Promise<MeetingNotesResult>;
      exportMeetingReport(request: MeetingReportRequest): Promise<MeetingReportResult>;
      subscribe<K extends keyof SubscribeMap>(
        eventName: K,
        handler: (payload: SubscribeMap[K]) => void,
      ): () => void;
    };
  }
}

export {};
