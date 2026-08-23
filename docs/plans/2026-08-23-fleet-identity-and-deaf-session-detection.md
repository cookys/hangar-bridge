# Plan — Fleet 身分模型重構 + 跨 harness 送達 + 失聰免疫（v2）

- **狀態**：v2.2 —— P0–P3 已實作合併（main `12446b9`）；P4 經 fleet 徵詢後否決，改為 P4'（路由/歸屬解耦）
- **日期**：2026-08-23
- **作者**：Claude Opus 5
- **v1 複驗紀錄**：四席 hetero review —— Fable r1（REWORK）、kimi r1 無 repo（SHIP-WITH-FIXES）、kimi r2 含全源碼（SHIP-WITH-FIXES）、gpt-5.6-sol max（STOP，8 findings）+ Fable 設計研究（native 對照）+ Fable 實測（四 harness MCP inbound 探針）。v2 吸收全部收斂發現。**v2 輪複驗**：kimi r3（SHIP-WITH-FIXES，R9 FAIL）、Fable r2（SHIP-WITH-FIXES，M1/M2）、sol v2（STOP，5 findings —— 逐一對照全部落在 kimi/Fable 已收斂修正簇，無新架構問題；transport 連續第三次 exhausted，內容取自 unratified）。v2.1 = v2 + 三席收斂修正。分歧裁決記於 §6。

---

## 0. 任務目標（不變）

hangar-bridge 是**單操作者 fleet 的跨主機、跨 harness 協同匯流排**：Claude Code、codex、grok、opencode、kimi 等 session 之間的對話、任務派遣與結果回報。Claude Code 原生 cross-session messaging 只覆蓋「同帳號 Claude↔Claude」子集，**不是本專案的替代品**（詳 §2.3）；對話式協同是本專案的目標之一，不外讓。

## 1. 事件背景（2026-08-23 事故鏈，已修正敘事）

### 1.1 靜默失聰（根因）

Claude Code session 未帶 `--dangerously-load-development-channels server:<config-key>` 時，客戶端丟棄該 server 的每一則 `notifications/claude/channel`，無任何錯誤。MCP 連線、tools、`/mcp`、outbound 全部正常 —— 唯一痕跡是 MCP log 一行 debug。

**正確的事故敘事（v1 錯誤，sol R1 更正）**：repo 有**三條安裝路徑，寫入不同的 config key**：

| 安裝路徑 | 寫入的 mcpServers key |
|---|---|
| `hangar-bridge init`（README §3 教的） | `hangar-bridge-peers`（`mcp-registration.ts:20`；恰與 serverInfo name 同名） |
| `packages/operations/claude-config/hangar-bridge.fragment.json` 手動合併 | `hangar-bridge-peer-agent`（fragment `_comment` 內含正確啟動指令） |
| `hangar-bridge init-project`（per-project） | `hangar-bridge-peers-<name>`（`init-project.ts:167` 經 `writeProjectMcpJson`，`:213` 印對應指令） |

本機走第二條路徑，而操作時抄了 README 的第一條指令 → key 不符 → 靜默丟棄。README 對走 init 流程的主機是**正確的**；問題是三條路徑的 key drift 且 README 只提第一條。P0 的 `HANGAR_MCP_KEY` plumbing 必須覆蓋全部三條（fragment 是靜態 JSON，改為文件要求手動補 env）。

**統計（sol 要求分母後修正）**：本 repo 的 MCP log 共 7 個 session，**4 個確認失聰**（有 skip 訊息），3 個無證據可判（無 inbound 流量時不產生 skip 行）。最早失聰證據 2026-06-26。v1 的「從未成功過」是過度斷言。

### 1.2 Presence 同 row 覆寫（v1「互踢」措辭已修正，Fable F7）

`(team, handle, label)` 三元組設計正確（registry 支援一 handle 多 label）。壞在 **label = token label，共用 secret 的 session label 相同** → 不是互刪對方的 row，是**同一個 row 互相覆寫**（`registry.ts:85`），任一連線 cleanup 即刪掉這唯一 row（`stream.ts:113`），倖存者顯示離線至多 30 秒直到下次心跳重建。

**實地證據（v1 錯誤丟棄，kimi r2 / sol R10 要求恢復）**：兩份相隔 69 分鐘的 presence 快照中，`openclaw` 的 cwd 一份是 `hangar-bridge`、一份是 `hangar` —— cwd 是 per-process 常數、時間不變，兩個值交替出現**只可能**來自兩個活 process 對同一 label row 的 last-writer-wins 覆寫。此為 §1.2 機制的直接指紋（與 last_seen 這類貼著讀取時刻的欄位不同，不受 69 分鐘時距污染）。

### 1.3 Handle collision（機器層級身分）

`self_handle` 是主機層級；`fanout.ts:61-68` 對同 handle 每個 subscriber 廣播。後果：送給 `cuda` 的訊息送達 cuda 那台**所有** session，每個 session 只看到自己那半邊 → 出現多則 `from="cuda"` 互相否認的 thread，被上報為疑似冒名安全事件。

**因果定位（gentoo 更正後）**：handle collision 單獨即足以產生互相否認（B 發訊、第三方問 A、A 誠實說不是我）；失聰只是放大器。8/22 該串與 gentoo 失聰時間軸（最後 7/14）對不上，不能用失聰解釋。逐則歸屬定案仍需 relay send log。

### 1.4 已完成的止血（GREEN，待 commit）

`inbound.ts` 吸收 `presence_update`（不 emit、推進 cursor）；README 補 config-key 警告。peer-agent 281 tests passed。cuda/gentoo 兩台獨立驗證 chat 照常、presence 不再灌 context。

## 2. 設計決策

### 2.1 身分：一層 durable handle + presence key 唯一化（v1 措辭降級，kimi r2 F9）

- **durable handle = `<host>-<project>`**：task backlog（`store.ts:66,83` 以 `to_handle` 查詢）、claims owner（`claims.ts:32,59`）、cursor resume（`stream.ts:91-92`）全部錨定於此，**必須跨 process 重啟穩定** —— 否則積壓 dispatch 變死信、claims 永遠無法 release。
- **instance id = per-process ULID**：**僅用於 presence/觀測，不是定址單位**（不做 `to_instance`；v1 表格把它超賣成「身分層」，撤回）。

單層替代方案的崩壞點（四席一致）：durable-only → §1.2 bug 本體；per-process-only → durable buffer 與 claims 全失錨，「重啟沿用同名」只是把 durable handle 偷渡回來。

**Native 對照（設計研究）**：Claude 原生也是「耐久層（工作目錄）+ 短暫層（session）」同構，它選短暫層當地址因為它不做持久投遞；本專案選耐久層是持久投遞的必然推論。原生的 session-name 模型（AI 生成標題、碰撞自動改名）為「人在場消歧」設計，對機器對機器的 dispatch 重試/claims/離線信箱不適用，**不採**。

### 2.2 Worktree 不進 handle（v1 §2.2 整段撤銷，設計研究裁決）

v1 提案 `<host>-<project>-<worktree>` 有三個致命傷（已逐一源碼驗證）：

1. **短暫實體配耐久身分**：`/l4`–`/l6` foreman worktree 朝生暮死，而 roster 靜態 —— 每個 handle 要進 `peers.json` + **重啟 relay（斷全 fleet SSE）**（`architecture.md:125-127`「no dynamic registration」）。每開一個 worktree 動一次全 fleet，不成立。
2. **32 字元上限**（`constants.ts:26`）：`cookys-7840hs-mple2-recovery` 已 28 字元。
3. `deriveProjectName` 從 git origin 推導（`init-project.ts:70`），同 repo 兩 worktree 同名，collision gate 反而擋住。

**修正**：worktree 資訊降為 **instance 層 metadata**（P3 的 ULID 旁掛 `worktree`/`cwd`，`list_peers` 顯示）。worktree 級定址：
- 「派給這個 repo」→ subject `repo.<name>.*` + cooperative claims 認領仲裁
- 「派給那個 worktree」→ 同 subject + claims，或未來與 NATS session-addressing gap（`architecture.md:289-291`）**一起**設計 instance 定址 —— 一套設計解兩邊，避免兩套。

副作用：v1 的 P4（init-project 學 worktree）大部分撤銷；P2/P4 順序爭議（Fable F5、sol R9）消失。

### 2.3 與 Claude 原生 cross-session messaging 的關係（v1 事實錯誤全數修正）

**v1 的兩處事實錯誤**（三席독立確認）：
1. ~~「bypass 會話預設 hold 5 分鐘後丟」~~ → 官方規則是**類別配對**：bypass→bypass **直接投遞**。本 fleet 全跑 `--dangerously-skip-permissions`，fleet 內原生互傳是直投。「黑洞」只發生在跨類別。
2. ~~「跨機需雙方 RC」~~ → 收方需 RC；送方無 RC 仍可送，僅單向無回信地址。

一手來源釘定（v2.1，kimi F7）：上述兩項的依據為 <https://code.claude.com/docs/en/cross-session-messaging>（§Message delivery / §Message sessions on other machines，2026-08-23 抓取）。另補官方細節（Fable m6）：非 own-child 的 socket 注入「asserts no permission class」→ bypass session 會 **hold 進 dialog**；全 bypass 無人值守 fleet 下，外部 harness 單向注入需 own-child token 或 `crossSessionInbound=accept` 才實際送達。

**修正後的定位**：原生覆蓋「同帳號、Claude↔Claude」子集且做得更好（零運維、mid-turn 投遞、內建 provenance）—— 該子集**可以**用原生，但本 fleet 的協同對象一半不是 Claude（§0），原生架構上看不到它們。hangar-bridge 的不可替代三條腿（kimi r2 逐一源碼驗證）：

1. **持久化/離線回補**：SQLite durable buffer + cursor resume（`store.ts:60-87`）；原生無 —— 目標離線即不可達。
2. **結構化語意**：六 kind envelope、`in_reply_to`、`correlation_id`、subject ACL；原生純文字。
3. **跨帳號/跨 harness 成員資格**：bearer/NKey；原生綁 claude.ai 帳號。措辭採 Fable：非 Claude harness 對原生是「**不支援**」（可經 `CLAUDE_CODE_MESSAGING_SOCKET` 單向注入、無法成為可收的對等節點），非「架構上不可能」。

**60 天證偽條件 + 測量計畫**（kimi r1 要求）：部署後以 relay 的 message 表統計 kind 分佈與 from/to 對；若 60 天後 `task_dispatch`/`task_result`/claims 流量趨零、僅剩 chat 且該 chat 全部發生於 Claude↔Claude 同帳號對（可用原生替代），則啟動 RETIRE 討論。

### 2.4 跨 harness inbound 送達（v2 新章，實測定案）

**實測結論**（探針 MCP server + 哨兵通知，四 harness 全跑）：MCP 規格中唯一保證抵達模型的 server 內容是 tool result；四家 client 對 server notification 零渲染（codex 宣告 `{elicitation}`、opencode `{}`、grok `{ui-ext}`、kimi `{}`）。**純 MCP 雙向被經驗否證** —— outbound + pull 四家全通，inbound push 四家全無。

**統一抽象（kimi）：durable inbox + best-effort doorbell** —— `poll_inbox` + 持久化 cursor 是**所有** harness 的統一正確性路徑（含 Claude busy-turn）；每家的注入面只是影響延遲的門鈴 driver。五列不是五個特例，是一個介面五個 driver（與既有 SSE/NATS transport 分割同構）。

**採 hybrid：MCP tool 面照用，inbound 喚醒走每家最原生的面**：

| harness | inbound 喚醒 | 最壞延遲 |
|---|---|---|
| Claude Code | `claude/channel`（現況） | 即時（idle）/ next-turn（busy） |
| opencode | `opencode serve` HTTP `POST /session/:id/prompt_async` | 即時 |
| kimi | `kimi web` REST `prompts` / `prompts:steer`（可插進行中 turn） | 即時 |
| codex | `Stop`/`PostToolUse` hook `additionalContext` 注入「poll inbox」 | 一個 turn |
| grok | 無任何注入面 → 降級 fork/exec 派工，或後續 TTY adapter | 無保證 |

- 每個 harness peer = 自己的 handle + `HANGAR_CONFIG_DIR` + secret（沿用 PROJECT_ISOLATION 機制）。
- 新增 `poll_inbox` MCP tool（durable、`since` cursor）—— 非 Claude harness 的 pull 主路徑，也是 Claude busy-turn 中的即時 pull（原始需求回歸）。
- **herdr.dev 暫不引入**：解 TTY 三難題但 socket 無 per-message 認證，等於把認證 envelope 的信任邊界在最後一哩換成無認證 socket；若日後自製 idle 偵測痛到不行再評估，且 socket 僅暴露給 peer-agent。
- 部署 gotcha：kimi 有 workspace-trust 閘，未受信任目錄的專案層 `mcp.json` 被靜默忽略 → 進 runbook。
- **文件化殘餘（sol R3 / kimi Q1）**：同一 `<host>-<project>` handle 下多個 worktree 都會收到直達訊息（fanout 對 handle 的每個 subscriber 投遞）；非認領者依 claims 所有權自濾。合作式、與 claims 的 advisory 設計一致；worktree 的精準投遞待 NATS session-addressing 一併設計。subject namespace 為首 token 制（`constants.ts:30-33`），`mple2.wt-l5.*` 掛在已擁有的 `mple2` 下**不需動 peers.json**。

### 2.5 Disposition 語意（v2 新增；解 sol R7 + 防線 3 誤報）

協同是對話不是命令：收訊方可以拒絕、反提案、討論 —— 今天這些只能用自由文字 chat 回，correlation 追不到，導致「逾時無 result」分不出聾了/拒了/做著。

**修正**：回覆 `meta` 增加 `disposition: accepted | declined | counter_proposal | in_progress | completed`，掛在既有 `correlation_id`/`in_reply_to` 上（envelope schema 不動，僅 meta 慣例 + tool 描述引導）。拒絕成為一等公民；失聯偵測的訊號變成「**無任何 disposition**」而非「無 result」。

**Capability gate（kimi F5 / sol R8）**：「無 disposition」只對「宣告支援 disposition 的 peer」有意義 —— presence meta 加 capability 位；混跑期舊 peer-agent 不列入 telemetry 分母。**全 fleet peer-agent binary 升級是明確步驟**（P4 換的是 handle/peers.json，不是 binary）。自由文字回覆造成的雜訊在 telemetry-only 階段可接受；若日後升告警再議 schema（屆時重審「不做」清單，不是現在偷渡）。

### 2.6 失聰免疫：從偵測轉為結構保證（設計研究核心裁決）

原生把「可列出」與「可投遞」綁成同一件事，結構上不存在「清單活著、實際聾了」。hangar-bridge 的 presence 宣告的是傳輸活性，與注入能力解耦 —— v1 的 P0/P5 是在偵測一個可以靠設計消滅的故障類別。

**v2.1 rescope（kimi F1 / Fable M1 / sol R9 三席收斂）**：loopback **無法**觀測 client 端渲染 —— channels 契約明文 notification 不被 ack、未載入即靜默丟；本次事故正是 `emit()` 成功而 client 丟棄。「結構保證」降格為「**不再可能無訊號存在**」：

- presence 位改**三值 `delivery_state: unverified | verified | deaf`**（Fable m8：此位實作挪入 P2，與 presence 程式一次改）。
- **Claude lane 的權威訊號 = `/proc` 祖先鏈旗標自檢**；loopback 降為 emit 路徑活性探針，loopback-ack（模型在迴路中回呼確認 tool）只做**機會性升級**到 verified —— 健康但安靜的 session 停留在 unverified，不誤判為 deaf。
- **per-harness verified 定義**：opencode = `prompt_async` 2xx + 自身 `poll_inbox` 迴路；kimi = REST accept + 同迴路；codex = 首次 Stop/PostToolUse hook 回呼（啟動時驗證結構上不可能）；grok = 恆為 poll-only，列 dispatch-only 而非 deaf。
- 旗標自檢**同時接受 `--channels` 與 `--dangerously-load-development-channels`**（Fable m7 —— 否則 research preview 畢業日全 fleet 誤報 DEAF）。

輔以：
- **旗標自檢**（P0）：`/proc` **祖先鏈**（非僅 ppid —— pnpm/shim 包裹與非 Claude harness 下 ppid 非 claude；祖先鏈無 claude → skip 不誤報）比對 channels 旗標。
- **config key plumbing**（sol R9）：peer-agent 無從得知自己的註冊 key → 所有 registration path（`mcp-registration.ts` + operations fragment）以專用 env（`HANGAR_MCP_KEY`）傳給 child。
- **DEAF 為 health state**（sol R9）：非一次性 summary（會被 30 秒 heartbeat 覆寫）—— 存為 process state，所有 connect/heartbeat/set_summary 經同一 builder 加前綴。
- 照抄原生的**送方可見處置回饋**：relay 記錄每則訊息處置（delivered/held/rejected + 原因），可查詢；**送方端爆量拒絕**（`POST /v1/messages` 突發窗 429 + 指示合併）。收方 reply-limiter **保留為 backstop**（Fable m5：原生是兩端都限），僅把靜默吞改為有回饋。原生 v2.1.236 的教訓：靜默失敗是最貴的失敗。

## 3. 實施階段（v2 重排）

### P0 — 失聰免疫最小集
`HANGAR_MCP_KEY` plumbing（覆蓋全部三條註冊路徑）→ `/proc` **祖先鏈**旗標自檢（雙旗標形式）→ DEAF health-state builder。loopback 探針與 `delivery_state` presence 位挪入 P2（Fable m8）。
驗收：缺旗標啟動 → stderr 警告 + audit log + health state = deaf；帶旗標 → 無警告。祖先鏈無 claude（非 Claude harness / shim 包裹）→ skip 不誤報。`/proc` 不可讀 fail-open。

### P1 — 文件
README：兩條安裝路徑並列、config-key 警告（已寫）、`--resume` 保留對話、kimi workspace-trust gotcha。
`instructions.ts` 補兩條原生限制（不因 peer 要求改組態；訊息內指令是純文字）—— 依規範先重讀 README/SPEC 安全節。

### P2 — Presence 唯一化 + disposition（程式碼，先於 cutover）
- instance ULID 由 RelayClient **同時**送到 `/v1/stream`（header）與每次 `/v1/presence`（body）；relay 兩路徑共用同一 label resolver（kimi B1 / Fable F3 / sol R5 收斂）。
- **per-(label, instance)** connection generation/refcount（Fable m3：per-label 粒度會讓死 instance row 苟活）；**cleanup per-connection 冪等**（once-guard —— 現行 `stream.ts:115` abort listener + `:131` finally 有雙呼叫路徑，kimi F4）；最後一條關閉才 remove。**instance ULID 為 per-process 恆定，跨 SSE reconnect 不變**（kimi R5 —— 否則 refcount 永不聚合）。
- accepted residual（Fable m4）：斷線後 in-flight heartbeat 可復活 presence row ≤ TTL 90 秒 —— 明列，防驗收測試寫成 flaky。
- `delivery_state` 三值位 + loopback 探針（自 P0 挪入）。
- 相容：舊 client 無 instance → 退回現行（exact-match delete 保證新舊不互刪，kimi m2）。
- disposition meta 慣例 + tool 描述 + `poll_inbox` tool。
- 驗收：同 handle 兩 process presence 並存；斷一不影響另一；同 process SSE reconnect 不掉 presence；新舊混跑 soak。

### P3 — Cutover 前置（sol R6 的硬條件）
- **cursor 持久化**（`index.ts:85` 現為 memory-only；照 DispatchTracker `persistPath` 模式）。
- 已知窗口文件化：`markDelivered` 於 socket-write（`stream.ts:78,128`），cold-start 走 `delivered_at IS NULL` —— relay 於 drain 中被 kill 對無 cursor client 靜默丟失。cursor 持久化把 cold-start 變罕見路徑。
- BACKLOG：per-row `delivered_at` 使未連線 peer 錯過已投遞的 `@team`（既有，kimi M3）。

### ~~P4 — 五台 per-project cutover~~ **已否決（2026-08-24，fleet 徵詢後）**

**否決理由（三席 peer 獨立收斂，均為實地第一手證據）**：

1. **不根治。** gentoo 實測 `pgrep -fc claude` = 8 而 handle 只有一個；同一專案本來就會開多支 session（其 h3 有兩個 cwd）。`<host>-<project>` 只把 8 支收斂到 3–4 個 handle，**同專案多 session 照樣互收對方的信**。
2. **兩種撞車形態只解一種。** gentoo 的撞車跨專案（per-project 能分）；cuda 的撞車同專案多 session（per-project 分不開，要 per-session，roster 更爆）。**又貴又不完整。**
3. **成本有外部性。** roster 靜態（`architecture.md:125`）⇒ 開新專案 = 產 secret + 改 `peers.json` + 重啟 relay + **斷全 fleet SSE**。cuda 原話：「把『開新專案』和『打斷所有人』綁在一起，代價會落在正在做長量測的人身上，而那個人通常不是開專案的那個人。」cuda 該台 revival.3d 有 29 個 worktree、5 個 agent 分屬 3 專案。
4. **解錯問題。** gentoo：「**P4 要解的問題（精準定址）不是咬到我們的問題（歸屬不明）**。」8/22 被上報為疑似冒名的安全事件裡，訊息送到對的機器了，壞的是不知道是哪支 session 說的。per-project handle 救不了。

### P4' — 路由與歸屬解耦（取代 P4）

gentoo 的框架，本 plan 採用：**路由維持機器/subject 層級（roster 不動），歸屬靠 per-instance 識別。** 嚴格優於 per-project handle：精準定址 + 精準歸屬，零 roster/重啟耦合。

**問題的真正形狀**（gentoo）：不是 spray，是**同 handle 兄弟之間互相隱形**。已在三個系統各出現一次 —— relay（同 handle 多 session）、git（兩個 session 獨立修同一個 presence bug，7/23 `d30c8da` vs 本 branch `fe51139`，靠 non-fast-forward 才擋下）、Claude Code channels 旗標（聾兩個月無人知）。

**P4'a — per-message 歸屬（先做，成本近零）**
- P2 的 per-process instance ULID 一併放進每則 envelope 的 `meta`
- 加 `CLAUDE_CODE_SESSION_ID`（**實測：直接存在於 peer-agent 環境變數**，不需走 `/proc`）
- 收訊端可見 `from=cuda#<instance>`，能自證「這則不是我發的」、能過濾非本線 inbound
- 不動 handle / roster / relay 重啟

**P4'b — fanout 直達分支排除寄件者（一行）**
`fanout.ts` 的 `@team` 分支有 `if (handle === e.from) continue`，**直達分支沒有** → 同機送給自己的 handle 時訊息原封回到自己（cuda 2026-08-24 實地踩到）。

**P4'c — 失聰 fail-safe（gentoo 的 P0 回饋）**
> 一個聾掉的 peer-agent 繼續 send，可能比它安靜死掉更糟 —— 它發出看似正常、實則基於殘缺 context 的發言，收訊端無從分辨。8/22 那個 thread 就是這樣長出來的。

採用：**outbound 每則自動掛 DEAF 標記**（非硬拒 —— 聾掉的 session 仍需能對外求救，硬拒會使其成為完全孤島；標記讓收訊端自行判斷採信度）。

**P4'd — subject + claims 精準定址（觀察後再議）**
subject namespace 首 token 制（`constants.ts:30-33`），`mple2.wt-l5.*` 掛在已擁有的 `mple2` 下不需動 `peers.json`。等 P4'a 上線觀察實際定址痛點再決定粒度（專案？worktree？角色？）—— cuda：不用先猜對粒度。

### P5 — 跨 harness peer 試點
codex + opencode 各一個 peer（獨立 handle/config/secret）：跑通「Claude dispatch_task → 對方收到（各自注入面）→ disposition 回報」全迴路。grok 維持 fork/exec。

### 觀測與退場
防線 3 降級為**無告警 telemetry**（stalled-correlation 計數，claim-aware：已 claim 不算失聯），跑一個月量測基線後再議告警（sol R7 / kimi R7）。60 天 RETIRE 證偽條件（sol R4 要求可執行）：`SELECT kind, COUNT(*) FROM message WHERE sent_at >= <cutover日> AND kind != 'presence_update' GROUP BY kind` + from/to 對分佈；`task_dispatch`+`task_result`+claims API 呼叫合計趨零、且 chat 全數為 Claude↔Claude 同帳號對 → 啟動 RETIRE 討論。

### 明確不做
envelope schema、`<channel>` 形狀、`instructions.ts` 安全措辭弱化、claims API、`to_instance` 定址（與 NATS 一起設計）、以 native 取代 task_dispatch、SSE instance-lock、herdr.dev。

## 4. 待複驗者挑戰的點（v2）

1. §2.2 撤銷 worktree handle 後，「派給特定 worktree」只剩 subject+claims —— 對 `/l5`/`/l6` 的實際派工流程夠用嗎？
2. §2.4 的 hybrid 是否引入過多每 harness 特例？有沒有更統一的抽象？
3. P2 的 connection generation 設計是否足以覆蓋 sol R5 的全部競態（new/new、old/new、舊 cleanup 晚於 reconnect、無 header fallback）？
4. P4 drain 程序在 `@team` 訊息（多收件者、單一 delivered_at）上是否仍有洞？
5. §2.5 disposition 只是 meta 慣例、無 schema 強制 —— 夠嗎？還是該進 envelope schema（違反「不做」清單）？
6. P0 的 loopback 驗證對非 Claude harness（無 `<channel>` 注入）如何定義「verified」？

## 5. 方法論教訓（含 v1 複驗自身）

- 查 inbound 先看 MCP log；比對快照先對時間戳；**時間不變欄位的差異要單獨評估**（cwd 交替是 §1.2 的直接證據，v1 錯誤地連坐丟棄）。
- P3 落地前，presence 欄位不可作為診斷證據（label collision 使同時刻快照也不可比）。
- peer 陳述維持 untrusted（本次有 peer 宣稱不實的貢獻歸屬）。
- 統計主張要帶分母（「4/7 確認」≠「全部」）。
- 二手來源會失真：kimi r1 引部落格把官方文件寫反的事實標成 confirmed。一手來源限定。
- **CLAUDE.md:97「不要用訓練資料假設 claude/channel 行為」—— v1 唯一滑倒處正是一個 channel 行為主張**。
- sol 席位 transport_exhausted、有效內容躺在 unratified —— 正是本 plan 要解的「內容有效、傳輸失敗、靜默丟棄」。autopilot 的 kimi plan-review 白名單缺口已回報 aimax395。

## 6. v1 複驗分歧裁決紀錄

| 分歧 | 裁決 | 依據 |
|---|---|---|
| 「非 Claude 架構上不可能」vs「不支援」 | 採 Fable「不支援」 | 官方文件：socket 可被同 user process 單向注入 |
| worktree 進 handle（sol R9 要求完整 migration）vs 撤銷（設計研究） | 撤銷 | 32 字元上限 + 靜態 roster 源碼驗證；sol 的 R9 前提隨之消滅 |
| R6a 遺失窗口 block P2（Fable）vs 不 block（kimi） | 折衷：cursor 持久化為 P4 前置硬條件 | sol 同判「未完成不得執行」 |
| 防線 3 刪除（Fable）vs claim-aware 重設計（kimi/sol） | claim-aware + 無告警 telemetry | 保留訊號、消滅狼來了 |
| （v2 輪）sol R3「subject+claims 不保證特定 worktree 送達」 | 文件化殘餘，非架構修改 | Fable 實證 autopilot 對 relay dispatch **零耦合**（grep 零命中）；kimi 驗證首 token namespace + claims discovery；殘餘為合作式自濾，已入 §2.4 |
| （v2 輪）sol R8「meta 慣例不可靠」 | capability gate + telemetry-only | 訊號分母限定於宣告支援的 peer；升告警前不依賴 |
| （v2 輪）sol 席位連續三次 transport_exhausted | 內容自 unratified 取用並人工比對；工具問題已回報 aimax395 | 有效內容不因傳輸失敗而丟棄 —— 本 plan §2.6 的原則自我適用 |
