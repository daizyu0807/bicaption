---
status: draft
version: 0.1
created: 2026-03-14
last_updated: 2026-03-14
---

# 專案目標 Project Goals

## 產品願景 Product Vision
建立一個不依賴會議平台整合、可直接處理任何系統音訊來源的即時雙字幕工具。

## 商業目標 Business Goals
- 驗證個人工作流工具是否能穩定解決跨語言會議理解問題。
- 保留未來產品化成通用桌面字幕助手的可能性。

## 功能目標 Functional Goals
- 使用者可選擇 BlackHole 作為輸入來源。
- 使用者可在 overlay 中同時看到原文與譯文。
- 使用者可切換目標語言與字幕密度。

## 技術目標 Technical Goals
- 建立模組化音訊 pipeline。
- 支援至少一個本機 STT provider 與一個翻譯 provider。
- overlay 更新不阻塞音訊處理主流程。

## 非目標 Non-Goals
- 不處理錄音檔批次轉字幕。
- 不提供多人共享或協作。
- 不把 MVP 擴成通用會議知識管理系統。
