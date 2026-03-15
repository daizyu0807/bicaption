# Realtime Bilingual Subtitles

[English](#english) | [繁體中文](#繁體中文)

---

## English

Realtime bilingual subtitle overlay for macOS. Captures system audio (via BlackHole) or microphone input, transcribes with [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) (sherpa-onnx), and shows bilingual captions in a transparent always-on-top overlay.

### Features

- Local STT using SenseVoice — fast, no cloud dependency, auto language detection (zh/en/ja/ko/yue)
- Google Translate for bilingual captions (source → target)
- Transparent, resizable overlay window
- Silero VAD for natural speech segmentation
- In-app model download with progress tracking
- Optional subtitle log saving
- Settings UI for device selection, language pair, opacity, and font scale

### Requirements

- macOS (Apple Silicon recommended)
- Node.js 20+
- Python 3.9+
- [BlackHole](https://existential.audio/blackhole/) (for system audio capture, optional)
- On some systems, PortAudio may be required: `brew install portaudio`

### Setup

```bash
# 1. Install Node dependencies
npm install

# 2. Create Python venv and install dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

# 3. Download STT models (~230 MB) — REQUIRED before first run
#    You can also download models from the in-app Settings UI.
bash scripts/download-models.sh
```

### Run

```bash
npm run dev
```

This starts both the Electron app and the Python sidecar. Select your input device in the settings window and click "Start".

### Audio Setup (System Audio)

To capture system audio from meetings or videos:

1. Install [BlackHole](https://existential.audio/blackhole/) (2ch is enough)
2. Open **Audio MIDI Setup** (press `Cmd + Space`, search "Audio MIDI Setup")
3. Click the **+** button at the bottom left → **Create Multi-Output Device**
4. Check both your speakers/headphones and **BlackHole 2ch**
5. Go to **System Settings → Sound → Output** and select the Multi-Output Device
6. In the app, select **BlackHole 2ch** as the input device

> For detailed instructions, see the [BlackHole documentation](https://existential.audio/blackhole/docs/).

### Stack

- **Electron + React** — UI (settings window + overlay)
- **Python sidecar** — audio capture, VAD, STT, translation
- **sherpa-onnx + SenseVoice** — local speech-to-text (non-autoregressive, ~67ms for 3s audio)
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

macOS 即時雙語字幕疊加工具。擷取系統音訊（透過 BlackHole）或麥克風輸入，使用 [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)（sherpa-onnx）進行語音辨識，並在透明的置頂視窗中顯示雙語字幕。

### 功能特色

- 本地語音辨識（SenseVoice）— 快速、不需網路、自動偵測語言（中/英/日/韓/粵）
- Google 翻譯即時雙語字幕（原文 → 目標語言）
- 透明、可調整大小的字幕疊加視窗
- Silero VAD 自然語音斷句
- 應用內模型下載，附下載進度顯示
- 可選的字幕記錄保存
- 設定介面：裝置選擇、語言對、透明度、字體大小

### 系統需求

- macOS（建議 Apple Silicon）
- Node.js 20+
- Python 3.9+
- [BlackHole](https://existential.audio/blackhole/)（擷取系統音訊用，選用）
- 部分系統可能需要安裝 PortAudio：`brew install portaudio`

### 安裝

```bash
# 1. 安裝 Node 依賴
npm install

# 2. 建立 Python 虛擬環境並安裝依賴
python3 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

# 3. 下載語音辨識模型（約 230 MB）— 首次執行前必須完成
#    也可以在應用程式的設定介面中下載模型。
bash scripts/download-models.sh
```

### 執行

```bash
npm run dev
```

啟動後會同時運行 Electron 應用和 Python sidecar。在設定視窗選擇輸入裝置後按「開始」。

### 音訊設定（擷取系統音訊）

要擷取會議或影片的系統音訊：

1. 安裝 [BlackHole](https://existential.audio/blackhole/)（2ch 即可）
2. 打開 **音訊 MIDI 設定**（按 `Cmd + Space`，搜尋「音訊 MIDI 設定」）
3. 點擊左下角 **+** 按鈕 → **建立多重輸出裝置**
4. 勾選你的揚聲器/耳機和 **BlackHole 2ch**
5. 到 **系統設定 → 聲音 → 輸出**，選擇該多重輸出裝置
6. 在應用程式中，選擇 **BlackHole 2ch** 作為輸入裝置

> 詳細說明請參考 [BlackHole 官方文件](https://existential.audio/blackhole/docs/)。

### 技術架構

- **Electron + React** — 介面（設定視窗 + 字幕疊加）
- **Python sidecar** — 音訊擷取、VAD、語音辨識、翻譯
- **sherpa-onnx + SenseVoice** — 本地語音轉文字（非自迴歸，3 秒音訊約 67ms 推論）
- **Silero VAD** — 語音活動偵測，自然斷句
- **Google Translate** — 雙語翻譯（透過 `deep-translator`）

### 建置

```bash
npm run build
npm run type-check
```

### 授權

MIT
