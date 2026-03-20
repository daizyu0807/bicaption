# BiCaption

Realtime bilingual subtitles, meeting captions, and hold-to-talk dictation app for macOS.

[English](#english) | [繁體中文](#繁體中文)

---

## English

Captures system audio (via BlackHole) or microphone input, transcribes speech locally, shows bilingual subtitles in a transparent always-on-top overlay, supports meeting caption sessions with transcript/notes export, and provides hold-to-talk dictation for quick text input.

### Features

- **Three workflows in one app**
  - **Bilingual subtitles** — realtime subtitle overlay for meetings, videos, and calls
  - **Meeting captions** — meeting transcript workspace with speaker labels, notes generation, and HTML report export
  - **Dictation** — hold-to-talk speech input that copies or pastes recognized text
- **Menu Bar utility** — close the settings window and keep BiCaption running from the macOS Menu Bar
- **Multi-model STT** — choose the best model for your language:
  - **SenseVoice** — optimized for Traditional Chinese and English in the current product setup (~67ms)
  - **MLX Whisper** — currently the recommended dictation engine for best final-text quality
  - **SFSpeechRecognizer** — macOS built-in speech recognition for fast native dictation/subtitles
- Google Translate for bilingual captions (source → target)
- Bilingual subtitle toggle — enable/disable translation independently
- Transparent, draggable, resizable overlay window
- Silero VAD for natural speech segmentation (optimized for multi-speaker)
- In-app model download with progress tracking
- Independent subtitle/dictation microphone selection
- Hold-to-talk dictation hotkeys, including modifier-only modes such as `Hold Ctrl` or `Hold Fn`
- Dictation output actions: copy, paste, or copy-and-paste
- Dictation post-processing: dictionary normalization, cleanup rules, and optional local LLM polish
- Local-first dictation polish via MLX models on Apple Silicon
- Meeting transcript persistence, meeting notes generation, and HTML report export
- Custom microphone/remote speaker labels for meeting mode
- Optional subtitle log saving
- Settings UI for device selection, language pair, subtitle appearance, meeting controls, dictation output, and local polish options

### Requirements

- macOS (Apple Silicon recommended)
- Node.js 20+
- Python 3.9+ (Python 3.12+ recommended)
- [BlackHole](https://existential.audio/blackhole/) (for system audio capture, optional)
- On some systems, PortAudio may be required: `brew install portaudio`
- Accessibility permission (required for auto-paste)
- Input Monitoring permission (required for global hold-to-talk hotkeys)

> Recommended: use a Homebrew Python build such as `python@3.12` instead of the macOS system Python.
> The system Python may use LibreSSL and can produce `urllib3` SSL warnings.

### Setup

```bash
# 1. Install Node dependencies
npm install

# 2. Create Python venv and install dependencies
#    Recommended on macOS:
/opt/homebrew/bin/python3.12 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

# 3. Download STT models — REQUIRED before first run
#    You can also download models from the in-app Settings UI.
bash scripts/download-models.sh
```

### Run

```bash
npm run dev
```

This starts both the Electron app and the Python sidecar.

Typical usage:
- Use the **雙語字幕** tab to configure realtime subtitle capture and start the subtitle session
- Use the **會議字幕** tab to capture a meeting transcript, generate notes, and export a report
- Use the **語音輸入** tab to configure hold-to-talk dictation
- Close the settings window if you want the app to continue running from the macOS Menu Bar

### Meeting Captions

BiCaption also supports a dedicated meeting workflow:

- Capture meeting audio from microphone, system audio, or dual-source mode
- Show live meeting transcript and translation inside the settings workspace
- Save a meeting transcript automatically
- Generate meeting notes from the current transcript
- Export a single-file HTML report
- Customize local/remote speaker labels
- Optionally enroll a local microphone speaker sample for conservative local-speaker verification

### Dictation

BiCaption also supports hold-to-talk dictation:

- Choose a dedicated microphone and speech model for dictation
- Assign a hotkey such as `Hold Ctrl`
- Press and hold to start recording
- Release to finish recording and start post-processing
- Output the result by copying to clipboard or pasting into the current app
- Optionally polish the final text with dictionary correction, cleanup rules, and a local LLM rewrite pass

For auto-paste, BiCaption needs Accessibility permission.
For global hold-to-talk hotkeys, BiCaption needs Input Monitoring permission.

Default dictation flow:

1. Hold the hotkey to record
2. Transcribe locally with the selected STT engine
3. Apply dictionary normalization and cleanup rules
4. Optionally run a local LLM polish pass
5. Copy or paste the final text

### STT Models

| Model | Best for | Size | Latency |
|-------|----------|------|---------|
| SenseVoice | Traditional Chinese and English | ~230 MB | ~67ms |
| MLX Whisper | Highest-quality dictation on Apple Silicon | first-run model cache | batch after release |
| SFSpeechRecognizer | macOS built-in, quick native recognition | none | low |

SenseVoice is recommended for realtime subtitle and meeting streaming in the current product setup.
MLX Whisper is currently the recommended dictation engine when final text quality matters more than streaming updates.
SFSpeechRecognizer is useful when you want the built-in macOS recognition path.

### Local LLM Polish

BiCaption can optionally polish dictation output with a local MLX model.

- Local-first by default, without requiring a cloud LLM
- Current preferred model: `mlx-community/Qwen2.5-3B-Instruct-4bit`
- Rewrite behavior is intentionally conservative:
  - preserve the original meaning
  - repair obvious ASR wording when context is clear
  - remove filler words and hesitation sounds
  - improve punctuation and sentence flow
  - avoid inventing new facts

For lower-memory machines you can switch to a smaller model, but `3B` is currently the recommended quality baseline for Traditional Chinese dictation.

### Troubleshooting

- If `npm run dev` prints `[dev preflight] Node dependencies are missing`, run `npm install`.
- If it prints `[dev preflight] Python virtual environment is missing` or `Python dependencies are incomplete`, recreate `.venv` and reinstall `python/requirements.txt`.
- If it prints `[dev preflight] Speech models are missing`, run `bash scripts/download-models.sh`.

### Audio Setup (System Audio)

To capture system audio from meetings or videos:

1. Install [BlackHole](https://existential.audio/blackhole/) (2ch is enough)
2. Open **Audio MIDI Setup** (press `Cmd + Space`, search "Audio MIDI Setup")
3. Click the **+** button at the bottom left → **Create Multi-Output Device**
4. Check both your speakers/headphones and **BlackHole 2ch**
5. Go to **System Settings → Sound → Output** and select the Multi-Output Device
6. In the app, select **BlackHole 2ch** as the loopback device

> For detailed instructions, see the [BlackHole documentation](https://existential.audio/blackhole/docs/).

### Stack

- **Electron + React** — UI (settings window + overlay)
- **Python sidecar** — audio capture, VAD, STT, translation
- **sherpa-onnx** — local speech-to-text (SenseVoice, Whisper, Zipformer)
- **Silero VAD** — voice activity detection for natural segmentation
- **Google Translate** — bilingual translation (via `deep-translator`)

### Build

```bash
npm run build
npm run type-check
```

### License

MIT

---

## 繁體中文

macOS 即時雙語字幕、會議字幕與按住說話語音輸入工具。可擷取系統音訊（透過 BlackHole）或麥克風輸入，使用本地語音辨識模型進行辨識，在透明置頂視窗中顯示雙語字幕，也可進入會議記錄工作流產生逐字稿、會議記錄與報告，或透過 hold-to-talk 快速輸入文字。

### 功能特色

- **三種核心工作流**
  - **雙語字幕** — 會議、影片、通話的即時字幕疊加
  - **會議字幕** — 會議逐字稿工作區，支援 speaker label、會議記錄生成與 HTML 報告匯出
  - **語音輸入** — 按住說話、放開送出的 dictation 輸入模式
- **Menu Bar 常駐工具** — 關掉設定視窗後仍可從 macOS Menu Bar 操作
- **多模型語音辨識** — 根據語言選擇最佳模型：
  - **SenseVoice** — 目前產品設定以繁體中文與英文為主（~67ms）
  - **MLX Whisper** — 目前推薦的 dictation 引擎，最終文字效果最好
  - **SFSpeechRecognizer** — macOS 內建辨識引擎，適合快速原生輸入
- Google 翻譯即時雙語字幕（原文 → 目標語言）
- 雙語字幕開關 — 獨立控制是否顯示翻譯
- 透明、可拖曳、可調整大小的字幕疊加視窗
- Silero VAD 自然語音斷句（針對多人對話優化）
- 應用內模型下載，附下載進度顯示
- 字幕與語音輸入各自獨立的麥克風與語音模型設定
- 支援 hold-to-talk 快捷鍵，包含 `Hold Ctrl` / `Hold Fn`
- 語音輸入可選擇複製、貼上、或先複製再貼上
- 語音輸入後處理：字典正規化、規則清理、可選本地 LLM 潤稿
- 以 Apple Silicon 的 MLX 本地模型為主的 local-first 潤稿流程
- 會議逐字稿保存、會議記錄生成、HTML 報告匯出
- 會議模式支援我方/遠端 speaker label 自訂
- 可選的字幕記錄保存
- 設定介面：裝置選擇、語言對、字幕顯示、會議記錄、語音輸出與本地潤稿選項

### 系統需求

- macOS（建議 Apple Silicon）
- Node.js 20+
- Python 3.9+（建議 3.12+）
- [BlackHole](https://existential.audio/blackhole/)（擷取系統音訊用，選用）
- 部分系統可能需要安裝 PortAudio：`brew install portaudio`
- Accessibility 權限（自動貼上需要）
- Input Monitoring 權限（全域 hold-to-talk 快捷鍵需要）

> 建議使用 Homebrew 安裝的 Python，例如 `python@3.12`，不要直接使用 macOS 內建 Python。
> 內建 Python 可能會使用 LibreSSL，進而產生 `urllib3` 的 SSL 警告。

### 安裝

```bash
# 1. 安裝 Node 依賴
npm install

# 2. 建立 Python 虛擬環境並安裝依賴
#    macOS 建議：
/opt/homebrew/bin/python3.12 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

# 3. 下載語音辨識模型 — 首次執行前必須完成
#    也可以在應用程式的設定介面中下載模型。
bash scripts/download-models.sh
```

### 執行

```bash
npm run dev
```

啟動後會同時運行 Electron 應用和 Python sidecar。

一般使用方式：
- 在 **雙語字幕** 分頁設定字幕擷取並啟動字幕工作流
- 在 **會議字幕** 分頁啟動會議逐字稿、產生會議記錄並匯出報告
- 在 **語音輸入** 分頁設定 hold-to-talk 語音輸入
- 關閉設定視窗後，BiCaption 仍可從 macOS Menu Bar 常駐操作

### 會議字幕

BiCaption 也支援獨立的會議工作流：

- 可從麥克風、系統音訊或雙來源模式擷取會議音訊
- 在設定視窗內顯示即時逐字稿與翻譯
- 可自動保存 meeting transcript
- 可直接從目前 transcript 生成會議記錄
- 可匯出單檔 HTML 報告
- 可自訂我方/遠端 speaker label
- 可選擇先建立本機說話者樣本，用於保守的 microphone speaker verification

### 語音輸入

BiCaption 支援按住說話的 dictation 模式：

- 可為語音輸入單獨選擇麥克風與辨識引擎
- 可設定像 `Hold Ctrl` 這樣的快捷鍵
- 按住開始錄音
- 放開後結束錄音並進入後處理
- 將結果輸出到剪貼簿，或直接貼到目前視窗
- 可選擇在輸出前套用字典修正、規則清理與本地 LLM 潤稿

如果要自動貼上，需要 Accessibility 權限。
如果要使用全域 hold-to-talk 快捷鍵，需要 Input Monitoring 權限。

預設語音輸入流程：

1. 按住快捷鍵開始錄音
2. 使用選定的本地 STT 引擎完成辨識
3. 套用字典正規化與規則清理
4. 視設定決定是否再做本地 LLM 潤稿
5. 將最終文字複製或貼上

### 語音辨識模型

| 模型 | 適用場景 | 大小 | 延遲 |
|------|---------|------|------|
| SenseVoice | 繁體中文、英文 | ~230 MB | ~67ms |
| MLX Whisper | Apple Silicon 上最佳 dictation 品質 | 首次使用時準備模型快取 | 放開後 batch |
| SFSpeechRecognizer | macOS 內建辨識，快速原生流程 | 無需下載 | 低 |

如果你目前主要使用繁體中文與英文即時字幕或會議字幕，建議優先使用 SenseVoice。
如果你在意語音輸入最終文字品質，建議優先使用 MLX Whisper。
如果你想用 macOS 內建辨識路徑，則可改用 SFSpeechRecognizer。

### 本地 LLM 潤稿

BiCaption 可選擇使用本地 MLX 模型潤飾語音輸入結果。

- 預設走 local-first，不依賴雲端 LLM
- 目前建議模型：`mlx-community/Qwen2.5-3B-Instruct-4bit`
- 潤稿策略偏保守：
  - 保留原意
  - 在上下文明確時修正明顯 ASR 誤字
  - 移除語氣詞與猶豫音
  - 改善標點與斷句
  - 不補充原本沒說出的事實

若機器記憶體較小，可以改用較小模型；但以繁體中文 dictation 來說，`3B` 是目前較穩定的品質基準。

### 疑難排解

- 如果 `npm run dev` 顯示 `[dev preflight] Node dependencies are missing`，先執行 `npm install`。
- 如果顯示 `[dev preflight] Python virtual environment is missing` 或 `Python dependencies are incomplete`，請重建 `.venv` 並重新安裝 `python/requirements.txt`。
- 如果顯示 `[dev preflight] Speech models are missing`，請執行 `bash scripts/download-models.sh`。

### 音訊設定（擷取系統音訊）

要擷取會議或影片的系統音訊：

1. 安裝 [BlackHole](https://existential.audio/blackhole/)（2ch 即可）
2. 打開 **音訊 MIDI 設定**（按 `Cmd + Space`，搜尋「音訊 MIDI 設定」）
3. 點擊左下角 **+** 按鈕 → **建立多重輸出裝置**
4. 勾選你的揚聲器/耳機和 **BlackHole 2ch**
5. 到 **系統設定 → 聲音 → 輸出**，選擇該多重輸出裝置
6. 在應用程式中，選擇 **BlackHole 2ch** 作為 Loopback 裝置

> 詳細說明請參考 [BlackHole 官方文件](https://existential.audio/blackhole/docs/)。

### 技術架構

- **Electron + React** — 介面（設定視窗 + 字幕疊加）
- **Python sidecar** — 音訊擷取、VAD、語音辨識、翻譯
- **sherpa-onnx** — 本地語音轉文字（SenseVoice、Whisper、Zipformer）
- **Silero VAD** — 語音活動偵測，自然斷句
- **Google Translate** — 雙語翻譯（透過 `deep-translator`）

### 建置

```bash
npm run build
npm run type-check
```

### 授權

MIT
