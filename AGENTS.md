<!-- HANK_REMOVE_REQUIRED_SIMPLIFY_20261017_BEGIN -->
## 所有現有與未來專案取消強制 simplify 審查（Hank，2026-10-17）

Hank 直接要求：「所有現有跟未來的新專案都要取消這條強制 simplify 審查規則，並通知其他 session，不要再因此卡住提交或發布。」

- 所有現有專案、新專案、工作副本及各 session 均取消「必須執行 simplify skill」或「必須由 Claude Code 執行專案指定 simplify 審查」的強制步驟；舊文件中的同項要求以本節為準。
- simplify 僅為可選工具。不得因未執行、未安裝、不可用或未為 simplify 登入 Claude Code，而阻擋提交、PR、審查或發布；也不得把未執行的 simplify 冒稱已通過。
- 其他既有程式碼審查、代碼品質、i18n、功能／權限／UI／回歸測試、CI、安全、H 浮水印自檢及發布批准要求仍須完成，不因取消 simplify 而略過。
- 建立新專案或新工作副本時，將本節帶入根目錄 AGENTS.md，以及存在的 CLAUDE.md／覆寫指示；開始既有專案時移除同項舊強制條款。不可讀來源記錄待同步，不建立替代工程。
- 本次只更新規則，不自行恢復暫停目標、提交／推送、發布、搬移或清理資料。
<!-- HANK_REMOVE_REQUIRED_SIMPLIFY_20261017_END -->

<!-- HANK_ICON_WATERMARK_POLICY_20261010_BEGIN -->
## 全專案 H 浮水印與每次更新發布前自檢（Hank，2026-10-12 更新）

Hank 直接規定：「把浮水印Ｈ不能自成一排的限制規定放到每一個專案甚至是未來的專案內」及「任何專案發更新版之前都要自檢過icon 浮水印位置」。本節適用所有現有、未來專案及其工作副本，覆蓋舊的圖示底欄／縮圖留白方案核准；不得沿用那些核准放行。

Hank 2026-10-12 最新更正：「只要Ｈ在畫面中 不需要特別清楚 因為只是浮水印」，並指出不得使用錯誤的 H 樣式。本次更正覆蓋下方舊版的小尺寸清楚辨字要求：H 是浮水印，不是必須在 32／48／64px 清楚辨讀的標誌；不得因它在縮圖中不夠清楚而阻擋發布，也不得為此換成金色、單色、其他字型或 AI 重畫的 H。

- H 必須像浮水印自然融入原圖，**不能自成一排**、獨立底欄、色帶、頁腳或圖外徽章。禁止為容納 H 縮小、搬移、裁切原畫，增加畫布／padding／邊框，或把原圖推到上方。保持真正無 H 原圖的畫布、比例、位置及構圖；只合成已選定的 H 圖層，不重畫原圖，不擅改 H 色彩／alpha。
- 必須使用使用者實際選定的 H 原始圖層；保留其樣式、筆畫、色彩與 alpha，不得自行替換、重新設計或重畫。H 只需在圖示畫面中存在、可見，不要求小尺寸特別清楚或能辨讀字母；縮圖細節消失或僅呈小型彩色浮水印不構成 HOLD。H 仍不得遮住標題、主要文字、人物、武器或主要圖形，也不得完全落在畫面／平台遮罩之外。逐語言、逐平台檢查實際輸出與遮罩，包含 32／48／64px 及適用平台尺寸；這些尺寸用於確認 H 仍在畫面中，不是清晰度門檻。
- **每次更新版發布前都必須重新自檢 icon 的 H 位置，即使本次沒有修改 icon。** 在內測分發、商店提交／發布或網站／CLI 更新前，核對本次實際包內／發布產物圖示、各語言變體、商店圖示及可取得的安裝／執行後顯示；來源預覽或其他版本的通過紀錄不能代替本版自檢。
- 留存本版自檢紀錄：版本／build、真正原圖與 H 來源、使用圖示及包內資源路徑、實際小尺寸／遮罩對照、目視結論與未完成項。像素核對須以真正無 H 原圖為基準；不得把先縮圖／加底欄的圖當基準，以「H 外差異為 0」掩蓋整體構圖變動。自動檢查通過不能代替目視驗收。
- H 缺失或完全被裁掉、使用錯誤／擅改的 H 樣式、自成一排、遮圖／遮字，或本版自檢未完成，均為 **HOLD／不得發布**。小尺寸 H 不夠清楚不再列為阻擋條件。本次由 Hank 明確更新驗收標準，須如實記錄為「浮水印存在／樣式正確」，不得冒稱小尺寸清楚辨字檢查已通過。其他未變更的發布檢查仍須完成。沒有適用圖示的專案須如實記錄不適用及原因，不能靠移除應有圖示／H 規避。
- 建立新專案或新工作副本時，將本節帶入其根目錄 `AGENTS.md`；開始既有專案工作時核對本節已同步，遇到不可讀路徑記錄待同步，不建立替代目錄或假稱完成。此規定不自行恢復暫停目標，也不額外授權搬移、刪除、發布或變更 rollout。
<!-- HANK_ICON_WATERMARK_POLICY_20261010_END -->

<!-- HANK_EXTERNAL_TARGET_CODEX_2T_20261011_BEGIN -->
## 最新外接儲存目標：codex_2T（Hank，2026-10-11）

Hank 直接指示：「因為那顆硬碟壞了現在目前都要改到 `/Volumes/codex_2T/`」。本節更新所有專案的外接儲存目標，覆蓋下方仍把 `/Volumes/codex`、`/Volumes/CodexData` 或舊 Hank-2TB 當成目前目標的說明；搬移／復原的資料保護與各專案最新授權仍須遵守。

- 新實體碟是 `/Volumes/codex_2T`，Volume UUID `4E209AF2-AF33-3CF7-8F47-54D26FE14F19`，目前 ExFAT。長期專案與資料的目標以此碟為準；Git、symlink、POSIX 權限與活躍 SQLite 使用此碟上經確認的 APFS 資料區。APFS 資料區的掛載名稱可能不同，須核對映像檔實際位於新碟，不能只看路徑名稱。測試執行、必要測試快取／暫存與模擬器留在本機 SSD，仍保留 20 GiB 系統空間。
- 舊 `/Volumes/CodexData` 是 `/Volumes/codex/CodexData.sparsebundle` 的 APFS 掛載點；它不是新碟。目前舊資料區未掛載，指向它的連結不能視為可用工程。不得把舊碟 UUID 當成新碟身分。
- 各專案須先找到可讀且完整的來源，保留未提交／未追蹤資料、Git/worktree 引用及檔案語意，確認新位置與來源一致並協調停止寫入後，才切換原入口。已有專案完成新碟切換時沿用其已驗證路徑；不要重複搬移。來源不可讀則記錄「待復原／未切換」，不能把連結改到空目錄、建立假的掛載點或用遠端 Git 宣稱原工程已恢復。
- 作品網站的編寫工程 `/Users/hank/Desktop/Project/app-showcase-site` 仍待復原；它與已搬移的部署工程不同。部署工程實際在 `/Volumes/AiHankAppsData/EClaw-ai-hank-apps-route`，網站檔案在其 `backend/public/AiHankApps/`；原 `/Users/hank/Desktop/Project/EClaw-ai-hank-apps-route` 已轉接新位置。此工作副本的 Git 共用資料仍在 `/Users/hank/Desktop/Project/EClaw/.git`，保留其他 EClaw 工作副本的關聯。啟動前執行 `python3 /Volumes/AiHankAppsData/check_storage.py`；測試留 SSD，現有未提交／未追蹤修改不得重置。最新位置及驗證紀錄查 `/Users/hank/.local/share/project-storage/storage-policy-20261014.json` 與新碟 `AiHankApps/workspace-location.json`。
- 全域 `project-storage` CLI 目前仍為 `internal`；本節只更新目標與已查明狀態，不宣稱整體切換完成，不重啟舊搬移程序、不搬動正在寫入的資料庫，也不恢復暫停目標。新專案／工作副本沿用本節與 H 浮水印發布前自檢規定，發布與清理仍按各自授權及檢查辦理。
<!-- HANK_EXTERNAL_TARGET_CODEX_2T_20261011_END -->

<!-- HANK_AIHANKAPPS_MOUNT_REPAIR_20261014_BEGIN -->
## AiHankApps 掛載入口修復（Hank，2026-10-14）

- 原映像仍在 `/Volumes/codex_2T/codex_project/AiHankAppsData.sparsebundle`，目前真正掛載點為 `/Volumes/AiHankAppsData`；實體／APFS UUID 不變，資料沒有搬回 SSD。
- 部署工程 `/Volumes/AiHankAppsData/EClaw-ai-hank-apps-route`；原 Desktop 入口已轉接這裡。共用 Git 仍在 `/Users/hank/Desktop/Project/EClaw/.git`，工作副本反向登記已修正。
- 啟動前執行 `python3 /Volumes/AiHankAppsData/check_storage.py`。檢查實體／APFS UUID、實際映像、ownership、可寫性、原入口及兩個工作副本的 Git 雙向關聯，不得弱化 guard。Timehut 另執行其 `tools/check_storage.py`。
- 舊 `/Volumes/codex_2T/codex_project/AiHankApps` 不是目前資料區；不能往空目錄建立替代工程。編寫來源 `app-showcase-site` 仍待復原，本次不代表它已恢復。
- 最新位置：`/Users/hank/.local/share/project-storage/storage-policy-20261014.json`、`/Volumes/AiHankAppsData/workspace-location.json`；修復與保留證據：`/Volumes/AiHankAppsData/entry-repair-20261014/`。測試及必要快取留本機 SSD，至少保留 20 GiB。
- H 沿用 Hank 最新規則：小而低調，只需在 icon 畫面中可見且樣式正確，不為縮圖辨字放大；不得遮主體、自成一排或改動原圖構圖，每版仍查實際發布產物。
<!-- HANK_AIHANKAPPS_MOUNT_REPAIR_20261014_END -->


## Codex channel inbound work (2026-10-21)

- Use feature branches and PRs. Do not merge or deploy the EClaw production backend without Hank's explicit authorization in this thread.
- Keep each original sender's reply route. A supplementary message from the same sender may use `turn/steer`; other senders and rejected/racing steering requests wait in FIFO order.
- Approval cards and bridge control commands must remain responsive while a turn runs. Do not auto-approve pending operations as part of inbound delivery.
- Do not log or expose queued text, credentials, attachment URLs, or tool arguments.
- The local runtime has unrelated uncommitted attachment, health, and polling work. Apply only this PR's incremental changes; never replace the live checkout with a clean checkout.
- Regression registry: `test/session-manager.test.ts` and `test/inbound-steering.test.ts` cover admission/start races, steering, queued fallback, interruption, failures, and per-sender reply routing. Run `npm test -- test/session-manager.test.ts test/inbound-steering.test.ts test/server.test.ts test/inbound-debug.test.ts` (no live credentials).
- Active debug endpoint: `GET /api/debug/codex-inbound` (created 2026-10-21); owner deviceId/deviceSecret verified against EClaw, returns redacted admission/steering/queue status. Retain until Hank confirms the fix or authorizes removal.
- This bridge is a headless Node service with no shipped app/store/website icon. H watermark release review is not applicable to this bridge-only change.
