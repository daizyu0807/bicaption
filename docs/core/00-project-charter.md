---
status: draft
version: 0.1
created: 2026-03-14
last_updated: 2026-03-14
---

# 專案章程 Project Charter

## 1. 專案概覽 Project Overview
- 專案名稱: Realtime Bilingual Subtitles
- 專案代號: `SubFlow` [NEEDS_CONFIRMATION]
- 產品類型: 桌面工具
- 一句話描述: 在 macOS 上擷取系統或會議音訊，實時顯示原文與中文字幕。

## 2. 商業理由 Business Justification
- 痛點:
  - 既有會議工具對雙字幕支援不足或受限於方案與平台。
  - 使用者需要在不改變原工作流程下，直接看到英文原文與中文譯文。
- 價值主張:
  - 不綁定單一會議平台
  - 透過 BlackHole 兼容任何可輸出系統音訊的應用
  - 可逐步從個人工具擴展成更完整的語音輔助產品

## 3. 專案目標與成功標準 Goals & Success Criteria
- 商業目標:
  - 驗證「跨平台會議音訊雙字幕」是否值得持續產品化
- 功能目標:
  - 接收 BlackHole 音訊輸入
  - 在 3 秒內顯示原文字幕
  - 在 5 秒內顯示對應中文譯文
- 技術目標:
  - 核心 pipeline 與 UI 分離
  - STT 與翻譯 provider 可替換

## 4. 高層次範圍 High-Level Scope
- In Scope:
  - 音訊輸入選擇
  - 即時 STT
  - 即時翻譯
  - 雙字幕 overlay
  - 基本設定頁
- Out of Scope:
  - 會議紀錄自動摘要
  - 使用者帳號系統
  - 雲端同步
- Assumptions:
  - 使用者已安裝 BlackHole
  - 初期使用環境為 macOS
  - 輸入語言以英文為主 [NEEDS_CONFIRMATION]
- Constraints:
  - 需避免高延遲與高資源耗用
  - 不依賴特定會議平台 API

## 5. 主要利害關係人 Stakeholders
| 角色 | 關注點 | 影響力 |
|---|---|---|
| 使用者 / 開發者 | 可用性、延遲、字幕品質 | 高 |
| [PM] [NEEDS_CONFIRMATION] | 範圍與優先級 | 中 |

## 6. 專案組織 Project Organization
- 核心團隊: [單人開發] [NEEDS_CONFIRMATION]
- 外部依賴:
  - BlackHole
  - STT 模型或 API
  - 翻譯模型或 API

## 7. 高層次風險 High-Level Risks
| Risk | Impact | Mitigation |
|---|---|---|
| 音訊路由失敗 | 高 | 先鎖定 BlackHole 單一路徑並建立診斷頁 |
| STT 延遲過高 | 高 | 先做 provider 抽象，允許切換本機/雲端 |
| 翻譯不穩定 | 中 | 加入 fallback 與原文保留策略 |
| UI 雙字幕資訊過載 | 中 | 設計大字版與精簡版模式 |

## 8. 里程碑摘要 Milestone Summary
| Phase | Milestone | Target |
|---|---|---|
| 1 | 規劃與技術驗證 | 2026-03 |
| 2 | MVP 核心 pipeline 完成 | [NEEDS_CONFIRMATION] |
| 3 | 可用性優化與封裝 | [NEEDS_CONFIRMATION] |

## 9. 預算摘要 Budget Summary
- 本機方案預算以時間成本為主。
- 若採雲端 STT/翻譯，需另行估算 API 成本。 [NEEDS_CONFIRMATION]

## 10. 授權與簽核 Authorization & Change Control
- 簽核角色: [專案負責人] [NEEDS_CONFIRMATION]
- 變更管理流程:
  - 需求變更先更新 `06-feature-list.md`
  - 技術變更同步更新 `02-blueprint.md` 與 specs 文件
