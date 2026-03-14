# Task Plan

## Goal
建立「即時雙字幕」專案的可執行規劃，聚焦於 macOS 上透過 BlackHole 擷取會議音訊，產出原文 + 中文即時雙字幕。

## Task Classification
- Type: strict
- Scope: new project planning
- Project Root: `/Users/davedai/Project/tools/realtime-bilingual-subtitles`

## Plan Pack
- Product type: 內部工具 / 桌面應用
- Primary user: 需要在會議或影音播放時看到雙字幕的單一使用者
- Core constraint: 已安裝 BlackHole，優先利用本機音訊路由，不依賴會議平台整合
- MVP boundary:
  - In: 音訊擷取、即時轉寫、即時翻譯、雙字幕 overlay、基本設定
  - Out: 雲端多人協作、字幕編輯器、會議記錄知識庫、自動摘要

## Phases
| Phase | Description | Status |
|---|---|---|
| 1 | 建立 planning 檔與專案文件骨架 | complete |
| 2 | 產出 core 規劃文件 | complete |
| 3 | 產出 specs 與 milestone tracking | complete |
| 4 | 自我檢查並交付 | complete |

## Decisions
- 假設平台為 macOS，音訊來源透過 BlackHole 提供。
- MVP 以桌面 overlay 為主，而非瀏覽器 extension。
- 技術方向以「本機 STT + 翻譯服務抽象層 + 輕量 UI」為核心。

## Risks
- 系統音訊路由在不同 app 下可能不一致。
- 本機 STT 延遲與準確率需在效能和成本間取捨。
- 雙字幕排版若處理不好，易影響可讀性。

## Errors Encountered
| Error | Attempt | Resolution |
|---|---|---|
| None | 0 | N/A |
