# Findings

## Research Pack
- User context:
  - 已安裝 BlackHole
  - 需求從「Google Meet 整合」收斂為「可直接擷取會議音訊並輸出即時雙字幕」
- Build direction:
  - 以系統音訊擷取而非平台 API 為核心
  - 雙字幕需同時顯示原文與譯文
  - 優先考慮可離線或可切換本機/雲端引擎

## Existing Solutions
| Option | Relevance | Notes |
|---|---|---|
| Voice2Sub | High | 有即時 bilingual overlay 概念，但需確認 macOS 音訊輸入路徑 |
| Whispering Tiger | High | 適合作為可擴充 STT/translation 核心，但產品化仍需 UI 整合 |
| BlackHole | High | 解決 macOS 系統音訊路由，是本專案既有前提 |

## Core Product Insight
- 真正的產品價值不是「字幕」本身，而是「在不改變既有會議工具的前提下，穩定得到可讀雙字幕」。
- 因此 MVP 成敗主要取決於三點：
  - 音訊輸入是否穩定
  - 端到端延遲是否可接受
  - 字幕分段與排版是否好讀

## Architecture Constraints
- 需要支援 BlackHole 作為 input device。
- 建議設計成可替換的 STT/Translation provider interface。
- overlay 應與核心 pipeline 解耦，避免 UI 卡住拖累處理延遲。
