---
status: draft
version: 0.1
created: 2026-03-14
last_updated: 2026-03-14
---

# 功能清單 Feature List

## Phase 1: 技術驗證
### 音訊裝置選擇
- 列出可用輸入裝置
- 選擇 BlackHole
- 顯示即時音量與連線狀態

### STT 管線驗證
- 讀取連續音訊 frame
- 顯示 partial / final transcript
- 估算端到端延遲

## Phase 2: MVP
### 雙字幕顯示
- 原文與譯文雙行顯示
- partial 與 final 樣式區分
- 固定視窗 / 浮動 overlay 切換

### 翻譯引擎整合
- 目標語言設定
- final transcript 翻譯
- fallback 處理

### 基本設定
- provider 選擇
- 字幕字體大小、透明度、位置
- 快捷鍵開關

## Phase 3: 穩定性與體驗
### 片段緩衝與去抖動
- 合併短句
- 避免字幕跳動
- 控制畫面更新節奏

### 診斷工具
- 顯示目前輸入裝置
- 顯示延遲與錯誤狀態
- 輸出偵錯日誌
