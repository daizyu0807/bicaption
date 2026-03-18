# SayIt Localization Implementation Checklist

## Goal

將 [2026-03-17-sayit-localization-integration-plan.md](/Users/davedai/Project/tools/realtime-bilingual-subtitles/docs/plans/2026-03-17-sayit-localization-integration-plan.md) 拆成可直接執行的實作任務，避免在開發過程中重新討論已定案的架構前提。

## Execution Order

1. 先確定 hotkey / 權限主路徑
2. 再重構 session / event 邊界
3. 再做 dictation pipeline
4. 最後補本地 rewrite、paste、驗證與效能

## Phase 0: Feasibility Gate

### Task 0.1 Native Hotkey Listener 選型

- 目標：確認可在 macOS 上穩定監聽全域 `keydown/keyup`
- 候選：
  - Swift / Objective-C helper
  - 第三方 native listener 套件
- 產出：
  - 選型結論
  - 權限需求清單
  - 事件格式定義
- 驗收：
  - 能在背景狀態收到 hotkey keydown 與 keyup
  - 能辨識缺權限狀態
  - 不阻塞 Electron main thread

### Task 0.2 權限模型確認

- 目標：分清 `Input Monitoring`、`Accessibility`、`Microphone` 的檢查與提示流程
- 產出：
  - 權限狀態列舉
  - 設定頁文案
  - fallback 規則
- 驗收：
  - 每種缺權限情境都有明確降級行為
  - 不出現 silent failure

## Phase 1: Core Protocol Refactor

### Task 1.1 擴充 Session Config

- 更新 [types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts)
- 加入：
  - `mode`
  - `sessionId`
  - dictation 相關 config
- 驗收：
  - `subtitle` 與 `dictation` 都可透過同一個 `start_session` 協定表達

### Task 1.2 擴充 Sidecar Event Model

- 所有 event 加入：
  - `mode`
  - `sessionId`
- 新增事件：
  - `dictation_state`
  - `dictation_final`
  - `session_stopped_ack`
- 驗收：
  - renderer 與 main 能依 `mode` / `sessionId` 分流
  - 不再依賴單一 `type` 判斷全部流程

### Task 1.3 Session Stop Ack

- 更新 main-sidecar 協定
- `stop_session` 後必須等 `session_stopped_ack`
- main process 增加 `switching` guard
- 驗收：
  - 模式切換不會殘留雙 session
  - 快速連續切換不會重複佔用麥克風

## Phase 2: Electron Main / UI Wiring

### Task 2.1 Hotkey Backend Abstraction

- main process 建立 hotkey backend 抽象：
  - `native-listener`
  - `globalShortcut-fallback`
  - `in-app-hold-to-talk`
- 驗收：
  - 可以在不改 dictation 主流程的前提下切換 hotkey backend

### Task 2.2 權限檢查 IPC

- 新增 IPC：
  - `permissions:check-accessibility`
  - `permissions:check-input-monitoring`
  - 必要時補 `permissions:check-microphone`
- 驗收：
  - renderer 可讀取權限狀態
  - 設定頁可手動重檢

### Task 2.3 Settings Migration

- 更新 settings schema 與 defaults
- 需要處理：
  - 舊版設定缺少 dictation 欄位
  - hotkey 格式未來可能從 Electron accelerator 遷移
- 驗收：
  - 舊設定檔可正常載入
  - 不因缺欄位 crash

### Task 2.4 Dictation UI State

- renderer 拆出 dictation state
- 不與現有 caption overlay state 共用 reducer
- 驗收：
  - dictation 與 subtitle 切換時 UI 不混線
  - overlay 僅在 subtitle mode 顯示

## Phase 3: Dictation Audio Pipeline

### Task 3.1 Sidecar Dictation Session

- sidecar 依 `mode=dictation` 走單次收音流程
- `keydown` 開始錄音
- `keyup` 停止並 finalize
- 驗收：
  - 單次 dictation 可輸出單個 final 結果
  - 不產生字幕導向的持續 caption event

### Task 3.2 模型生命週期策略

- 定義：
  - STT 是否常駐
  - rewriter 是否常駐
  - idle unload 條件
- 優先目標：
  - hot path 達標
  - cold path 有明確量測
- 驗收：
  - 能區分 cold/warm latency
  - session stop 不必然 unload 模型

### Task 3.3 過短語音與空輸出處理

- 加入：
  - minimum duration threshold
  - empty transcript handling
- 驗收：
  - 極短按壓不觸發 STT
  - 空結果不觸發 rewrite / paste

## Phase 4: Rewrite Layer

### Task 4.1 Rules Rewriter

- 實作保守清理：
  - filler words
  - 重複詞
  - 空白 / 標點
  - 簡轉繁
- 驗收：
  - 不做語意改寫
  - 不破壞英文大小寫

### Task 4.2 語言判斷策略

- 優先順序：
  - `detected_lang`
  - `sourceLang`
  - conservative fallback
- 驗收：
  - unknown language 時只套最保守規則

### Task 4.3 Local LLM Provider Abstraction

- 定義 provider interface
- 實作 fallback to rules
- 驗收：
  - provider 不可用時流程不中斷
  - warning event 可被 UI 接收

## Phase 5: Output Layer

### Task 5.1 Clipboard Output

- main process 實作 `copy`
- 驗收：
  - `dictation_final` 可穩定寫入 clipboard

### Task 5.2 Auto-paste Safety Gate

- `keyup` 當下記錄前景 app / window
- paste 前再次比對
- 焦點改變則降級 `copy`
- 驗收：
  - 不會把文字貼到切換後的錯誤視窗

### Task 5.3 Optional Enter After Paste

- 補 `autoEnterAfterPaste`
- 驗收：
  - 僅在 `paste` / `copy-and-paste` 有效
  - 權限不足時不會誤送 Enter

## Phase 6: Tests

### Task 6.1 Unit Tests

- rewrite rules
- language decision
- settings migration
- mode/sessionId event routing

### Task 6.2 Integration Tests

- subtitle mode regression
- dictation happy path
- session stop ack
- fallback when permissions missing
- fallback when local LLM unavailable
- fallback when focus changes before paste

### Task 6.3 Manual Verification

- Notes / TextEdit / ChatGPT Desktop paste
- 快速連按 / 模式切換
- 冷啟動 / 熱啟動延遲
- 不同 macOS 版本權限流程

## Suggested Implementation Slices

### Slice A

- Phase 0
- Phase 1.1
- Phase 1.2

### Slice B

- Phase 1.3
- Phase 2.1
- Phase 2.2

### Slice C

- Phase 2.3
- Phase 2.4
- Phase 3.1

### Slice D

- Phase 3.2
- Phase 3.3
- Phase 4.1
- Phase 4.2

### Slice E

- Phase 4.3
- Phase 5.1
- Phase 5.2
- Phase 5.3

### Slice F

- Phase 6 全部

## Exit Criteria

- 可用 `native key listener` 完成 press-to-talk / release-to-finalize
- subtitle mode 無回歸
- dictation mode 可穩定 copy / paste
- paste 有焦點安全降級
- session 切換不殘留雙 session
- settings migration 完整
- hot path 與 cold path latency 都有量測結果
