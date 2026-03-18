# SayIt Localization Progress

## Resume Point

本檔記錄 `realtime-bilingual-subtitles` 的 SayIt 本地化工作目前做到哪裡，供中斷後快速恢復。

- 主要計畫：
  - [2026-03-17-sayit-localization-integration-plan.md](/Users/davedai/Project/tools/realtime-bilingual-subtitles/docs/plans/2026-03-17-sayit-localization-integration-plan.md)
  - [2026-03-18-sayit-localization-implementation-checklist.md](/Users/davedai/Project/tools/realtime-bilingual-subtitles/docs/plans/2026-03-18-sayit-localization-implementation-checklist.md)
  - [2026-03-18-sayit-localization-review-verification.md](/Users/davedai/Project/tools/realtime-bilingual-subtitles/docs/plans/2026-03-18-sayit-localization-review-verification.md)
- 本次恢復點：
  - 目前中斷在 `Slice C` 的早期實作，主題是 `dictation` 事件模型與 sidecar 行為接線。
  - 直接卡點是 Python sidecar 已送出 `dictation_state` / `dictation_final`，但 TypeScript 事件契約尚未完全對齊。

## Status By Slice

### Slice A

- `Phase 0.1 Native Hotkey Listener 選型`
  - 部分完成
  - 已有 Swift helper 與 Electron bridge：
    - [global-hotkey.swift](/Users/davedai/Project/tools/realtime-bilingual-subtitles/swift/global-hotkey.swift)
    - [native-hotkey.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/native-hotkey.ts)
    - [build-global-hotkey.sh](/Users/davedai/Project/tools/realtime-bilingual-subtitles/scripts/build-global-hotkey.sh)
  - Electron main 已開始將 `hotkey_down` / `hotkey_up` 接到實際 dictation start/stop 流程。
- `Phase 0.2 權限模型確認`
  - 部分完成
  - 已有 Accessibility / Input Monitoring 檢查 IPC 與 UI 測試面板，但尚未完成正式 fallback 流程。
- `Phase 1.1 擴充 Session Config`
  - 已完成
  - `CaptionConfig` 已包含 `mode` 與 `sessionId`。
- `Phase 1.2 擴充 Sidecar Event Model`
  - 進行中
  - `mode` / `sessionId` 已進入事件模型，`session_stopped_ack` 已存在。
  - `dictation_state` / `dictation_final` 已開始接入，Electron main 也已補上事件轉發。
  - 目前剩 renderer 的專用 state 與 output layer 尚未接上。

### Slice B

- `Phase 1.3 Session Stop Ack`
  - 部分完成
  - [sidecar.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/sidecar.ts) 已等待 `session_stopped_ack` 或 `session_state=stopped`。
  - Electron main 的完整 `switching` guard 尚未補完。
- `Phase 2.1 Hotkey Backend Abstraction`
  - 部分完成
  - 已有 native listener 測試路徑，但尚未抽象成完整 backend 切換層。
- `Phase 2.2 權限檢查 IPC`
  - 大致完成
  - 已有 `permissions:check-accessibility` 與 `permissions:check-input-monitoring`。

### Slice C

- `Phase 2.3 Settings Migration`
  - 尚未開始
- `Phase 2.4 Dictation UI State`
  - 已開始
  - renderer 已有獨立 dictation reducer 與最小觀察面板，不再和 subtitle caption reducer 共用狀態。
  - 已補 app 內手動 start/stop dictation，作為 fallback 與除錯入口。
  - hotkey 驅動的 dictation start/stop 已接進 main process，但正式 UX 與設定化綁定仍未完成。
- `Phase 3.1 Sidecar Dictation Session`
  - 進行中
  - Python sidecar 已開始分流 `mode=dictation`，並在 finalize 前緩存 transcript。
  - renderer / main 已可消費 `dictation_final`，但真正的 start/stop UX 尚未接完。

### Slice E

- `Phase 5.1 Clipboard Output`
  - 已開始
  - Electron main 已在收到 `dictation_final` 時將文字寫入 clipboard。
  - 已補 `dictationOutputAction` 設定欄位。
  - `paste` / `copy-and-paste` 目前仍明確降級為 clipboard fallback，尚未接真正 paste 流程。

## Interrupted Changes

目前未提交且直接相關的檔案：

- [types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts)
- [sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py)
- [test_sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/tests/test_sidecar.py)
- [caption-state.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/caption-state.ts)
- [caption-state.test.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/tests/caption-state.test.ts)

中斷前已確認的問題：

- Python sidecar 送出 `dictation_state=recording|capturing|stopped`。
- TypeScript 型別原本只接受 `idle|recording|processing|done|error`。
- `dictation_final` 事件額外包含 `chunkCount`，但 TypeScript 型別尚未描述。

## Next Actions

1. 把 `paste` / `copy-and-paste` 接成真正的 paste 流程與安全降級。
2. 把 dictation hotkey binding 從硬編碼改成 settings 驅動。
3. 最後再決定是否往 `Phase 5.2 Auto-paste Safety Gate` 延伸。

## Verification Notes

- `npm run type-check`
  - 已於本次恢復中重新驗證通過。
- `python3 -m unittest python.tests.test_sidecar`
  - 已於本次恢復中重新驗證通過。
- `npm test`
  - 目前在此 sandbox 內會因 `tsx` 建立 IPC pipe 被拒而失敗，需要在允許權限的環境下執行，或改用替代測試命令。
