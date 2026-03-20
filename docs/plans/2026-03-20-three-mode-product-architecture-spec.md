# BiCaption Three-Mode Product Architecture Spec

## Goal

把 BiCaption 從單一字幕工具，明確演進成三種模式共存的本地優先產品：

- `雙語字幕`
  - 用於外語影片學習
  - 單一內容來源
  - 即時字幕與翻譯對照
  - 低干擾 overlay
- `語音輸入`
  - 用於生產力輸入
  - 將口語整理成可直接貼上的文字
  - 支援字典修正與本地 LLM 潤稿
- `會議字幕`
  - 用於多語言、多使用者會議
  - 即時辨識不同發言者
  - 即時翻譯到指定語言
  - 最後生成可調 prompt 的會議記錄

這份 spec 的目的是把產品模式、pipeline、模型分工與實作優先序定死，避免後續把三種場景混成同一套配置。

## Product Boundary

### 1. `雙語字幕` 不是 `會議字幕`

`雙語字幕` 的核心場景是外語影片學習。

特徵：

- 主要輸入來源是系統音訊
- 單一主講內容
- 不需要 speaker naming
- 不需要會議記錄

### 2. `語音輸入` 不是字幕功能的子模式

`語音輸入` 的目標是輸出最終文字品質，而不是即時可讀。

特徵：

- 用戶主動按住說話
- 支援 dictionary correction
- 支援 local LLM rewrite
- 直接輸出到目前游標位置

### 3. `會議字幕` 是獨立產品模式

`會議字幕` 不是在現有雙語字幕上多加幾個 checkbox。

特徵：

- 同時處理系統音訊與麥克風
- 區分我方/他方，或多位發言者
- 即時翻譯到指定語言
- 保存時間線與 speaker-aware transcript
- 最後進入 meeting notes generation

## Core Decisions

### 1. 三種模式不共用同一條 ASR pipeline

原因：

- `雙語字幕` 要低延遲 streaming
- `語音輸入` 要 batch + rewrite
- `會議字幕` 要多來源 + speaker-aware streaming

如果共用一條 pipeline，最後會變成：

- 字幕不夠穩
- dictation 不夠準
- 會議模式狀態過於複雜

### 2. `Moonshine` 與 `MLX Whisper` 都需要導入，但分工不同

- `Moonshine`
  - 優先用在 `雙語字幕` / `會議字幕` 的 streaming ASR
  - 目的是降低對 `Apple STT` 的依賴
  - 補強即時串流穩定性
- `MLX Whisper`
  - 優先用在 `語音輸入` 與 `會議字幕收尾` 的 batch / high-quality path
  - 目的是提高 Apple Silicon 上的轉錄品質與能效

這兩者不是替代關係，而是不同 pipeline 的核心模型。

### 3. `speaker diarization` 不應該提早進一般字幕模式

speaker-related 能力只放進 `會議字幕`：

- speaker A/B 標記
- 自訂 speaker naming
- 會議記錄中的發言者標識

在 `雙語字幕` 中加入 speaker logic 只會增加複雜度。

### 4. `meeting notes prompt` 有預設值，但必須可調整

會議字幕的會後輸出不應硬寫死。

至少要允許調整：

- 摘要格式
- 語氣與詳略
- 是否列 action items
- 是否列風險與待確認事項
- 是否保留發言者名稱

## Target Pipelines

### A. 雙語字幕

```text
system audio or selected input
-> low-latency VAD
-> streaming ASR (Moonshine preferred / SenseVoice fallback / Apple STT fallback)
-> translation layer
-> subtitle overlay
-> optional subtitle log
```

核心原則：

- 優先低延遲與穩定
- 不做 LLM rewrite
- 不做 speaker naming

### B. 語音輸入

```text
microphone input
-> sentence-oriented capture
-> batch ASR (SenseVoice or MLX Whisper)
-> dictionary correction
-> optional local LLM rewrite
-> output action (copy / paste / copy-and-paste)
```

核心原則：

- 輸出品質優先
- 一定先過 `rules + dictionary`
- `local LLM` 只做保守潤稿，不改意圖

### C. 會議字幕

```text
microphone + system audio
-> per-source capture
-> streaming ASR (Moonshine preferred)
-> speaker/source attribution
-> target-language translation
-> meeting subtitle timeline
-> persistent transcript store
-> post-meeting notes generation (MLX Whisper + local LLM path)
```

核心原則：

- 即時字幕與會後整理是同一模式的兩段流程
- 即時階段不做重寫
- 會後階段才做摘要與結構化輸出

## Mode-Specific Feature Matrix

| Capability | 雙語字幕 | 語音輸入 | 會議字幕 |
| --- | --- | --- | --- |
| 即時顯示 | Yes | No | Yes |
| 本地 LLM 潤稿 | No | Yes | Notes only |
| 字典修正 | No | Yes | Optional for notes |
| 雙向音訊 | Optional | No | Yes |
| Speaker naming | No | No | Yes |
| 會議記錄生成 | No | No | Yes |

## Model Strategy

### Streaming ASR

優先順序：

1. `Moonshine`
2. `SenseVoice`
3. `Apple STT`

用途：

- `雙語字幕`
- `會議字幕`

### Batch / Quality ASR

優先順序：

1. `MLX Whisper`
2. `SenseVoice`

用途：

- `語音輸入`
- `會議字幕` 會後高品質 transcript / notes path

### Rewrite / Summarization

- `語音輸入`
  - `rules + dictionary` 必開
  - `local LLM` 可開關
- `會議字幕`
  - 即時階段不重寫
  - 會後 notes generation 使用 `local LLM`

## Settings Architecture

### Sidebar Modes

設定頁應固定至少有：

- `雙語字幕`
- `語音輸入`
- `模型`
- `會議字幕`

`模型` 為跨模式共用頁，不再把下載入口塞回各模式內。

### New Settings Groups

#### `雙語字幕`

- input source
- source language
- target language
- bilingual enabled
- overlay visibility
- streaming ASR engine
- translation latency
- log saving

#### `語音輸入`

- input source
- hotkey
- output action
- output style
- local LLM enabled
- custom dictionary enabled
- dictation ASR engine

#### `會議字幕`

- microphone input
- system audio input
- target language
- meeting mode enabled
- speaker labeling enabled
- default notes prompt
- prompt customization entry
- transcript export settings

## Data Contracts

### Meeting Subtitle Event

建議新增：

```ts
type MeetingCaptionEvent = {
  type: 'meeting_caption';
  speakerId: string;
  speakerLabel?: string;
  source: 'microphone' | 'system';
  sourceLang?: string;
  targetLang: string;
  text: string;
  translatedText?: string;
  tsStartMs: number;
  tsEndMs: number;
}
```

### Meeting Notes Request

```ts
type MeetingNotesRequest = {
  transcriptId: string;
  targetLang: string;
  promptTemplate: string;
  includeActionItems: boolean;
  includeRisks: boolean;
  includeSpeakerNames: boolean;
}
```

### Meeting Notes Result

```ts
type MeetingNotesResult = {
  summary: string;
  actionItems: string[];
  risks: string[];
  decisions: string[];
  rawPrompt: string;
}
```

## UX Rules

### 1. 模式切換要明確

三種模式在 UI 上應被視為不同工作流，不共用大量 secondary controls。

### 2. `會議字幕` 不應預設暴露過多技術名詞

避免直接顯示：

- diarization backend
- embedding model
- source separation internals

先以使用者心智呈現：

- 辨識不同發言者
- 即時翻譯成指定語言
- 產生會議記錄

### 3. `meeting notes prompt` 預設可直接用

第一次使用者不應被迫先寫 prompt。

但要有可編輯入口與預覽。

## Recommended Roadmap

### P0

- `Moonshine` 導入 `雙語字幕` / `會議字幕` streaming pipeline
- `MLX Whisper` 導入 `語音輸入` batch pipeline
- 明確建立 `會議字幕` 模式資料模型與設定頁入口

### P1

- `會議字幕` 的雙來源 capture 與 target-language live translation
- speaker/source attribution
- meeting transcript persistence

### P2

- speaker naming
- editable meeting notes prompt
- local LLM notes generation

### P3

- HTML / structured meeting report export
- 更多本地翻譯引擎

## Explicit Non-Goals For Now

- 在 `雙語字幕` 中加入 speaker diarization
- 在即時字幕路徑上加入 LLM rewrite
- 把三種模式塞回單一 session config
- 先做複雜的跨平台抽象

## One-Sentence Summary

BiCaption 應正式演進成 `學習字幕 + 生產力語音輸入 + 多語會議字幕` 三模式產品，並以 `Moonshine 做 streaming、MLX Whisper 做 quality path、會議模式承接 speaker 與 notes generation` 作為後續實作主線。
