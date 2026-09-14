# Plan — Replay butler:重連/初次註冊時先報數,超過門檻只給一則摘要,把「拉」交還 harness

status: REVIEWED r3 — hetero plan loop 兩代到頂(sol gpt-5.6-sol / MiniMax-M3 / glm-5.3),depth-0 裁決收斂,可動工(dev-flow)
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
- **只有 `kind === 'chat'` 進摘要;其他每一種 kind 永遠逐封 replay**(`task_dispatch`、`task_result`、
  `permission_request`、`permission_verdict`;`presence_update` 本就不落盤)。理由:非 chat 的 kind 各有
  接收端的狀態機——dispatch 的 correlation / 「無 disposition = lost session」(`inbound.ts:101-106`、
  `tools.ts:211`)、`task_result` 的 dispatchTracker、permission 兩端的 tracker(`inbound.ts:141-183`)——
  摘要掉任一則都是讓一個追蹤器等到天荒地老。chat 才是洪水本體(同段註解:116 則中 91 則是廣播)。
- 不做「積壓自動老化丟棄」——`poll_inbox` 永遠讀得到,是 by design。

## 2. 設計決策

### 2.1 ⭐ 誰數:relay 數,不是 peer-agent 數

兩個候選:

- **A(採用)relay-side**:`GET /v1/stream?since=…&replay_max=N`。relay 在既有 drain loop 之前先
  算積壓;`≤ N` 照舊逐封推(現行 `deliverable(e)` gate,`stream.ts:74-96`);`> N` 只送一個
  `event: backlog`,**不**送 chat 類 `message` 事件(§1 豁免的 kind 仍逐封推),游標跳到高水位。
- **⭐ 母體與計數口徑(gen-2 sol R2/R4、glm R4 收口)**:母體 P = **這條連線在沒有 `replay_max`
  時會逐封推的列**——since-resume 用 `fetchSince`、cold start 用 `fetchPendingSince`(現行兩個分支,
  `stream.ts:149-151`),都再過同一個 `deliverable(e)`。`pending = |P ∩ chat|`;`replayed_exempt =
  |P \ chat|`(這些照常逐封推)。**不再宣稱 pending 等於 poll 會回的筆數**:poll 口徑較寬(無
  to_filter / interest 收窄、含已 stamp 的歷史列),所以 `poll_inbox since=resume_since` 回的是 P 的
  **超集**——摘要說的是「你錯過了 N 則」,不是「poll 會給你 N 則」;文案照此寫。`pending_after`
  (§2.5)是 poll 口徑,回答另一個問題(「這頁之後還有幾則」),兩者不比較。
- **掃描界限與高水位(R-a 收口)**:單次順序掃描 P,最多 **10 000 列**;`H = 最後掃到的 id`;掃滿
  10 000 則 `pending_capped=true` 且 H 停在第 10 000 列(其餘留給下次重連)。relay 先 `subscribe`
  (現碼 `stream.ts:123-125`),再掃描;掃描後 live queue 中 **id ≤ H 的 envelope 一律丟棄**(已計入
  摘要,poll 可讀)。relay `newMessageId` 是 ULID、單調(`shared/src/ulid.ts`),`id ≤ H` 是精確分界。
- **B(否決)peer-agent-side**(開 SSE 前先 poll 探數):poll 是 presentation path,每筆
  `insertGrants`(`messages.ts:113-117`)= 沒看就先授回覆路由;要 page 到底才知高水位;高水位丟棄
  只有 relay 能做到原子。

### 2.2 wire 形狀:一個新 SSE event,舊 client 零影響

```
event: backlog            ← 先送:摘要 + 高水位;peer-agent 持久化 pendingBacklog,cursor 不動
data: {"pending": 137, "pending_capped": false, "oldest": "msg_01…", "newest": "msg_01…",
       "resume_since": "<連線時的 since;cold start 為 \"\">",
       "by_sender": {"aimax395": 90, "cuda": 40, "@team": 7}, "replayed_exempt": 2}
event: message …          ← 中間:P \ chat 逐封(cursor 照常逐封前進)
event: backlog_end        ← 最後:peer-agent 此時才把 cursor 推到 newest
data: {"newest": "msg_01…"}
```

- **事件順序**(gen-2 sol R4):`backlog` → 豁免列逐封 → `backlog_end`。中途斷線:cursor 停在最後一封
  豁免列,重連後 relay 重新計數(chat 會再被摘要一次,豁免列不會漏);`backlog_end` 之後才推進到 H,
  所以「豁免列永遠送達」與「cursor 不越過未持久化的摘要」同時成立。
- `by_sender` 歸因:`to === '@team'` 的列**只**計入 `"@team"` 鍵,直送列計入 `from`(範例 90+40+7 = 137)。

- `replay_max` **query param 缺席 ⇒ 現行行為**(全量 replay)。舊 peer-agent 不送這個參數,relay
  升級後對它們完全無感 —— 這是 rollout 順序的依據(§5)。
- `by_sender` 上限 20 個 key,其餘併入 `"…"`;`pending_capped` 語意見 §2.1(恰 10 000 且掃描停止 =
  `true`)。`replay_max` 非整數 / `< 1` / `> 1000` → 400 `invalid_replay_max`。
- 型別放 `@hangar-bridge/shared`(與 envelope 同處),peer-agent 的 SSE parser
  (`stream.ts` `readStream`)目前只認 `message`/`ping`,要加 `backlog` 分支;**未知 event 仍忽略**。

### 2.3 relay 端 cursor / delivered_at 語意

- 被摘要略過的列 **不** stamp `delivered_at`(它們沒被呈現)。`markDelivered` 只在真正 write 時發生,
  現碼即如此(`stream.ts:135-137`),不需改。注意 `delivered_at` 是每則全域一枚(`store.ts:217-221`
  `COALESCE`),不是 per-recipient;本 plan 不改這點。
- **`backlog_end` 之後 relay 對這條連線只走 live fanout**,套用 §2.1 的 `id ≤ H` 丟棄規則。
- **cold start**(無 `since`):母體是 `fetchPendingSince`(`delivered_at IS NULL`)∩ `deliverable`,
  與 §2.1 一致;`resume_since = ""`,poll 從頭讀會看到含歷史 stamp 列的超集(§2.1 已明說)。因
  `delivered_at` 全域,新 handle 的 cold-start 積壓通常小;148 封那種是 poll 路徑,由 §2.5 管。
- **grants**:略過的列不 `insertGrants`(沒呈現就沒有回覆路由);harness 之後 `poll_inbox` 讀到時,
  poll 路徑自己會 grant(`messages.ts:113-117`),語意一致。

### 2.4 peer-agent 端:合成通知 + cursor 推進 + 積壓記憶

- 收到 `backlog` → `InboundDispatcher` 之外的一條短路徑(它不是 envelope,不過 gate/dedupe):
  1. 產生**一則**合成 notification(claude-channel)/ 一則 agent-call envelope(courier),內容即
     §2.2 的 data 人話化,含 `resume_hint`。
  2. 收到 `backlog` 時**先**持久化 `pendingBacklog`(下一點),cursor 不動;收到 `backlog_end` 才
     `cursorSink(newest)`(§2.2 事件順序)。
  3. `pendingBacklog = {count, since, newest, at}` **持久化在 cursor-store 同一個檔**(`cursor-store.ts`
     `persistPath` 新增一鍵;sol R5)。**多批合併**:再收到一個 `backlog` 時 `since = min(舊, 新)`、
     `newest = 新`、`count = 舊 + 新`。presence `summary` 尾綴 `backlog:N`。**清除規則**:一次
     `poll_inbox` 呼叫的 `since ≤ pendingBacklog.since` 且回應 `next_cursor ≥ newest` 才清;其他 poll
     不動它(不用 `pending_after` 更新 count——它是另一口徑)。
- **⭐ cursor 推進(採用)vs 停住(否決)**:停住 = 每次重連再報同一批,而「不重報」又要多記一個
  狀態;推進 + 持久化的 pendingBacklog + presence 可見已覆蓋「忘了拉」,且不重複灌。
- 門檻:`inbox.replay_threshold`(`config.ts` `inbox` 物件新增鍵),整數,預設 **10**,`0` = 停用
  (不送 `replay_max`,行為與今日相同)。上限 1000(等於 relay 一頁)。
- courier(`final_mile.kind = agent-call`)同樣適用,但 final mile 的 API 只吃 `Envelope`
  (`agent-call-ingress.ts:15,39`、`switchboard.ts:189,277`;sol R10):peer-agent **本機合成一個
  Envelope** —— `id` 本機鑄造(ULID,前綴 `msg_`)、`from`/`to` = 自身 handle、`kind: chat`、
  `meta: {synthetic: "backlog", reply: "none"}`、content = 摘要人話。它不進 spool、不進 relay;
  `reply_to_peer` 對它會被 relay 以 unknown `in_reply_to` 拒絕(400),這是預期且寫進文案。
  switchboard:有 `target` 就只送 `target`,否則送全部 extension(R-d 收口)。

### 2.5 poll-only harness:`poll_inbox` 回應帶總量

`GET /v1/messages` 回應加 `pending_after: <int>` + `pending_capped: <bool>`(next_cursor 之後、poll
口徑、上限 10 000;`store.ts` 新增一個 count 查詢)。peer-agent `poll_inbox` 頁首印「本頁 M 則,之後
尚有 K 則」。**`inbox.spool` 合併要跟著改**(gen-2 sol R6):`mergeInboxPage`(`inbox-spool.ts:84-108`)
目前只回 `messages/next_cursor/from_spool`,且截斷聯集時會把 relay 的 `next_cursor` 拉回——改為透傳
`pending_after`/`pending_capped`,截斷時 `pending_after += 被截掉的筆數`(T18)。ChatGPT 這類 harness
沒有 SSE,這是它的等價管家。舊 client 忽略新欄位。

### 2.6 不在 v1 但預留

- stream 與 poll 可投遞口徑統一;relay 端 `replay_max_age`(年齡截止)。

## 3. 實作切分(每步可獨立 merge、獨立回滾)

| # | 內容 | 檔案 | 驗收 |
|---|---|---|---|
| P1 | shared:`BacklogEvent` 型別 + SSE event 名常數 | `packages/shared/src/` | type test |
| P2 | relay:`replay_max` 解析(缺席=舊行為;非法 400)、單次掃描 P(cap 10 000)、`backlog` / `backlog_end` 事件、非 chat 逐封、`id ≤ H` live 丟棄、略過列不 mark/不 grant | `routes/stream.ts` | 見 §4 T1–T6、T13–T16 |
| P3 | relay:`GET /v1/messages` 回 `pending_after` + `pending_capped` | `routes/messages.ts`、`messages/store.ts` | T7 |
| P4 | peer-agent:config 鍵、`stream.ts` 送 `replay_max` + parse `backlog`/`backlog_end`、合成通知 / 合成 Envelope、cursor 於 `backlog_end` 推進、`pendingBacklog` 持久化/合併/清除與 presence 尾綴、`poll_inbox` 頁首 + spool 合併透傳 | `config.ts` `stream.ts` `index.ts` `tools.ts` `cursor-store.ts` `inbox-spool.ts` `agent-call-ingress.ts` `switchboard.ts` | T8–T12、T17–T19 |
| P5 | docs:`architecture.md` §4 補「replay butler」段;hangar runbook `hangar-bridge-fleet-deployment.md` 加 rollout 順序;`docs/BACKLOG.md` 收掉對應列 | docs | lint |

## 4. 驗收測試(RED → GREEN,全部 vitest,無 live 依賴)

- T1 `replay_max` 缺席:N=50 積壓 → 50 個 `message` event,無 `backlog`(回歸現行)。
- T2 `replay_max=10`、積壓 7 → 7 個 `message`,無 `backlog`。
- T3 `replay_max=10`、積壓 11 → **恰一個** `backlog`(`pending=11`、`oldest`/`newest` 正確、
  `by_sender` 正確),**零** `message` event;略過的 11 列 `delivered_at IS NULL` 且無 grant row。
- T4 T3 之後新到一則 live 訊息 → 正常以 `message` 送達(游標已在 live edge)。
- T5 cold start(無 since)+ 歷史 `@team` 20 列**其中 8 列已被他人 stamp** + `replay_max=10` → 一個 `backlog`,`pending=12`、`by_sender["@team"]=12`、`resume_since=""`。
- T6 母體一致:同一組列、同一連線參數下,`backlog.pending + replayed_exempt` === 無 `replay_max` 時該連線會送出的 `message` 事件數。
- T7 `pending_after`:since 之後 30 筆可投遞、limit 10 → `messages.length=10`、`pending_after=20`。
- T8 peer-agent parser:`backlog` event → 一次 `emitBacklog`,不進 `InboundDispatcher.handle`。
- T9 合成通知內容含 `pending`、`oldest`、`resume_hint`;claude-channel 走 `server.notification` 恰一次。
- T10 cursor:收到 `backlog{newest}` 後 `cursorStore.get() === newest` 且已持久化。
- T11 `replay_threshold=0` → 請求 URL **無** `replay_max`。
- T12 `pendingBacklog`:presence summary 尾綴出現 `backlog:N`;restart 後仍在(持久化);部分 poll
  (`next_cursor < newest`)只更新 count;`next_cursor ≥ newest` 才清除。
- T13 高水位:計數快照後、`backlog` 事件前插入一則 live chat(id ≤ H)→ 不以 `message` 事件出現;
  id > H 的 live chat 正常出現。
- T14 非 chat 逐封:積壓 20 chat + 1 task_dispatch + 1 permission_verdict、`replay_max=10` → 事件序恰為
  `backlog`(`pending=20`、`replayed_exempt=2`)→ 2 個 `message` → `backlog_end{newest=H}`。
- T14b 中途斷線:在 `backlog_end` 前斷開 → peer-agent cursor = 最後一封豁免列 id(未到 H);重連後
  豁免列不重送、chat 再被摘要一次。
- T15 `replay_max` 非法值(`abc`、`0`、`1001`)→ 400 `invalid_replay_max`。
- T16 `pending_capped`:10 001 列 → `pending=10000, pending_capped=true, newest=第 10000 列`;恰 10 000 列 → `false`。
- T17 courier 合成 Envelope:agent-call final mile 收到恰一封、`meta.synthetic=backlog`、`reply=none`;
  switchboard 有 `target` 時只送該 extension;內容含「這不是一封訊息、不可回覆」字樣。
- T18 spool 合併:relay 頁 `pending_after=5` + spool 多 3 筆致截斷 2 筆 → 回 `pending_after=7`、
  `pending_capped` 透傳、`next_cursor` 為截斷後最後一筆。
- T19 `by_sender` 上限:21 個寄件者 → 20 鍵 + `"…"` 合計正確;`resume_since` 等於連線時的 `since`。
- T20 多批合併與清除:兩次 `backlog`(since A<B)→ `pendingBacklog.since=A`、count 相加;
  `poll_inbox since=A` 回 `next_cursor ≥ newest` 才清;`since=B` 不清。

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

## 6. 殘餘風險(gen-1/2 未收口者)

- R-c:摘要被當「訊息」回覆——claude-channel 路徑無 msg id;courier 合成 Envelope `meta.reply=none`,
  relay 對其 `in_reply_to` 回 400;`meta.reply` 擋不住無 thread 的自由回覆,靠文案(T17)。接受。
- R-e:`replay_threshold` 預設 10 無數據;上線一週後用 `backlog` 事件的 `pending` 分佈校準。
- R-a/R-b/R-d 已於 §2.1、§2.2、§2.4 收口。

## 7. Review record(hetero plan loop,2026-09-15)

| gen | plan sha | verdict | seats | blockers | receipt |
|---|---|---|---|---|---|
| 1 | `91fd8ad8…`(r1,`abd9687`) | CONDITIONAL | sol STOP / MiniMax COND / glm COND | 5 accepted → r2 | `check-phase-review-receipt` exit 0 |
| 2 | `796fb1ff…`(r2,`HEAD~`) | CONDITIONAL, terminal(generation cap) | sol STOP / MiniMax COND / glm COND | 6 accepted → r3(depth-0 adjudication) | exit 0 |

Artifacts beside this file: `.g{1,2}-artifact.json`(controller output)、`.g{1,2}-disposition.json`
(depth-0)、`.rubric.md`、`.plan-review-manifest.json`。r3 是 gen-2 之後的 depth-0 裁決版,
未再送審(loop 上限);gen-2 六個 blocker 的 fold 位置見 g2 dispositions 的 rationale。
