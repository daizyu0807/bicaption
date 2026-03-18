import type { AppSettings, CaptionConfig, ModelDownloadProgress, ModelStatus, OverlayBounds, SidecarEvent } from '../electron/types.js';

type SubscribeMap = {
  'sidecar:event': SidecarEvent;
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
      checkInputMonitoringPermission(): Promise<{ trusted: boolean; available: boolean; detail?: string }>;
      subscribe<K extends keyof SubscribeMap>(
        eventName: K,
        handler: (payload: SubscribeMap[K]) => void,
      ): () => void;
    };
  }
}

export {};
