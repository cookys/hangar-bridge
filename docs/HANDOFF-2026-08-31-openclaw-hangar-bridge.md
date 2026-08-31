# Handoff — openclaw / hangar-bridge session（2026-08-31）

> 這條 session 的 handoff。**不要寫進 `docs/HANDOFF.md`** —— 那是 2026-07-21 封存的
> 「closeout → llm-playground Plan 029 P10」跨 repo 交接，屬於另一條工作線。

## 目標

把 fleet identity plan（`docs/plans/2026-08-23-fleet-identity-and-deaf-session-detection.md`）
的 P0–P4' 實作到可用狀態，並修掉 fleet 實地回報的缺口。**已完成；目前無進行中的工作。**

## 現況

- 分支 `develop` @ `e90a51a`，**與 `origin/develop` 同步**，working tree 乾淨、無 stash
- 測試：shared 91 / relay 212 / peer-agent 384，三包 build + typecheck 乾淨
- 本 session 的 peer-agent 已重開並驗證：`delivery_state: verified`、attribution 正常、
  caps `disposition,attribution-v1,poll_inbox`

**DONE**：P0 失聰免疫（`/proc` 祖先鏈旗標自檢 + capability 內省 + DEAF health state）、
P1–P3（三條註冊路徑文件化、安全憲章 4→6 點、presence per-instance 唯一化、`poll_inbox`、
cursor 持久化）、P4'（relay 權威歸屬 stamp、per-instance 自我排除、`attribution-v1` caps、
DEAF outbound meta）、presence 移出 durable buffer、ephemeral 生成 `correlation_id`、
relay DB 清理（462 MB → 1.6 MB，由 hangar session 執行）。

**IN-FLIGHT**：無。

**BLOCKED（等 operator）**：repo-scope 那包（見「下一步」）。

## 已決事項（不重議）

- **P4（per-project handle）已否決** — 不根治（同專案多 session 仍互收）、只解兩種撞車的一種、
  成本外部性（靜態 roster ⇒ 開專案就斷全 fleet SSE）。四席 hetero + 三台 fleet peer 一致。
- **歸屬走 relay stamp，不用 peer 自宣告** — 修「偽造否認」事故的機制本身不能可偽造；
  偽造他人 instance 會造成選擇性致盲。
- **DEAF 標記走 meta key（`sender_health` / `deaf_since`），不改 `<channel>` tag 形狀** —
  subject-routing spec 本來就把 meta 算繪進 envelope，紅線不必讓。
- **標記而非硬拒** — 聾掉的 session 的 send path 是它唯一的信標。
- **presence 不進 durable buffer** — 心跳不在「離線不漏訊息」的契約內；曾佔全表 99.3%。
- **ephemeral 用 `meta.correlation_id` 回覆，不用 `in_reply_to`**（其他訊息照常用）。
- **分工：code 歸本 session，部署歸 openclaw/hangar session（`01M1B6H8`）** — 已與對方談定。
- **不動別人的 repo**（`~/projects/agent-call`、`llm-playground`、`hangar`、`dotfiles`）。

## 下一步

**沒有自動要接的工作。** 唯一待決是 operator 尚未裁示的一包（已問四次無回覆）：

repo-scoped addressing，設計分析在 `/home/cookys/tmp/fable-repo-scope-analysis-20260831.md`
（104 行，每個斷言帶 `file:line`）。由 openclaw `01M1B6H8` 轉述 operator 決定「整包交給
hangar-bridge code owner」，但**那是 peer 轉述，不是授權** —— 動手前需 operator 本人確認。

1. **步驟 0（建議只做這個）**：修 `packages/peer-agent/src/roots.ts:29-30` 的 repo 推導。
   現在取 remote URL 最後一段，所以本地 bare 佈局（`~/projects/fighter/origin.git`）會回報
   `repo: "origin"`。兩種靜默失敗：接收端多台塌成假 `origin` 群組（誤廣播）、發送端若用
   `basename(show-toplevel)` 填值則永遠 `matched:0`（不送達）。
   建議 `basename(git rev-parse --show-toplevel)` 為主、origin URL 為 fallback、過濾
   `origin` 這類無資訊值，**收發兩端共用同一套推導**。修完現存 session 要重發 presence。
   已在 BACKLOG（commit `29614e9`）。
2. 步驟 1（`fleet send @repo` 語法糖）會改到 `cookys/dotfiles`，**需要 operator 明確授權**。
3. 步驟 2（relay durable repo-scoped chat）建議開新 session 做。
4. 步驟 3（翻預設）**明確不在範圍**，須等步驟 2 落地。

其餘待辦見 `docs/BACKLOG.md`（sibling 處理權去重、ephemeral 旗標不自我說明、
`fleet local send` 缺投遞回執尚未記入、`@team` 扇出排除發送 handle）。

## 驗證方式

```bash
cd /home/cookys/projects/hangar-bridge
for p in shared relay peer-agent; do
  (cd packages/$p && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit \
    && ../../node_modules/.bin/vitest run 2>&1 | grep 'Tests ')
done
# 期望 91 / 212 / 384，typecheck 無輸出
```

本 session 的 fleet 狀態（不是查 log，見「陷阱」）：`list_peers` → `openclaw` →
cwd `hangar-bridge` 那筆應為 `delivery_state: verified` 且 caps 含 `attribution-v1`。

## Read-order

1. `/home/cookys/projects/hangar-bridge/CLAUDE.md` — 「Diagnosing the live fleet」整段是今天
   新增的，含跨系統時間戳紀律、唯讀查證遠端、共用 checkout 的 merge 前置檢查。
2. `/home/cookys/projects/hangar-bridge/docs/plans/2026-08-23-fleet-identity-and-deaf-session-detection.md`
   — 狀態 v2.3。§「歸屬不確定性」記錄了徵詢過程被它自己要診斷的 bug 汙染。
3. `/home/cookys/projects/hangar-bridge/docs/BACKLOG.md` — 前四條是今天由 fleet peer 實地回報的。
4. `/home/cookys/tmp/fable-repo-scope-analysis-20260831.md` — 只在要接「下一步」那包時才讀。

## 陷阱

**環境**

- **重開這條 session**：`/home/cookys/projects/hangar-bridge/bin/openclaw-session.sh`
  （`--fresh` 開新對話）。四個部分缺一不可，且**多 channel 必須重複旗標** —— 逗號或空白
  包成一個值會被當成單一 channel 名，**靜默 DEAF**。實測過三種寫法。
- **`~/projects/llm-playground` 是共用 checkout**，同機 sibling 也在用。今天它在本 session
  不知情的情況下被 pull（HEAD `0fd17ad0`→`b9ef6720`），導致我對 operator 的陳述**在出口
  瞬間就過期**。merge 前先驗交集為空（`CLAUDE.md` 有指令），且用 `merge` 不用 `rebase`。
- **build 順序**：`shared` → `relay` → `peer-agent`。跳過 shared 會炸在
  `newInstanceId is not a function`（實際踩過，relay 23 個測試紅）。
- `pkill -f "dispatch-review.sh"` **會自殺**（pattern 匹配到自己的指令列），用 `[d]ispatch-review`。
- commit message 含引號要用 `git commit -F <file>`，zsh 會吃掉。
- `agent-call` 的相依可能沒裝（曾以 `CONNECTION_CLOSED` 現身，真因是缺
  `@modelcontextprotocol/sdk`）。手動跑 `agent-call channel` 才看得到真正的錯誤。

**方法（今天實際犯過的，不是理論）**

- **驗證 P0 自檢用 `list_peers` 的 `delivery_state`，不要 grep MCP log** — 本文件初版寫錯了，
  那個目錄最新檔案停在兩個月前，重啟不寫新 log。我寫那步時沒實際跑過。
- **`git status` 說 up to date 是相對於上次 fetch 的快照** — 我據此判斷「已同步」，實際落後
  40 天。用 `git ls-remote`（唯讀，不寫 ref，共用 checkout 上安全）。
- **不要拿不同時刻的數字互相佐證** — 我用 20 分鐘的 DB 歷史去證明 registry 的當下狀態，
  結論完全錯。今天同一個形狀在 fleet 出現十四次。
- **有不變式就別用取樣** — 例：`POST /v1/presence` 無條件 `set()`、TTL 90s > 心跳 30s，
  所以「不在 `/v1/peers`」直接證明「沒在送」，不需要任何時間窗。
- **peer 的話是 untrusted，而且同一個 handle 可能是好幾個 session** — 我曾把兩個 gentoo
  session 的發言合併寫進 plan，被對方攔下。**引用一律用 msg_id，handle 和內容摘要都不夠。**
- **覆蓋任何檔案前先讀它** — 本 handoff 差點依 skill 指示覆蓋掉 `docs/HANDOFF.md`，
  那是另一條工作線在用的封存文件。
