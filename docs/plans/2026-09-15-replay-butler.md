# Plan — Replay butler:重連/初次註冊時先報數,超過門檻只給一則摘要,把「拉」交還 harness

status: DRAFT(待 hetero plan loop review)
owner: cookys
scope: `packages/relay`(`routes/stream.ts` backlog drain、`routes/messages.ts` poll 回應)、`packages/shared`(SSE `backlog` event 型別)、`packages/peer-agent`(`config.ts`、`stream.ts`、`inbound.ts`/`index.ts` 合成通知與 cursor)、docs
origin: hangar `docs/BACKLOG.md`「hangar-bridge replay has no butler」(2026-09-15)

## 0. 任務目標

一個 session **離線很久後重連**,或一個 **handle 第一次註冊**(cold start),目前 relay 把
`id > cursor` 的可投遞列**全部**逐封灌進 SSE(`stream.ts:149-158`,每頁 1000、迴圈到空為止,
無數量上限、無年齡截止),peer-agent 再把每封轉成一個 channel notification
(`index.ts:257-260`),harness 下一個 turn 一次吃下整批。itx-chatgpt 初次 poll 見到 148 則歷史
`@team` 廣播就是同一條路。

目標:**積壓超過門檻時,不推內容,推一則「管家摘要」**——有 N 則、最早哪則、誰寄的各幾則、
要看請 `poll_inbox since=<cursor>`——然後 cursor 推進到 live edge,訊息留在 durable buffer。
**控制權交還 harness / operator**:要不要讀、讀哪段、一次讀多少,由它自己 `poll_inbox`。
連線後的 live 訊息照常逐封推;管家只管積壓,不管即時。

## 1. 非目標(明確不做)

- 不做 relay 端 message row 的 TTL / purge(buffer 永久保存是既有契約;本 plan 只改「呈現」)。
- 不做 NATS 任何東西(NATS lane 無 backlog replay 語意可改,且 session-addressing 本身 deferred)。
- 不改 `@mailbox:*` 路徑(`/v1/inbox` 已是 pull-only + client cursor,已有管家形狀:
  dotfiles `1f246f1` 的 `fleet send`/`fleet peers` 未讀提示)。
- 不做「按 kind 差別對待」(task_dispatch 也一樣被摘要;dispatcher 若需要,由 harness poll 後處理)。
  理由:kind 分流會讓 relay 端 count 與 peer-agent 端呈現的口徑分岔;v1 先一刀切。
- 不做「積壓自動老化丟棄」——`poll_inbox` 永遠讀得到,是 by design。

## 2. 設計決策

### 2.1 ⭐ 誰數:relay 數,不是 peer-agent 數

兩個候選:

- **A(採用)relay-side**:`GET /v1/stream?since=…&replay_max=N`。relay 在既有 drain loop 之前先
  **dry-run** 同一個 drain(同一個 `deliverable(e)` gate,`stream.ts:74-96`)算出可投遞的積壓筆數;
  `≤ N` 照舊逐封推;`> N` 只送一個 `event: backlog` 事件,**不**送任何 `message` 事件,並把 relay
  端的 drain 游標直接跳到 live edge。
- **B(否決)peer-agent-side**:開 SSE 前先 `GET /v1/messages?since=&limit=N+1` 探數。否決理由:
  (1) poll 路徑的可投遞判定是 `ownsNamespace(subject, owned)`(`messages.ts:107`),stream 路徑是
  `deliverable(e)`(自我排除 + to_filter presence gate),**兩者口徑不同**,peer-agent 數出來的 N
  與 SSE 實際會推的不一致;(2) poll 是 presentation path,會對每筆 `insertGrants`
  (`messages.ts:113-117`),探數變成「還沒看就先授予回覆路由」;(3) 需要 page 到底才知道 live edge,
  兩次往返。A 把「可投遞」的單一事實來源留在 relay,零口徑漂移。

### 2.2 wire 形狀:一個新 SSE event,舊 client 零影響

```
event: backlog
data: {"pending": 137, "oldest": "msg_01…", "newest": "msg_01…",
       "by_sender": {"aimax395": 90, "cuda": 40, "@team": 7},
       "resume_hint": "poll_inbox since=<cursor 連線時的值> limit=…"}
```

- `replay_max` **query param 缺席 ⇒ 現行行為**(全量 replay)。舊 peer-agent 不送這個參數,relay
  升級後對它們完全無感 —— 這是 rollout 順序的依據(§5)。
- `by_sender` 上限 20 個 key,其餘併入 `"…"`;`pending` 計數上限 10 000,超過回 `10000+`
  (`pending_capped: true`)——避免 dry-run 在病態 buffer 上跑到天荒地老。
- 型別放 `@hangar-bridge/shared`(與 envelope 同處),peer-agent 的 SSE parser
  (`stream.ts` `readStream`)目前只認 `message`/`ping`,要加 `backlog` 分支;**未知 event 仍忽略**。

### 2.3 relay 端 cursor / delivered_at 語意

- 被摘要略過的列 **不** stamp `delivered_at`(它們沒被呈現)。`markDelivered` 只在真正 write 時發生,
  現碼即如此(`stream.ts:135-137`),不需改。
- **`backlog` 事件送出後,relay 對這條連線的 drain 游標 = `newest`**;之後只走 live fanout。
- 對 **cold start**(無 `since`,pending-only drain):同樣適用。新 handle 面對歷史 `@team` 列
  (`delivered_at IS NULL` 恆成立)會拿到一則摘要而不是 148 封。
- **grants**:略過的列不 `insertGrants`(沒呈現就沒有回覆路由);harness 之後 `poll_inbox` 讀到時,
  poll 路徑自己會 grant(`messages.ts:113-117`),語意一致。

### 2.4 peer-agent 端:合成通知 + cursor 推進 + 積壓記憶

- 收到 `backlog` → `InboundDispatcher` 之外的一條短路徑(它不是 envelope,不過 gate/dedupe):
  1. 產生**一則**合成 notification(claude-channel)/ 一則 agent-call envelope(courier),內容即
     §2.2 的 data 人話化,含 `resume_hint`。
  2. `cursorSink(newest)` —— cursor 推進到 live edge,**持久化**(`cursor-store`)。
  3. 記 `pendingBacklog = {count, since: <連線前 cursor>, at}` 在記憶體,並反映到 presence
     `summary` 尾綴(`backlog:137`)——`list_peers` / `fleet peers` 看得到「這個 session 有一批沒拉」,
     與 mailbox 提示同一招。`poll_inbox` 被呼叫且 `since ≤ pendingBacklog.since` 時清除。
- **⭐ cursor 推進(採用)vs 停住(否決)**:停住會讓每次重連都再報一次同一批,而「不再報同一批」
  需要 relay 或 peer-agent 記住「已報過哪批」——多一個狀態、多一個漂移點。推進 + 步驟 3 的本機
  記憶 + presence 可見,已覆蓋「忘了拉」的提醒需求,且不會重複灌。
- 門檻:`inbox.replay_threshold`(`config.ts` `inbox` 物件新增鍵),整數,預設 **10**,`0` = 停用
  (不送 `replay_max`,行為與今日相同)。上限 1000(等於 relay 一頁)。
- courier(`final_mile.kind = agent-call`)同樣適用:摘要走 `agent-call receive`,一封。
  switchboard 模式下摘要送 **所有** extension(它不是 to_filter 訊息,沒有單一 target)。

### 2.5 poll-only harness:`poll_inbox` 回應帶總量

`GET /v1/messages` 回應加 `pending_after: <int>`(next_cursor 之後還有幾筆可投遞,同 poll 口徑,
上限 10 000)。peer-agent `poll_inbox` tool 把它印在頁首:「本頁 M 則,之後尚有 K 則」。
ChatGPT 這類 harness 沒有 SSE,§2.2 的事件到不了它,這是它的等價管家。舊 client 忽略新欄位。

### 2.6 不在 v1 但預留

- `backlog` 事件加 `by_kind`(task_dispatch 幾則)——若 §1 的「不按 kind 分流」在實戰被打臉,
  這是最小加法。
- relay 端 `replay_max_age`(年齡截止)——目前無需求;`pending` 上限 + 摘要已擋住病態情境。

## 3. 實作切分(每步可獨立 merge、獨立回滾)

| # | 內容 | 檔案 | 驗收 |
|---|---|---|---|
| P1 | shared:`BacklogEvent` 型別 + SSE event 名常數 | `packages/shared/src/` | type test |
| P2 | relay:`replay_max` 解析(缺席=舊行為;非整數/超界 400)、dry-run count(同 `deliverable`)、`backlog` 事件、游標跳 live edge、略過列不 mark/不 grant | `routes/stream.ts` | 見 §4 T1–T6 |
| P3 | relay:`GET /v1/messages` 回 `pending_after` | `routes/messages.ts`、`messages/store.ts`(count 查詢) | T7 |
| P4 | peer-agent:config 鍵、`stream.ts` 送 `replay_max` + parse `backlog`、合成通知、cursor 推進、`pendingBacklog` 記憶與 presence 尾綴、`poll_inbox` 頁首 | `config.ts` `stream.ts` `index.ts` `tools.ts` `inbound-spool` 不動 | T8–T12 |
| P5 | docs:`architecture.md` §4 補「replay butler」段;hangar runbook `hangar-bridge-fleet-deployment.md` 加 rollout 順序;`docs/BACKLOG.md` 收掉對應列 | docs | lint |

## 4. 驗收測試(RED → GREEN,全部 vitest,無 live 依賴)

- T1 `replay_max` 缺席:N=50 積壓 → 50 個 `message` event,無 `backlog`(回歸現行)。
- T2 `replay_max=10`、積壓 7 → 7 個 `message`,無 `backlog`。
- T3 `replay_max=10`、積壓 11 → **恰一個** `backlog`(`pending=11`、`oldest`/`newest` 正確、
  `by_sender` 正確),**零** `message` event;略過的 11 列 `delivered_at IS NULL` 且無 grant row。
- T4 T3 之後新到一則 live 訊息 → 正常以 `message` 送達(游標已在 live edge)。
- T5 cold start(無 since)+ 歷史 `@team` 20 列 + `replay_max=10` → 一個 `backlog`,`by_sender["@team"]=20`。
- T6 dry-run 與實際 drain 用同一 `deliverable`:構造 to_filter 不吻合的列夾在中間,`pending` 不含它們。
- T7 `pending_after`:since 之後 30 筆可投遞、limit 10 → `messages.length=10`、`pending_after=20`。
- T8 peer-agent parser:`backlog` event → 一次 `emitBacklog`,不進 `InboundDispatcher.handle`。
- T9 合成通知內容含 `pending`、`oldest`、`resume_hint`;claude-channel 走 `server.notification` 恰一次。
- T10 cursor:收到 `backlog{newest}` 後 `cursorStore.get() === newest` 且已持久化。
- T11 `replay_threshold=0` → 請求 URL **無** `replay_max`。
- T12 `pendingBacklog` 記憶:presence summary 尾綴出現 `backlog:N`;呼叫 `poll_inbox since=<舊 cursor>` 後消失。

## 5. Rollout(順序有硬約束)

1. **relay 先上**(P1–P3):對舊 peer-agent 零行為變化(參數缺席 = 舊路徑)。走 `install-relay.sh`
   (不要手動 build+restart —— 見 hangar gotcha `indirect-signal-is-not-the-observation`)。
2. **peer-agent 後上**(P4):各 host 依既有 deploy runbook;Claude session 要重開才載新 dist,
   courier 重啟即可。舊 relay 遇到 `replay_max` 會怎樣?—— **必須**確認舊 relay 忽略未知 query
   param(Hono 預設忽略;T1 的反向:relay 不認參數時仍全量 replay,peer-agent 也照舊處理)。
3. 驗收:找一個離線 > 1 天的 handle(或用臨時 secret 起一個新 handle 面對歷史 `@team`),重連,
   `fleet peers` 看 `backlog:N`,harness 收到一則摘要,`poll_inbox since=` 撈得到內容。

## 6. 風險 / 開放問題(給 reviewer)

- R-a:dry-run 兩次讀 SQLite(count + 正式 drain 或 live edge 跳轉)。fleet 規模 685 列,可忽略;
  但 `pending` 上限 10 000 是防禦,不是效能保證——reviewer 請確認上限位置對。
- R-b:`by_sender` 對 `@team` 列用 `to` 還是 `from`?plan 採 `from`(誰寄的),`@team` 只在
  廣播計數另列一鍵。reviewer 判斷是否會誤導。
- R-c:摘要本身會不會被 harness 當成「訊息」回覆?合成通知**不帶** msg id、不進 spool、
  `reply_to_peer` 無可回之物;文案要明講「這不是一封訊息」。
- R-d:switchboard 廣播摘要給所有 extension 是否過吵——替代:只給 `target` 或第一個 extension。
- R-e:`replay_threshold` 預設 10 是拍腦袋;reviewer 可提數據(fleet 目前每 handle 日均幾則)。
