# SayIt Localization Review Verification

## Scope

本文檢視 Gemini 對 [2026-03-17-sayit-localization-integration-plan.md](/Users/davedai/Project/tools/realtime-bilingual-subtitles/docs/plans/2026-03-17-sayit-localization-integration-plan.md) 的 review 回饋，目標是區分：

- 已查證成立，應直接納入規劃
- 方向合理，但需要降階表述
- 證據不足，不應直接寫入規劃

## Inputs Checked

- Electron 官方 `globalShortcut` 文件
- 現有專案 Electron main / sidecar / event type / caption state 實作

本次重點查證檔案：

- [main.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/main.ts)
- [types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts)
- [sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py)
- [caption-state.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/caption-state.ts)

## Verdict Summary

### 1. `globalShortcut` 無法支援 `keyup`

判斷：成立，應直接納入規劃。

依據：

- Electron 官方文件只提供 `globalShortcut.register(accelerator, callback)`，callback 在 shortcut 被按下時觸發，沒有 `keyup` 事件模型。
- 原始規劃將 `globalShortcut` 作為「按住說話、放開完成」的主觸發方案，與 API 能力不對齊。

結論：

- 若產品交互維持 press-to-talk / release-to-finalize，則不能只依賴 Electron `globalShortcut`。
- 規劃必須補一個可監聽全域 key down/up 的原生層方案。

建議寫法：

- 將 `globalShortcut` 降為「單擊觸發、fallback、或設定頁 hotkey 註冊檢查」用途。
- 另列 `native hotkey listener` 為 dictation 主路徑前提。

## 2. `auto-paste` 可能貼到錯誤前景 app

判斷：成立，但屬於設計風險，不是已被證明的現存 bug。

依據：

- 規劃允許 `keyup -> STT -> rewrite -> paste` 間存在秒級延遲。
- 若使用者在這段時間切換前景 app，貼上目標可能改變。

結論：

- 規劃應補焦點一致性檢查與安全降級機制。
- 這不是不可實作的 blocker，但若省略，會造成錯貼與潛在隱私風險。

建議寫法：

- 在 `keyup` 當下記錄前景 app / window。
- 執行 paste 前再次比對。
- 若焦點已變更，降級為 `copy` 並提示使用者。

## 3. `dictation` / `subtitle` 事件邊界不足

判斷：成立，且有現有架構依據。

依據：

- 現有事件型別只有 `type` 與字幕相關資料，沒有 `sessionId` 或 `mode`，見 [types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts#L18)。
- Electron main 直接將所有 sidecar 事件廣播到 `sidecar:event`，見 [main.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/main.ts#L166)。
- UI reducer 只按 `event.type` 併入狀態，見 [caption-state.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/caption-state.ts#L28)。

結論：

- 若未來加入 `dictation_final`、`dictation_state`，且 subtitle/dictation 共用 sidecar 或共享 renderer state，模式切換邊界確實可能混線。

建議寫法：

- 新增 `mode`。
- 較穩妥的作法是新增 `sessionId + mode`。
- 規劃應要求所有 sidecar event 與 IPC payload 明確帶出這兩個邊界資訊。

## 4. 記憶體壓力與模型載入成本

判斷：方向合理，但 Gemini 的表述過度確定，不應照抄。

依據：

- 現有 sidecar 在 `start_session()` 內建立 transcriber，見 [sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py#L1105)。
- `stop_session()` 會釋放 transcriber，見 [sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py#L1149)。
- 這代表若 dictation 沿用現有 session lifecycle，冷啟動延遲與模型重載成本確實要進入規劃。

不確定之處：

- 目前還沒選定 local LLM provider，也尚未定義是否常駐載入。
- 現有專案也包含 `apple-stt` 路徑，不是所有模式都會走重模型。
- 因此「8GB 一定 swap」或「一定達不到」屬於未查證推斷。

結論：

- 應修正的是規劃中的效能預算與模型生命週期假設不一致。
- 不應直接寫成某種硬體上必然失敗。

建議寫法：

- 將效能預算拆成 `cold start` / `warm start`。
- 明確要求 dictation V1 的 STT/rewriter lifecycle 策略。
- 對 `local-llm` 只寫「可能導致預算超標，需要常駐或顯式 opt-in」，不要直接下結論說某種 RAM 規格一定失敗。

## 5. Accessibility 權限授予後是否一定要重啟

判斷：證據不足，不應直接納入硬性結論。

依據：

- 目前查到的材料不足以支持「授權後必須重啟 app」這種強斷言。
- 但從產品設計角度，權限變更後應提供重新檢查機制，這一點合理。

結論：

- 不建議在規劃中寫死「必須重啟」。
- 可以要求補一個手動重檢或狀態刷新流程。

建議寫法：

- `paste` 相關設定頁需提供權限狀態檢查與重新驗證入口。
- 若授權當下未立即生效，UI 應明確提示後續動作，而不是先假設一定要重啟。

## Recommended Plan Changes

- 將 `native hotkey down/up listener` 補成 dictation 主方案前提。
- `globalShortcut` 改為輔助用途，不再承擔 `keyup`。
- 對 paste 流程新增前景 app 一致性檢查與 `copy` 降級。
- 在事件模型中加入 `mode`，最好加入 `sessionId`。
- 將效能預算拆成冷啟動與熱啟動，並明示模型生命週期策略。
- Accessibility 章節補「重檢權限狀態」，不要寫死「必須重啟」。

## Final Assessment

Gemini 的回饋不是全部都要照單全收，但其中有三個重點值得直接採納：

- `globalShortcut` 與 `keyup` 能力不匹配
- auto-paste 的焦點競態
- subtitle / dictation 的事件邊界不足

其餘像記憶體壓力與 Accessibility 重啟需求，應視為需要收斂表述的風險提示，而不是既定事實。
