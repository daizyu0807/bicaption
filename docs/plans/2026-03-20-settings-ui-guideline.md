# Settings UI Guideline

適用範圍：`BiCaption` 設定頁中的 `雙語字幕` 與 `語音輸入`。

## 目標

- 維持 `Typeless / macOS settings` 方向的低干擾密度
- 用固定 token 取代零散 magic number
- 讓後續微調遵守同一套 spacing / typography / color 規則

## Design Tokens

- `--settings-space-1` = `4px`
- `--settings-space-2` = `8px`
- `--settings-space-3` = `12px`
- `--settings-space-4` = `16px`
- `--settings-space-5` = `20px`
- `--settings-space-6` = `24px`
- `--settings-space-8` = `32px`

- `--settings-sidebar-width` = `220px`
- `--settings-control-height` = `40px`
- `--settings-radius-sm` = `10px`
- `--settings-radius-md` = `12px`

## Typography Scale

- Page title: `--settings-text-page`
- Section title: `--settings-text-section`
- Label: `--settings-text-label`
- Control/body: `--settings-text-body`
- Caption/button: `--settings-text-caption`

規則：

- 只保留少量字級層級，不新增任意字體尺寸
- `section title` 一律偏弱，不搶 page title
- `helper text` 只留必要提示，且不得形成第二層說明文牆

## Spacing Rules

- Sidebar item gap：`4px`
- Control row gap：`8px`
- Inline grid gap：`12px`
- Section gap：`20px`
- Main content padding：`20px`
- Action bar padding：`12-20px` 節奏，不可大於主內容區存在感

## Layout Rules

- 一個 section 只表達一個操作群組
- 關聯 toggle 應收成同一個 stack
- 開關之下的附屬欄位應與該開關靠近，不可被切到下一個視覺群組
- `label + control` 優先維持同一套對齊節奏

## Writing Rules

- 不使用 `Preferences`、`Settings summary` 這類重複性副標題
- 優先短標籤，不加描述性副標
- 只有權限、引擎限制、錯誤狀態可常駐顯示提示

## Current Decisions

- `雙語字幕` 的 `啟用雙語字幕` 與 `顯示字幕` 應放在同一操作群組
- `保存字幕記錄` 與其資料夾列應視為同一組
- `語音輸入` 的 `啟用本地 LLM 潤稿` 與 `啟用自訂字典` 應維持緊密 stack
