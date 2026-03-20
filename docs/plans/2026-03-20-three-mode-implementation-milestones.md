# BiCaption Three-Mode Implementation Milestones

## Goal

把 [2026-03-20-three-mode-product-architecture-spec.md](/Users/davedai/Project/tools/realtime-bilingual-subtitles/docs/plans/2026-03-20-three-mode-product-architecture-spec.md) 拆成可執行的里程碑、檔案落點與驗證方式，讓後續開發可直接照表推進。

## Milestone 0: Foundation

目標：

- 先把三模式的抽象層切乾淨
- 避免後續把 `雙語字幕`、`語音輸入`、`會議字幕` 再塞回同一份 session state

### Tasks

- 擴充 [electron/types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts)
  - 新增 `mode: 'subtitle' | 'dictation' | 'meeting'`
  - 新增 `MeetingCaptionEvent`
  - 新增 `MeetingNotesRequest`
  - 新增 `MeetingNotesResult`
- 重構 [electron/settings.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/settings.ts)
  - 加入 `meeting*` 系列設定欄位
  - 明確切開 `subtitle` / `dictation` / `meeting` 的引擎與延遲參數
- 重構 [src/App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx)
  - settings sidebar 固定四頁：
    - `雙語字幕`
    - `語音輸入`
    - `模型`
    - `會議字幕`
- 建立共用 audio routing 抽象
  - 優先落在 [electron/main.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/main.ts) 與 [python/sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py) 的 session config contract

### Exit Criteria

- 三模式的設定欄位不再互相污染
- 新模式 `meeting` 可以被建立但還不用完整運作
- 型別檢查與既有測試仍通過

## Milestone 1: Subtitle Streaming Upgrade

目標：

- 把 `雙語字幕` 的 streaming path 從目前對 `Apple STT` 的依賴中抽離
- 建立 `Moonshine` 導入掛點

### Tasks

- 在 [python/sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py) 增加 streaming ASR provider interface
  - `moonshine`
  - `sensevoice`
  - `apple-stt`
- 在 [src/App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx) 的 `雙語字幕` 頁增加 streaming engine 選擇
- 在 [scripts/](/Users/davedai/Project/tools/realtime-bilingual-subtitles/scripts) 或 [python/](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python) 增加 Moonshine 安裝/檢測流程
- 保持翻譯層與 ASR provider 解耦

### Exit Criteria

- `雙語字幕` 可切換 `Moonshine` 與既有引擎
- 可跑通：
  - `system audio -> streaming ASR -> translation -> overlay`
- 能量測基本 latency 與 hallucination 率

## Milestone 2: Dictation Quality Path Upgrade

目標：

- 把 `語音輸入` 的 batch / high-quality path 切到 `MLX Whisper`
- 保持現有 `rules + dictionary + local LLM` 流程可持續沿用

### Tasks

- 在 [python/sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py) 新增 `MLX Whisper` batch provider
- 對齊 [python/local-llm-rewrite.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/local-llm-rewrite.py) 的輸入契約
- 擴充 [src/App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx) 的 dictation engine 選項
- 保留 `literalTranscript` / `dictionaryText` / `finalText`

### Exit Criteria

- `語音輸入` 可選 `MLX Whisper`
- 繁中 dictation 的錯字修正與通順度優於現行基線
- end-to-end latency 在可接受範圍內

## Milestone 3: Meeting Mode Skeleton

目標：

- 建立 `會議字幕` 的最小可用骨架
- 先不追求 speaker naming，而是先有雙來源、即時翻譯、時間線保存

### Tasks

- 在 [src/App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx) 新增 `會議字幕` 設定頁
- 在 [electron/main.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/main.ts) 建立 meeting session lifecycle
- 在 [python/sidecar.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py) 增加：
  - mic + system audio capture
  - per-source event emission
  - target-language translation output
- 增加 transcript persistence

### Exit Criteria

- 可以同時吃麥克風和系統音訊
- 可以即時顯示翻譯字幕
- 會議結束後可以回看時間線 transcript

## Milestone 4: Speaker-Aware Meeting Mode

目標：

- 把 `會議字幕` 從雙來源字幕升級成可標識發言者的會議模式

### Tasks

- 定義 speaker/source attribution 策略
  - 第一階段允許只有：
    - `我方`
    - `遠端`
  - 不強求一開始就多遠端 speaker 真正 diarization
- 擴充 [electron/types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts) 的 speaker event contract
- 在 UI 中支援 speaker label display 與 rename entry

### Exit Criteria

- 會議時間線至少可分 `我方 / 遠端`
- 未來可再演進到 `Speaker A/B`

## Milestone 5: Meeting Notes Generation

目標：

- 讓 `會議字幕` 有完整會後產出能力

### Tasks

- 在 [src/App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx) 增加 meeting notes prompt 設定入口
- 在 [python/local-llm-rewrite.py](/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/local-llm-rewrite.py) 或新 provider 中加入 notes generation path
- 新增預設 prompt template
- 支援可調選項：
  - action items
  - risks
  - decisions
  - speaker names
- 產出 markdown / structured notes

### Exit Criteria

- 會後可一鍵產生會議記錄
- 預設 prompt 可直接用
- 使用者可自行調整 prompt

## Milestone 6: Export and Reporting

目標：

- 讓 `會議字幕` 與 `雙語字幕` 都有更完整的可攜輸出

### Tasks

- 為 `會議字幕` 增加 HTML report export
- 匯出：
  - timeline transcript
  - translated text
  - meeting notes
- 規劃字幕 log 與 meeting record 的保存策略

### Exit Criteria

- 會議輸出不再只是一段文字
- 使用者可分享完整結構化記錄

## Cross-Cutting Rules

### 1. 不要把三模式重新塞進同一個 config blob

每個模式保留自己的 session config 與 state。

### 2. 即時路徑不做 LLM rewrite

`雙語字幕` 與 `會議字幕` 的即時階段只做 ASR + translation。

### 3. `speaker diarization` 先做保守版

先接受：

- `我方`
- `遠端`

而不是一開始就承諾多遠端 speaker 細分。

### 4. 先定 latency budget

建議：

- `雙語字幕`: 低於 500ms 目標
- `語音輸入`: 端到端低於 2s 目標
- `會議字幕`: 可接受略高於 `雙語字幕`，但不應明顯卡頓

## Suggested Execution Order

1. `Milestone 0`
2. `Milestone 1`
3. `Milestone 2`
4. `Milestone 3`
5. `Milestone 4`
6. `Milestone 5`
7. `Milestone 6`

## One-Sentence Summary

先做抽象層與 `雙語字幕` 的 Moonshine streaming upgrade，再補 `語音輸入` 的 MLX Whisper quality path，最後把 `會議字幕` 逐步升級成具備 speaker-aware transcript 與 notes generation 的獨立模式。
