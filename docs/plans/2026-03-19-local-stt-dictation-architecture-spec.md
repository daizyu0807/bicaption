# BiCaption Local STT / Dictation Architecture Spec

## Goal

把 BiCaption 演進成真正的雙工作流架構：

- `subtitle`
  - 本地優先
  - 低延遲
  - 混語可接受
  - 翻譯可選
- `dictation`
  - 本地 base path 可用
  - 最終輸出品質優先
  - 支援 `custom dictionary`
  - 支援 `LLM rewrite`
  - 可選 `cloud enhancement`

這份文件的目的是把前面 cross-thinking 的結論落成具體規格，讓後續實作不用再重新討論系統邊界。

## Key Decision

### 1. `subtitle` 與 `dictation` 不共用同一條 pipeline

原因不是 UI，而是系統目標根本不同：

- `subtitle` 要 `streaming`
- `dictation` 要 `batch + post-processing`

如果共用同一條 pipeline，最後會變成：

- subtitle 不夠即時
- dictation 不夠準
- VAD（Voice Activity Detection）與 chunk 策略互相牽制

### 2. `dictionary` 在 `LLM rewrite` 前面

`custom dictionary` 的責任是做 deterministic correction，不應交給 LLM 猜。

順序固定為：

1. ASR transcript
2. dictionary correction
3. LLM rewrite

### 3. `dictation` 要保留兩份輸出

- `literalTranscript`
- `finalText`

這是必要的，因為：

- 便於 debug
- 便於 fallback
- 可以限制 LLM 改寫範圍

### 4. `cloud enhancement` 只在 dictation 啟用

`subtitle` 不引入 LLM rewrite 或 cloud enhancement。

原因：

- 會破壞即時性
- 會降低可預測性
- 會讓字幕內容不再可信

## Current Code Constraints

目前現有結構有三個限制需要先處理：

### 1. `CaptionConfig` 對兩種模式共用太多欄位

參考 [types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts) 與 [App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx#L304)。

目前 `buildSessionConfig()` 仍共用：

- `chunkMs`
- `partialStableMs`
- `beamSize`
- `bestOf`
- `vadFilter`
- `conditionOnPrev`

這些值對 `subtitle` 與 `dictation` 的最佳設定不一樣，不應再共用。

### 2. `DictationFinalEvent` 只有單一 `text`

參考 [types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts#L80)。

現在只有：

- `text`

未來至少要擴成：

- `literalTranscript`
- `dictionaryText`
- `finalText`
- `rewriteBackend`
- `rewriteApplied`
- `fallbackReason`

### 3. 設定模型仍偏「選 STT」而不是「選輸出策略」

參考 [App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx#L715) 和 [settings.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/settings.ts)。

目前 dictation 的設定重心是：

- `dictationSttModel`
- `dictationSourceLang`
- `dictationOutputAction`

未來 dictation 應新增：

- `dictationRewriteMode`
- `dictationDictionaryEnabled`
- `dictationCloudEnhancementEnabled`
- `dictationOutputStyle`

## Target Architecture

### Subtitle Pipeline

```text
audio input
-> subtitle VAD (aggressive, low-latency)
-> streaming local ASR
-> final/partial caption events
-> optional translation
-> overlay / save log
```

### Dictation Pipeline

```text
audio input
-> dictation VAD (conservative, sentence-oriented)
-> batch local ASR
-> custom dictionary correction
-> optional LLM rewrite
-> output decision (copy / paste / copy-and-paste)
```

## Model Strategy

### Subtitle

預設：

- `sensevoice`

fallback：

- `apple-stt`

原則：

- 選擇最低可接受延遲
- 不做語意 rewrite
- 翻譯維持獨立後處理層

### Dictation

本地 base path：

- `sensevoice` 或未來新增的本地 `whisper-mlx`

本地 rewrite path：

- `rules-only`
- 未來可加 `local-llm`

optional cloud enhancement：

- 只做 rewrite 優先
- STT 雲端化排在更後面

### Recommended Evolution

#### Phase 1

- subtitle: `sensevoice` / `apple-stt`
- dictation ASR: `sensevoice`
- dictation rewrite: `rules-only`

#### Phase 2

- subtitle: 不變
- dictation ASR: `sensevoice`
- dictation rewrite: `rules + cloud-llm`

#### Phase 3

- subtitle: 不變
- dictation ASR: `sensevoice` 或 `whisper-mlx`
- dictation rewrite: `rules + local-llm`

## Settings Spec

### New AppSettings Fields

建議在 [types.ts](/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts) 的 `AppSettings` 增加以下欄位：

```ts
subtitleChunkMs: number;
subtitlePartialStableMs: number;
subtitleVadMode: 'aggressive' | 'balanced';

dictationChunkMs: number;
dictationEndpointMs: number;
dictationVadMode: 'conservative' | 'balanced';

dictationRewriteMode: 'disabled' | 'rules' | 'rules-and-cloud' | 'rules-and-local-llm';
dictationDictionaryEnabled: boolean;
dictationCloudEnhancementEnabled: boolean;
dictationOutputStyle: 'literal' | 'polished';
dictationMaxRewriteExpansionRatio: number;
```

### Migration Rules

- 舊版 `chunkMs` -> `subtitleChunkMs`
- 舊版 `partialStableMs` -> `subtitlePartialStableMs`
- dictation 若無新欄位：
  - `dictationRewriteMode = 'rules'`
  - `dictationDictionaryEnabled = true`
  - `dictationCloudEnhancementEnabled = false`
  - `dictationOutputStyle = 'polished'`

## Event Spec

### Update `DictationFinalEvent`

目前：

```ts
type DictationFinalEvent = {
  type: 'dictation_final';
  text: string;
}
```

目標：

```ts
type DictationFinalEvent = {
  type: 'dictation_final';
  literalTranscript: string;
  dictionaryText: string;
  finalText: string;
  rewriteBackend: 'disabled' | 'rules' | 'cloud-llm' | 'local-llm';
  rewriteApplied: boolean;
  fallbackReason?: string;
  chunkCount?: number;
  startedAtMs: number;
  endedAtMs: number;
  latencyMs: number;
}
```

### New Warning Event

建議新增：

```ts
type DictationRewriteWarningEvent = {
  type: 'dictation_rewrite_warning';
  code:
    | 'dictionary_unavailable'
    | 'llm_unavailable'
    | 'rewrite_expansion_rejected'
    | 'cloud_timeout';
  detail?: string;
}
```

## Dictionary Spec

### Data Shape

建議先用 JSON 檔或 electron-store 管理：

```ts
type DictationDictionaryEntry = {
  id: string;
  spokenForms: string[];
  canonical: string;
  locale: 'zh' | 'en' | 'mixed' | 'any';
  caseSensitive: boolean;
  rewriteScope: 'stt-only' | 'rewrite';
}
```

### Apply Order

1. normalize transcript
2. match `spokenForms`
3. replace with `canonical`
4. pass corrected text to LLM

### Matching Strategy

第一版建議：

- 先做簡單 phrase matching
- 若詞條數量開始變大，再升級成 `Aho-Corasick`

## LLM Rewrite Contract

### Input

- `literalTranscript`
- `dictionaryText`
- `sourceLang`
- `outputStyle`
- matched dictionary terms

### Output Rules

LLM 只能做：

- 標點修正
- 空白修正
- 去掉無意義語氣詞
- 書面化調整

LLM 不能做：

- 新增事實
- 改變意圖
- 重新命名 dictionary canonical terms
- 把片段句擴寫成完整語意

### Safety Gates

若符合以下條件，直接捨棄 LLM 結果，改回 `dictionaryText`：

- 長度膨脹超過 `dictationMaxRewriteExpansionRatio`
- dictionary canonical term 消失
- 空輸出
- timeout / provider error

## UI Spec

### Subtitle Tab

保留聚焦在：

- input device
- subtitle STT model
- source / target lang
- translation toggle
- subtitle latency controls

不顯示：

- dictionary
- rewrite mode
- output style

### Dictation Tab

新增以下控制：

- `輸出文字風格`
  - `原文`
  - `潤飾後`
- `字典修正`
  - enable / disable
- `文字整理模式`
  - `關閉`
  - `規則整理`
  - `規則 + 雲端增強`
  - `規則 + 本地 LLM`
- `失敗時回退`
  - 固定顯示為 `回退原始辨識`

### Dictation Result UX

overlay / prompt 應能區分：

- recording
- processing ASR
- applying dictionary
- applying rewrite
- done
- fallback

## Implementation Plan

### Phase 1: Pipeline Split

- 擴充 `AppSettings`，把 subtitle / dictation 參數拆開
- 擴充 `CaptionConfig` 或改成 mode-specific config
- 更新 [App.tsx](/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx) 的 `buildSessionConfig()`
- 擴充 `DictationFinalEvent` 結構
- main process 改為以 `finalText` 輸出，但保留原文狀態

驗收：

- subtitle 與 dictation 可獨立調整 VAD / chunk 參數
- UI 能顯示 dictation 的多階段狀態
- 既有 subtitle 行為不回歸

### Phase 2: Dictionary Layer

- 實作 dictionary store
- 實作 deterministic correction layer
- 將 correction 結果寫入 `dictionaryText`
- 補單元測試：
  - mixed language phrases
  - proper nouns
  - case-sensitive terms

驗收：

- 專有名詞修正不依賴 LLM
- dictionary 關閉時流程仍可運作

### Phase 3: Rewrite Layer

- 實作 `rules-only` rewrite
- 定義 LLM provider interface
- 接入 `cloud rewrite` 作為第一個 enhancement backend
- 補 safety gate 與 fallback reason

驗收：

- rewrite 失敗不阻斷輸出
- 可切換 `literal` / `polished`
- 可觀察 fallback 原因

### Phase 4: Local LLM

- 評估 `mlx-lm` 或等價本地 provider
- 新增 lazy loading / unload 策略
- 量測 cold / warm latency

驗收：

- 本地 LLM 啟用時不拖垮 subtitle
- 低記憶體裝置可自動降級

## Test Plan

### Unit

- settings migration
- dictionary replacement
- rewrite fallback rules
- expansion ratio guard

### Integration

- subtitle session regression
- dictation happy path
- dictation with dictionary
- dictation with rewrite fallback
- focus changed before paste

### Manual

- 中英混講
- 專有名詞密集輸入
- 短句 / 半句 / 語氣詞
- 8GB / 16GB Apple Silicon 設備行為

## Open Questions

- dictation 本地高準確率 STT 是否直接導入 `whisper-mlx`
- dictionary 資料檔放在 electron-store 還是獨立 JSON
- 本地 LLM provider 要走 `mlx-lm`、`ollama` 還是 sidecar 內嵌
- `dictationOutputStyle = literal` 時是否完全跳過 rewrite 還是只跳過 LLM

## Recommended Next Step

先做 `Phase 1 + Phase 2`，不要先碰本地 LLM。

原因：

- 最快能解多語準確率痛點
- 風險最低
- 不會被 Apple Silicon 記憶體管理拖慢整體進度
