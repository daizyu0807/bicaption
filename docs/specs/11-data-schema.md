---
status: draft
version: 0.1
created: 2026-03-14
last_updated: 2026-03-14
---

# 資料結構 Data Schema

## caption_segment

| 欄位 | 類型 | 約束 | 預設值 | 說明 |
|---|---|---|---|---|
| id | string | primary key | none | segment 唯一識別 |
| session_id | string | index | none | 所屬音訊 session |
| source_text | text | not null | none | 原文字幕 |
| translated_text | text | nullable | null | 譯文字幕 |
| source_lang | string | not null | `en` | 原文語言 |
| target_lang | string | not null | `zh-TW` | 目標語言 |
| is_final | boolean | not null | false | 是否 final |
| confidence | float | nullable | null | STT 信心分數 |
| started_at_ms | integer | not null | none | 片段起始時間 |
| ended_at_ms | integer | nullable | null | 片段結束時間 |
| created_at | datetime | not null | now | 建立時間 |

唯一鍵：`pk_caption_segment`
索引：`idx_caption_segment_session`

## app_settings

| 欄位 | 類型 | 約束 | 預設值 | 說明 |
|---|---|---|---|---|
| key | string | primary key | none | 設定鍵 |
| value | json | not null | `{}` | 設定值 |
| updated_at | datetime | not null | now | 更新時間 |

唯一鍵：`pk_app_settings`
