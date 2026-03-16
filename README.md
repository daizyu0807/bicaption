# BiCaption

Realtime bilingual caption overlay for macOS.

[English](#english) | [繁體中文](#繁體中文)

---

## English

Captures system audio (via BlackHole) or microphone input, transcribes speech locally, and shows bilingual captions in a transparent always-on-top overlay.

### Features

- **Multi-model STT** — choose the best model for your language:
  - **SenseVoice** — Chinese/Cantonese best, supports zh/en/ja/ko/yue (~67ms)
  - **Whisper tiny.en** — English-only, fastest (~50ms)
  - **Whisper small** — Japanese/multilingual, slower (~200ms)
  - **Zipformer Korean** — Korean-dedicated, most accurate for Korean
- Auto model switching when source language changes (manually overridable)
- Google Translate for bilingual captions (source → target)
- Bilingual subtitle toggle — enable/disable translation independently
- Transparent, draggable, resizable overlay window
- Silero VAD for natural speech segmentation (optimized for multi-speaker)
- In-app model download with progress tracking
- Optional subtitle log saving
- Settings UI for device selection, model, language pair, opacity, and font scale

### Requirements

- macOS (Apple Silicon recommended)
- Node.js 20+
- Python 3.9+ (Python 3.12+ recommended)
- [BlackHole](https://existential.audio/blackhole/) (for system audio capture, optional)
- On some systems, PortAudio may be required: `brew install portaudio`

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

This starts both the Electron app and the Python sidecar. Select your input device in the settings window and click "Start".

### STT Models

| Model | Best for | Size | Latency |
|-------|----------|------|---------|
| SenseVoice | Chinese, Cantonese, mixed zh/en | ~230 MB | ~67ms |
| Whisper tiny.en | English only | ~39 MB | ~50ms |
| Whisper small | Japanese, multilingual | ~244 MB | ~200ms |
| Zipformer Korean | Korean | ~330 MB | ~40ms |

When you change the source language, the app auto-selects the recommended model:
- Auto / 中文 → SenseVoice
- English → Whisper tiny.en
- 日本語 → Whisper small
- 한국어 → Zipformer Korean

You can always manually override the model selection.

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

macOS 即時雙語字幕疊加工具。擷取系統音訊（透過 BlackHole）或麥克風輸入，使用本地語音辨識模型進行辨識，並在透明的置頂視窗中顯示雙語字幕。

### 功能特色

- **多模型語音辨識** — 根據語言選擇最佳模型：
  - **SenseVoice** — 中文/粵語最佳，支援中英日韓粵（~67ms）
  - **Whisper tiny.en** — 純英文，最快（~50ms）
  - **Whisper small** — 日文/多語言，較慢（~200ms）
  - **Zipformer Korean** — 韓文專用，韓文辨識最準確
- 切換語言時自動推薦模型（可手動覆蓋）
- Google 翻譯即時雙語字幕（原文 → 目標語言）
- 雙語字幕開關 — 獨立控制是否顯示翻譯
- 透明、可拖曳、可調整大小的字幕疊加視窗
- Silero VAD 自然語音斷句（針對多人對話優化）
- 應用內模型下載，附下載進度顯示
- 可選的字幕記錄保存
- 設定介面：裝置選擇、模型選擇、語言對、透明度、字體大小

### 系統需求

- macOS（建議 Apple Silicon）
- Node.js 20+
- Python 3.9+（建議 3.12+）
- [BlackHole](https://existential.audio/blackhole/)（擷取系統音訊用，選用）
- 部分系統可能需要安裝 PortAudio：`brew install portaudio`

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

啟動後會同時運行 Electron 應用和 Python sidecar。在設定視窗選擇輸入裝置後按「開始」。

### 語音辨識模型

| 模型 | 適用場景 | 大小 | 延遲 |
|------|---------|------|------|
| SenseVoice | 中文、粵語、中英混合 | ~230 MB | ~67ms |
| Whisper tiny.en | 純英文 | ~39 MB | ~50ms |
| Whisper small | 日文、多語言 | ~244 MB | ~200ms |
| Zipformer Korean | 韓文 | ~330 MB | ~40ms |

切換來源語言時，應用會自動推薦模型：
- 自動偵測 / 中文 → SenseVoice
- English → Whisper tiny.en
- 日本語 → Whisper small
- 한국어 → Zipformer Korean

你可以隨時手動切換模型。

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
