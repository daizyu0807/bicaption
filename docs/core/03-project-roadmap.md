---
status: draft
version: 0.1
created: 2026-03-14
last_updated: 2026-03-14
---

# 專案路線圖 Project Roadmap

## Now
- 完成架構選型
- 建立音訊擷取 PoC
- 定義字幕資料模型與 overlay 行為

## Next
- 完成 MVP pipeline
- 加入設定頁與 provider 切換
- 驗證 30 分鐘連續使用穩定性

## Later
- 支援更多語言組合
- 加入錄音儲存與字幕匯出
- 優化視覺樣式與快捷鍵

## 風險矩陣 Risk Matrix
| Risk | Probability | Severity | Response |
|---|---|---|---|
| 音訊延遲累積 | Medium | High | 先做壓測與 latency budget |
| 字幕閃爍 | High | Medium | partial/final 分層渲染 |
| CPU 使用率過高 | Medium | High | 限制 model size 與刷新頻率 |
