---
status: draft
version: 0.1
created: 2026-03-14
last_updated: 2026-03-14
---

# 商業規則 Business Rules

## BR-1: 無翻譯時不得阻塞原文字幕
- **If**: 翻譯 provider 超時或失敗
- **Then**: 仍顯示原文字幕
- **Else**: 無
- **來源**: MVP 可用性原則

## BR-2: 只對穩定片段執行正式翻譯
- **If**: 字幕片段為 final transcript
- **Then**: 送入 Translation Engine
- **Else**: partial 僅顯示原文或低優先翻譯
- **來源**: 延遲與可讀性平衡

## BR-3: 字幕畫面需限制最大同屏片段數
- **If**: 畫面上的字幕片段超過上限
- **Then**: 依時間順序移除最舊片段
- **Else**: 保留現況
- **來源**: overlay 可讀性要求

## BR-4: 啟動前必須選定可用音訊輸入
- **If**: 使用者尚未選擇或裝置不可用
- **Then**: 禁止進入串流狀態並提示修復
- **Else**: 允許啟動
- **來源**: 音訊擷取穩定性要求
