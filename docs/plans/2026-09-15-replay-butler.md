# Plan — Replay butler:重連/初次註冊時先報數,超過門檻只給一則摘要,把「拉」交還 harness

status: DRAFT r2(gen-1 hetero 審查後修訂:sol STOP ×4 / MiniMax、glm CONDITIONAL,全部 fold)
owner: cookys
scope: `packages/relay`(`routes/stream.ts` backlog drain、`routes/messages.ts` poll 回應)、`packages/shared`(SSE `backlog` event 型別)、`packages/peer-agent`(`config.ts`、`stream.ts`、`inbound.ts`/`index.ts` 合成通知與 cursor)、docs
origin: hangar `docs/BACKLOG.md`「hangar-bridge replay has no butler」(2026-09-15)

## 0. 任務目標

一個 session **離線很久後重連**,或一個 **handle 第一次註冊**(cold start),目前 relay 把
`id > cursor` 的可投遞列**全部**逐封灌進 SSE(`stream.ts:149-158`,每頁 1000、迴圈到空為止,
無數量上限、無年齡截止),peer-agent 再把每封轉成一個 channel notification
(`index.ts:257-260`),harness 下一個 turn 一次吃下整批。itx-chatgpt 初次見到 148 則歷史
`@team` 廣播是同病的 **poll 路徑**(`fetchInboxSince` 純 cursor,`messages/store.ts:198-215`);
SSE cold start 只 drain `delivered_at IS NULL`,而 `delivered_at` 是**每則全域一枚**(任一收件者
被 write 過就 stamp,`store.ts:217-221`),所以歷史 `@team` 對新 handle 多半已不在 cold-start 集合。

目標:**積壓超過門檻時,不推內容,推一則「管家摘要」**——有 N 則、最早哪則、誰寄的各幾則、
要看請 `poll_inbox since=<cursor>`——然後 cursor 推進到 live edge,訊息留在 durable buffer。
**控制權交還 harness / operator**:要不要讀、讀哪段、一次讀多少,由它自己 `poll_inbox`。
連線後的 live 訊息照常逐封推;管家只管積壓,不管即時。

## 1. 非目標(明確不做)

- 不做 relay 端 message row 的 TTL / purge(buffer 永久保存是既有契約;本 plan 只改「呈現」)。
- 不做 NATS 任何東西(NATS lane 無 backlog replay 語意可改,且 session-addressing 本身 deferred)。
- 不改 `@mailbox:*` 路徑(`/v1/inbox` 已是 pull-only + client cursor,已有管家形狀:
  dotfiles `1f246f1` 的 `fleet send`/`fleet peers` 未讀提示)。
- **kind 分流只有一條,且是豁免不是差別呈現**:`task_dispatch` 與 `permission_request` **永遠逐封
  replay、不進摘要**。理由:fleet 把「dispatch 無任何 disposition」讀成 lost session
  (`inbound.ts:101-106` 的廣播閘已為同一理由豁免 dispatch;`tools.ts:211` 描述明寫 silence 是
  唯一訊號),摘要掉一則 dispatch 等於製造假的 lost-session;permission 稀少且時效性強。
  chat 才是洪水的本體(同段註解:116 則中 91 則是廣播)。摘要 `by_kind` 回報這兩類各幾則被逐封推。
- 不做「積壓自動老化丟棄」——`poll_inbox` 永遠讀得到,是 by design。

## 2. 設計決策

### 2.1 ⭐ 誰數:relay 數,不是 peer-agent 數

兩個候選:

- **A(採用)relay-side**:`GET /v1/stream?since=…&replay_max=N`。relay 在既有 drain loop 之前先
  算積壓;`≤ N` 照舊逐封推(現行 `deliverable(e)` gate,`stream.ts:74-96`);`> N` 只送一個
  `event: backlog`,**不**送 chat 類 `message` 事件(§1 豁免的 kind 仍逐封推),游標跳到高水位。
- **⭐ 計數口徑 = poll 口徑,不是 stream 口徑**(gen-1 glm R4 / sol R2 修正)。摘要的 `resume_hint`
  指向 `poll_inbox`,所以 `pending` 必須等於 harness 之後 poll 會看到的筆數,否則「有 12 則、
  poll 出 8 則」自相矛盾。poll 口徑 = `fetchInboxSince`(handle/@team/sender_instance 自我排除,
  `store.ts:198-215`)+ `ownsNamespace`(`messages.ts:107`);它比 stream 口徑**寬**(不含 to_filter
  presence gate 與 interest 收窄)——寬的那部分本來就是 poll 今日已可見的列,不是新暴露。
  實作:抽一個 `countPollable(handle, instance, since, cap)` 進 `messages/store.ts`,`backlog.pending`
  與 §2.5 `pending_after` **共用它**;T6 改為驗證兩者相等。stream 與 poll 口徑的統一是另一個 plan。
- **⭐ 高水位規則**(sol R2):relay 先 `subscribe`(現碼已如此,`stream.ts:123-125`),再計數;
  計數時取 `H = 快照內最大 id`;`backlog.newest = H`;之後 live queue 中 **id ≤ H 的 envelope 一律丟棄**
  (它們已計入摘要,poll 可讀)。relay 的 `newMessageId` 單調,所以 `id ≤ H` 是精確的分界;
  這保證「摘要之後零封 chat message 事件來自積壓」。
- **B(否決)peer-agent-side**(開 SSE 前先 poll 探數):poll 是 presentation path,每筆
  `insertGrants`(`messages.ts:113-117`)= 沒看就先授回覆路由;要 page 到底才知高水位;高水位丟棄
  只有 relay 能做到原子。

### 2.2 wire 形狀:一個新 SSE event,舊 client 零影響

```
event: backlog
data: {"pending": 137, "pending_capped": false, "oldest": "msg_01…", "newest": "msg_01…",
       "by_sender": {"aimax395": 90, "cuda": 40, "@team": 7},
       "by_kind": {"chat": 135, "task_dispatch": 2},
       "replayed_exempt": 2,
       "resume_hint": "poll_inbox since=<連線時 cursor> limit=…"}
```

- `replay_max` **query param 缺席 ⇒ 現行行為**(全量 replay)。舊 peer-agent 不送這個參數,relay
  升級後對它們完全無感 —— 這是 rollout 順序的依據(§5)。
- `by_sender` 上限 20 個 key,其餘併入 `"…"`;`pending` 計數上限 10 000,`pending_capped: true`
  表示「恰 10 000 且可能更多」,`false` 表示精確值(sol R6:恰好 10 000 時靠旗標消歧)——避免計數
  在病態 buffer 上跑到天荒地老。`replay_max` 非整數 / `< 1` / `> 1000` → 400 `invalid_replay_max`。
- 型別放 `@hangar-bridge/shared`(與 envelope 同處),peer-agent 的 SSE parser
  (`stream.ts` `readStream`)目前只認 `message`/`ping`,要加 `backlog` 分支;**未知 event 仍忽略**。

### 2.3 relay 端 cursor / delivered_at 語意

- 被摘要略過的列 **不** stamp `delivered_at`(它們沒被呈現)。`markDelivered` 只在真正 write 時發生,
  現碼即如此(`stream.ts:135-137`),不需改。注意 `delivered_at` 是每則全域一枚(`store.ts:217-221`
  `COALESCE`),不是 per-recipient;本 plan 不改這點。
- **`backlog` 事件送出後,relay 對這條連線的 drain 游標 = `newest`(= H)**;之後只走 live fanout,
  且套用 §2.1 的 `id ≤ H` 丟棄規則。
- 對 **cold start**(無 `since`,pending-only drain):同樣適用,但集合是 `delivered_at IS NULL`
  的列——因為 `delivered_at` 全域,歷史 `@team` 多半已被別人的連線 stamp,新 handle 的 cold-start
  積壓通常很小;它真正會撞到 148 封的是 poll 路徑,由 §2.5 的 `pending_after` 管。
- **grants**:略過的列不 `insertGrants`(沒呈現就沒有回覆路由);harness 之後 `poll_inbox` 讀到時,
  poll 路徑自己會 grant(`messages.ts:113-117`),語意一致。

### 2.4 peer-agent 端:合成通知 + cursor 推進 + 積壓記憶

- 收到 `backlog` → `InboundDispatcher` 之外的一條短路徑(它不是 envelope,不過 gate/dedupe):
  1. 產生**一則**合成 notification(claude-channel)/ 一則 agent-call envelope(courier),內容即
     §2.2 的 data 人話化,含 `resume_hint`。
  2. `cursorSink(newest)` —— cursor 推進到 live edge,**持久化**(`cursor-store`)。
  3. 記 `pendingBacklog = {count, since: <連線前 cursor>, newest: H, at}` **持久化在 cursor-store
     同一個檔**(`cursor-store.ts` 現有 `persistPath`,新增一個鍵;sol R5:記憶體版本 restart 就忘),
     並反映到 presence `summary` 尾綴(`backlog:137`)——`list_peers` / `fleet peers` 看得到「這個
     session 有一批沒拉」。**清除規則**:`poll_inbox` 回應的 `next_cursor ≥ newest` 才清;部分 poll
     (`next_cursor < newest`)只把 `count` 更新為回應的 `pending_after`,不清。
- **⭐ cursor 推進(採用)vs 停住(否決)**:停住會讓每次重連都再報一次同一批,而「不再報同一批」
  需要 relay 或 peer-agent 記住「已報過哪批」——多一個狀態、多一個漂移點。推進 + 步驟 3 的本機
  記憶 + presence 可見,已覆蓋「忘了拉」的提醒需求,且不會重複灌。
- 門檻:`inbox.replay_threshold`(`config.ts` `inbox` 物件新增鍵),整數,預設 **10**,`0` = 停用
  (不送 `replay_max`,行為與今日相同)。上限 1000(等於 relay 一頁)。
- courier(`final_mile.kind = agent-call`)同樣適用,但 final mile 的 API 只吃 `Envelope`
  (`agent-call-ingress.ts:15,39`、`switchboard.ts:189,277`;sol R10):peer-agent **本機合成一個
  Envelope** —— `id` 本機鑄造(ULID,前綴 `msg_`)、`from`/`to` = 自身 handle、`kind: chat`、
  `meta: {synthetic: "backlog", reply: "none"}`、content = 摘要人話。它不進 spool、不進 relay;
  `reply_to_peer` 對它會被 relay 以 unknown `in_reply_to` 拒絕(400),這是預期且寫進文案。
  switchboard:有 `target` 就只送 `target`,否則送全部 extension(R-d 收口)。

### 2.5 poll-only harness:`poll_inbox` 回應帶總量

`GET /v1/messages` 回應加 `pending_after: <int>` + `pending_capped: <bool>`(next_cursor 之後還有
幾筆可投遞,**與 §2.1 `countPollable` 同一函式**,上限 10 000)。peer-agent `poll_inbox` tool 把它印在頁首:「本頁 M 則,之後尚有 K 則」。
ChatGPT 這類 harness 沒有 SSE,§2.2 的事件到不了它,這是它的等價管家。舊 client 忽略新欄位。

### 2.6 不在 v1 但預留

- stream 與 poll 可投遞口徑統一(§2.1)——本 plan 只共用計數函式,不動 poll 的過濾。
- relay 端 `replay_max_age`(年齡截止)——目前無需求;`pending` 上限 + 摘要已擋住病態情境。

## 3. 實作切分(每步可獨立 merge、獨立回滾)

| # | 內容 | 檔案 | 驗收 |
|---|---|---|---|
| P1 | shared:`BacklogEvent` 型別 + SSE event 名常數 | `packages/shared/src/` | type test |
| P2 | relay:`replay_max` 解析(缺席=舊行為;非法 400)、`countPollable`、`backlog` 事件、高水位 H + `id ≤ H` live 丟棄、豁免 kind 逐封、略過列不 mark/不 grant | `routes/stream.ts`、`messages/store.ts` | 見 §4 T1–T6、T13–T15 |
| P3 | relay:`GET /v1/messages` 回 `pending_after` + `pending_capped`(共用 `countPollable`) | `routes/messages.ts` | T7、T16 |
| P4 | peer-agent:config 鍵、`stream.ts` 送 `replay_max` + parse `backlog`、合成通知 / 合成 Envelope、cursor 推進、`pendingBacklog` 持久化與 presence 尾綴、`poll_inbox` 頁首 | `config.ts` `stream.ts` `index.ts` `tools.ts` `cursor-store.ts` `agent-call-ingress.ts` `switchboard.ts`;`inbox-spool` 不動 | T8–T12、T17 |
| P5 | docs:`architecture.md` §4 補「replay butler」段;hangar runbook `hangar-bridge-fleet-deployment.md` 加 rollout 順序;`docs/BACKLOG.md` 收掉對應列 | docs | lint |

## 4. 驗收測試(RED → GREEN,全部 vitest,無 live 依賴)

- T1 `replay_max` 缺席:N=50 積壓 → 50 個 `message` event,無 `backlog`(回歸現行)。
- T2 `replay_max=10`、積壓 7 → 7 個 `message`,無 `backlog`。
- T3 `replay_max=10`、積壓 11 → **恰一個** `backlog`(`pending=11`、`oldest`/`newest` 正確、
  `by_sender` 正確),**零** `message` event;略過的 11 列 `delivered_at IS NULL` 且無 grant row。
- T4 T3 之後新到一則 live 訊息 → 正常以 `message` 送達(游標已在 live edge)。
- T5 cold start(無 since)+ 歷史 `@team` 20 列 + `replay_max=10` → 一個 `backlog`,`by_sender["@team"]=20`。
- T6 口徑一致:同一組列下 `backlog.pending` === `GET /v1/messages` 的 `pending_after`(同 `countPollable`)。
- T7 `pending_after`:since 之後 30 筆可投遞、limit 10 → `messages.length=10`、`pending_after=20`。
- T8 peer-agent parser:`backlog` event → 一次 `emitBacklog`,不進 `InboundDispatcher.handle`。
- T9 合成通知內容含 `pending`、`oldest`、`resume_hint`;claude-channel 走 `server.notification` 恰一次。
- T10 cursor:收到 `backlog{newest}` 後 `cursorStore.get() === newest` 且已持久化。
- T11 `replay_threshold=0` → 請求 URL **無** `replay_max`。
- T12 `pendingBacklog`:presence summary 尾綴出現 `backlog:N`;restart 後仍在(持久化);部分 poll
  (`next_cursor < newest`)只更新 count;`next_cursor ≥ newest` 才清除。
- T13 高水位:計數快照後、`backlog` 事件前插入一則 live chat(id ≤ H)→ 不以 `message` 事件出現;
  id > H 的 live chat 正常出現。
- T14 豁免 kind:積壓 20 chat + 1 task_dispatch、`replay_max=10` → 一個 `backlog`(`pending=20`、
  `by_kind.task_dispatch=1`、`replayed_exempt=1`)**加**一個 task_dispatch `message` 事件。
- T15 `replay_max` 非法值(`abc`、`0`、`1001`)→ 400 `invalid_replay_max`。
- T16 `pending_capped`:10 001 列 → `pending=10000, pending_capped=true`;恰 10 000 列 → `false`。
- T17 courier 合成 Envelope:agent-call final mile 收到恰一封、`meta.synthetic=backlog`、`reply=none`;
  switchboard 有 `target` 時只送該 extension;內容含「這不是一封訊息、不可回覆」字樣。

## 5. Rollout(順序有硬約束)

1. **relay 先上**(P1–P3):對舊 peer-agent 零行為變化(參數缺席 = 舊路徑)。走 `install-relay.sh`
   (不要手動 build+restart —— 見 hangar gotcha `indirect-signal-is-not-the-observation`)。
2. **peer-agent 後上**(P4):各 host 依既有 deploy runbook;Claude session 要重開才載新 dist,
   courier 重啟即可。混合版本已驗證(gen-1 R3):舊 relay 的 `/v1/stream` handler 只讀 `since`
   (`stream.ts:30`),不校驗其他 query key → 未知 `replay_max` 被忽略、全量 replay;舊 peer-agent
   `consume()` 對 `event !== 'message'` 直接 `continue`(`stream.ts:191-192`)→ 未知 `backlog` 事件
   被忽略而非 throw。
3. 驗收:找一個離線 > 1 天的 handle(或用臨時 secret 起一個新 handle 面對歷史 `@team`),重連,
   `fleet peers` 看 `backlog:N`,harness 收到一則摘要,`poll_inbox since=` 撈得到內容。

## 6. 風險 / 開放問題(給 reviewer)

- R-a:dry-run 兩次讀 SQLite(count + 正式 drain 或 live edge 跳轉)。fleet 規模 685 列,可忽略;
  但 `pending` 上限 10 000 是防禦,不是效能保證——reviewer 請確認上限位置對。
- R-b:`by_sender` 對 `@team` 列用 `to` 還是 `from`?plan 採 `from`(誰寄的),`@team` 只在
  廣播計數另列一鍵。reviewer 判斷是否會誤導。
- R-c:摘要會不會被 harness 當成「訊息」回覆?claude-channel 路徑不帶 msg id;courier 路徑的合成
  Envelope 有本機 id 但 `meta.reply=none`,relay 對它的 `in_reply_to` 回 400;文案明講「這不是一封
  訊息」(T17 驗)。
- R-d:已收口——switchboard 有 `target` 只送 `target`,否則全部。
- R-e:`replay_threshold` 預設 10 是拍腦袋;reviewer 可提數據(fleet 目前每 handle 日均幾則)。
