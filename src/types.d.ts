import type { AppSettings, CaptionConfig, OverlayBounds, SidecarEvent } from '../electron/types.js';

declare global {
  interface Window {
    app: {
      loadSettings(): Promise<AppSettings>;
      saveSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
      startSession(config: CaptionConfig): Promise<{ ok: boolean }>;
      stopSession(): Promise<{ ok: boolean }>;
      listDevices(): Promise<Array<{ id: string; label: string }>>;
      showSettings(): Promise<{ ok: boolean }>;
      getOverlayBounds(): Promise<OverlayBounds>;
      setOverlayBounds(bounds: Partial<OverlayBounds>): Promise<OverlayBounds>;
      showOverlay(): Promise<{ ok: boolean }>;
      hideOverlay(): Promise<{ ok: boolean }>;
      chooseSaveDirectory(): Promise<string | null>;
      openSaveDirectory(): Promise<{ ok: boolean }>;
      subscribe(
        eventName: 'sidecar:event' | 'settings:changed',
        handler: (payload: SidecarEvent | AppSettings) => void,
      ): () => void;
    };
  }
}

export {};
