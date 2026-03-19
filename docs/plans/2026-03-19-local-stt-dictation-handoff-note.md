# BiCaption Local STT / Dictation Handoff Note

## Current Status

- 架構 spec 已完成：
  - [2026-03-19-local-stt-dictation-architecture-spec.md](/Users/davedai/Project/tools/realtime-bilingual-subtitles/docs/plans/2026-03-19-local-stt-dictation-architecture-spec.md)
- `cross-think` 已跑過 Gemini，Claude 短 prompt 也驗證過核心結論。
- 已開始進入 `Phase 1`。

## Decisions Already Locked

- `subtitle` 與 `dictation` 必須分流。
- `subtitle` 不做 LLM rewrite。
- `dictation` 的處理順序固定為：
  - `ASR -> dictionary -> LLM rewrite`
- `dictation` 必須保留：
  - `literalTranscript`
  - `finalText`
- cloud enhancement 只先放在 `dictation`。

## Phase 1 Scope

這一輪只做基礎掛點，不做真正的 dictionary / LLM：

- 擴充 `AppSettings`
- 擴充 `DictationFinalEvent`
- 更新 settings migration
- 讓 subtitle / dictation 用不同 config 值建 session
- 讓 main process 支援 `literal` / `polished` output style
- sidecar 暫時回傳：
  - `literalTranscript`
  - `dictionaryText`
  - `finalText`
  三者相同，`rewriteBackend = disabled`

## Files To Touch First

- [types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts)
- [settings.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/settings.ts)
- [App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx)
- [dictation-state.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/dictation-state.ts)
- [main.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/main.ts)
- [sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py)

## Next Steps

1. 跑 TypeScript / Python tests，修掉 Phase 1 型別與事件回歸。
2. 補 `dictationOutputStyle` 的 UI 控制項。
3. 進入 dictionary layer：
   - store
   - deterministic correction
   - tests

## Known Gaps

- Claude 長 prompt 的 `cross-think` 在目前 CLI 環境下仍不穩。
- BiCaption 的 `docs/` 目錄被 ignore；提交文件需要 `git add -f`。
