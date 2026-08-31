# Plan — `to_filter` 定址:精準打單一 session + 跨機屬性群組(SSE,非 NATS)

status: APPROVED (Fable loop r1-r3 收斂,2026-08-31);可動工
owner: cookys
scope: `packages/shared`(envelope/outbound schema)、`packages/relay`(fanout + presence + publish route)、`packages/peer-agent`(send_to_peer tool + CLI)、docs

## 0. 任務目標

在**既有 SSE relay** 上,讓 sender 能:

1. **只送給某一個特定 session**(例:cuda 上 `revival.3d` 那個視窗,不吵到 cuda 其他 session)。
2. **送給某屬性群組**(例:所有 `repo=llm-playground` 的 agent —— **跨 handle、跨機器**)。

硬條件:**不引入 NATS**(owner 明示「too heavy」)。`to_instance` 正向定址原本在 `fanout.ts` P4'b 註解被刻意留給 NATS,本 plan 在 SSE 上補上,並把該註解從「留給 NATS」改寫為「instance 僅在既授權 audience 內收窄,仍非授權依據」。

## 1. 非目標(明確不做)

- 不做持久群組訂閱 / 補送給「之後才上線」的符合者 —— 那是既有 subject/interest ACL 系統的職責。
- 不做 `cwd` / `branch` filter(v1 只開 `instance` + `repo`,理由見 §2.3)。
- 不做「session 級保密」——真正的信任邊界在 handle(同 handle 共用 bearer)。要 session 隔離請各自獨立 handle+secret。
- 不改 NATS 任何東西。

## 2. 設計決策

### 2.1 形狀:`to` 錨點 + 可選 `to_filter` 收窄(兩層,非單一 selector)

```
to: "<handle>" | "@team"                          // 不變:ACL 錨點、fanout map key、store 欄
to_filter?: { instance?: string, repo?: string }  // v1 只開這兩鍵;envelope 一級 nullable 欄
```

- `to_filter` 對 `to` 的 audience **單調收窄**(filtered ⊆ 原 audience)—— 這是安全論證的核心不變量:**永遠不擴權**。
- 交付規則:在 `to` 的對象裡,只送給「**所有** `to_filter` 欄位都吻合當下 presence」的**在線** session。
- 兩層優於單一 selector 物件:`to` 已是全系統的錨(`to_handle` 存欄、fanout key、subject 的 recipient-ownership 檢查);把 instance/repo 揉進單一 selector 會逼每個既有 consumer 改。
- 不採用 `to:"handle#instance"` 地址文法:只解需求 1、解不了需求 2,且把短命 id 混進地址文法。

### 2.2 存放位置:envelope 一級 nullable 欄,**絕不放 meta**

比照 `subject`。meta 是 sender 可寫的軟區(publish 只 strip 保留鍵);`to_filter` 是 routing-load-bearing,必須與 subject 同級待遇。

### 2.3 v1 只開 `instance` + `repo`

- `cwd`:host-specific 絕對路徑,跨機 `@team+cwd` 幾乎恆 false,footgun。
- `branch`:session 中途會 checkout 變動 + presence heartbeat 有延遲,mis-target 機率高。
- schema 保留擴充空間(union/optional),但 v1 這兩鍵以外一律 400。

### 2.4 ⭐ 語意:online-only + **依 kind 決定落不落盤(條件式 v1b,Fable r1 修正)**

owner 選定 online-only(對現在在線的這群人喊話,對不到就不送)。**但「directed 一律不落盤」會撞死 reply 鏈**:`store.insert` 對任何帶 `in_reply_to` 的訊息都查 `message` 表,查不到 throw → messages.ts 轉 400 `unknown in_reply_to`(store.ts:26-29 → messages.ts:156-158)。directed 若不存,則**任何人回覆一則 directed 訊息就吃 400** —— 直接打中需求 1 主場景(`task_dispatch{instance}` 送達後 receiver 依 MCP 約定 reply)。

故按 **kind 分流(規則以 kind 為準,不看 `to` 是 handle 或 @team —— Fable r2 B1)**:

- **`to_filter != null && kind === 'chat'` → v1b(一律不落盤,含 `@team+repo` chat)**:
  - ⚠ B1:`@team+repo` chat 是需求 2 本體,**絕不可 fall through 到既有 store 路徑** —— 一旦落盤,`fetchInboxSince` 的 `to_handle='@team'` predicate(store.ts:103)無 to_filter 過濾 → 全 team 任何 handle poll 都撈得到,隔離破功。分流條件寫成 `kind==='chat' && to_filter!=null` 即涵蓋 handle-directed 與 @team-repo 兩者。
  - 理由(隔離):`fetchInboxSince` 是純 cursor(`id > since`)、不看 `delivered_at`、且無 message-row retention purge → 進了 `message` 表就能被同 handle 任何 session 從 `since=''` poll 出來。不存 = pull 也偷看不到。
  - 理由(一致性):online-only 的直覺就是送完就沒;不必處理 zombie row / drain 比對。
  - reply 契約:directed chat 的 receiver **不可帶 `in_reply_to`**(會 400),改用 `meta.correlation_id` 串話。notification meta 標 `ephemeral: "1"` 讓 receiver 知道。
  - 代價:無 durable 稽核 → 獨立 `audit_log` 補一筆 routing 事件(不含 content 或截斷);target 當下離線 → 遺失,靠 `matched:0`+命中清單回報。
- **`task_dispatch{instance}` → 落盤,但只在 `matched > 0` 才 insert(縮版 v1a;Fable r2 B2)**:
  - cardinality 天然 ≤1(instance 精確),peek 暴露面極小(單一 receiver + sender 同信任域),且**天然拿到 durable 稽核 + reply/`task_result` 鏈可用**(不撞 store.ts:26-29)。
  - ⚠ B2:**`matched=0` 絕不可留 pending row** —— delivered_at NULL 的 row 會進 cold-start `fetchPendingSince` drain(stream.ts:112-114),目標之後重連補送 → sender 已被告知「未送達、重打」→ 重發後舊 row 又送達 = **同一 task 雙重執行**(新 msg id,task-dedup 擋不住)。做法:`buildEnvelope` 先建 → fanout 計數 → **`matched>0` 才 `insert`**;`matched=0` 完全不落盤、回報 sender。
  - 需 `to_filter_json` 欄 + migration + `envelopeToRow/FromRow` + store 三條 SELECT(store.ts:62,79,99)加欄。
- 交付端(fanout gate)對兩者一致:只送當下吻合的在線 session;差別僅在「落不落盤」。

**此條件式分流是 Fable r1 的核心修正**;請 r2 確認它同時解掉 reply-400 又保住 chat 的隔離。

### 2.5 與 subject 互斥(硬規則)

`subject != null && to_filter != null` → **400**。判準:「收件集合由『負責什麼』定義 → subject(durable/ACL/可補送);由『現在正在做什麼』定義 → to_filter(ephemeral/presence/online-only)」。互斥避免兩套交付契約(subject 的 id-cursor 重送 vs to_filter 的 online-only)互相污染。

### 2.6 kind 限制(比照 subjected @team,收更緊)

- `task_dispatch + to_filter{instance} + 具體 handle` → **准**(需求 1 本體,cardinality 天然 ≤1,ack/correlation 不變)。
- `task_dispatch + to_filter{repo}`(或任何非純 instance)→ **400**(repo 吻合數可 >1 → 一令多收、N 個 task_result 撞同一 correlation_id;比照 R1「commands must be per-owner direct gated DMs」)。
- `to === '@team' && to_filter != null` → **只准 `kind:'chat'`**(鏡射現行 subjected-@team 規則)。

### 2.7 instance 正向定址的信任模型

- 安全:bearer 認證的是 handle;同 handle 各 process 互信(P4'a)。在「同一 bearer 的 session 集合內」挑一個,不產生新授權面 —— 偽造 instance 的前提是先持有該 handle 的 bearer,而那本來就能收整個 handle。
- 注意:(a) instance 無唯一性保證,同 handle 出現重複 live instance → relay log warning;(b) 短命性一級公民,只能 list_peers 現拿現用,絕不寫進任何持久設定;(c) `e.from===e.to` 且 filter 指到自己 instance → 被 self-exclusion 吃掉,回應要明說「你指到自己」而非沿用靜默 delivered。

## 3. 交付語意細節

- **relay 端過濾,非 client 端**:過濾在 relay 層,**不吻合者的 SSE 連線收不到任何 event**(不喚醒、不注入)。不是「送給大家各自濾」。
- **比對位置改在 stream.ts 的 `deliverable` gate,查 presence registry(Fable r1 修正,取代「repo 塞 Subscriber」)**:presence route(presence.ts:40 `deps.presence.set`)到 fanout Subscriber(stream.ts:87-96 closure)**沒有現成通路**;把 repo 複製進 Subscriber 會產生第二份狀態、與 registry 漂移。改法:`deliverable` closure 已握有本連線的 `instance`(stream.ts:131 `effectiveLabel`)與 `deps.presence` —— envelope 帶 `to_filter` 時,`instance` 條件比 closure 的 instance,`repo` 條件**交付當下查 `deps.presence` 自己那列**(registry 是 repo 的單一 SoT)。好處:(1) Fanout/Subscriber 介面幾乎不動;(2) heartbeat 更新即時生效,mid-life repo 過期縫消失,只剩「SSE 已 subscribe、首個 presence POST 未到」的啟動窗(fail-closed miss,可接受、文件化);(3) legacy client(無 instance)比不中 → fail-closed 排除。
- **matched 計數**:需把 `deliverDetailed` 統一回傳實際交付 **count**(現在 @team 分支 delegate 回 boolean `deliver`,fanout.ts:69/90 兩 method 關係要重整成單一計數路徑)。回應帶 `matched: n` + **命中清單 `[{handle, instance}]`**(§6 Q2)。`matched:0` → peer-agent 工具面明確回「無 session 吻合、未送達,請 list_peers 拿新 instance」。

## 4. 實施階段

### P0 — shared schema
- `EnvelopeSchema` / `OutboundMessageSchema` 加 `to_filter`(nullable、`.default(null)`;union:`{instance?:string, repo?:string}`,兩鍵各有 regex/長度上限;空物件或未知鍵 → reject)。**superRefine 互斥檢查兩個 schema 都要寫**,nullish guard 照抄現有 B2 寫法(envelope.ts:104-123)避免 omitted-filter 誤觸。
- **完整 kind × to_filter 白名單**(Fable r1):**只准** `chat` 與 `task_dispatch{instance}`;`task_dispatch` 帶非純 instance(含 repo)、`permission_request`/`permission_verdict`/`task_result`/`presence_update` + to_filter → 一律 **400**(比照 messages.ts:127-129 subject-kind gate,避免 permission 流被 filter 走偏成新攻擊面)。
- §2.5 subject×to_filter 互斥 → 400。`@team + to_filter` → 只准 chat。
- **`ephemeral` 進 `RESERVED_META_KEYS`(constants.ts:46,現只有 subject/kind;Fable r2 B3)**:relay 拿 `meta.ephemeral:"1"` 當 directed chat 的 reply 契約訊號,sender 不可自帶偽造到落盤訊息 → 比照現有 reserved-meta 在 chokepoint strip。
- `to_filter_json` 欄 + migration:directed `task_dispatch` 落盤需要(見 §2.4);`envelopeToRow`/`envelopeFromRow`(envelope.ts:153-162 顯式欄位)+ store 三條 SELECT(store.ts:62,79,99)明列新欄。`.default(null)` 讓舊 row 自動 null,安全。
- `OutboundMessageSchema.strict()` → 舊 relay 收帶 to_filter 的 POST 會 400;**部署順序 relay 先、peer 後**,peer-agent 對 400 辨識降級。

### P1 — relay:envelope 建構重構 + fanout 計數 + publish 分流
- **抽 `store.buildEnvelope()`**:把 recipient 存在驗證 + id/thread 建構(store.ts:17-47)從 `insert` 抽出,directed chat(不落盤)也要能建 envelope + 驗 recipient(否則跳過 insert 就同時跳過驗證)。
- **fanout 計數重整**:`deliver`/`deliverDetailed` 的 @team 互相 delegate(fanout.ts:69/90)改成單一 count 路徑,讓 `@team+to_filter{repo}` 也能回 matched 數。
- **`deliverable` gate 加 to_filter 比對**(stream.ts):instance 比 closure instance;repo 交付當下查 `deps.presence`(§3)。實作註記(Fable r2 A2):`presenceLabel`(`effectiveLabel(tokenLabel,instance)`,label.ts:16-18)目前 stream.ts:131 才算,gate 在 :60,需 **hoist 到 gate 之前**;`PresenceRegistry` 無「取單一 session by label」API(`get()` 回整個 snapshot),需加 per-label getter。
- **legacy delivered-tracking 不動判定來源(Fable r2 B4)**:messages.ts:174-180 既有 null-subject delivered 判定用 `isOnline`/`onlineHandles`,**維持不變**(self-excluded-only:count=0 但仍須 stamp delivered,attribution.test.ts:261-283 會抓)。新的 `matched>0→delivered` 規則**只套用 to_filter 路徑**,不改 legacy 路徑。
- **publish route(messages.ts)分流**:
  - directed `chat` → **不 store**,`buildEnvelope` + fanout,回 matched+命中清單,寫 `audit_log`;**跳過 messages.ts:161-181 的 delivered-tracking 整段**(含 self-excluded 的 delivered 判定,注意 messages.ts:166-172 註解 + attribution.test.ts)。
  - directed `task_dispatch{instance}` → **`buildEnvelope` 先建 → fanout 計數 → `matched>0` 才 `insert`(insert 即帶 `delivered_at=now`)**;`matched=0` **完全不落盤**(不留 pending zombie row,見 §2.4 B2)、回報 sender。交付走 to_filter gate。
  - **self-target**:`to_filter.instance === meta.sender_instance && from===to` → 在 fanout 前判,回應明說「你指到自己」(§2.7c)。
  - **directed chat 的 notification meta 標 `ephemeral:"1"`**(channel.ts 不動 to_filter,但補 ephemeral 標記配合 reply 契約)。
- delivered_at:to_filter 路徑一律 **`matched>0 → delivered_at=now`**;`matched=0` → 該 kind 都無 row(chat 本就不落盤、dispatch 不 insert),故無 delivered_at NULL 的殭屍 row。directed chat 無 row 不 markDelivered。
- instance 重複(同 handle 兩 process 同 id):log warning、兩個都送,不 reject(§6 Q4)。

### P2 — peer-agent + CLI + outbound 回傳
- **`outbound.ts send()` 回傳 shape**:現在回 `Promise<Envelope>`,要改成帶 `matched` + 命中清單;`tools.ts`(~365/478 用法)連動。**`matched`/命中清單設為 optional(Fable r2 B5)** —— `PeerTransport.send`(outbound.ts:41)是共用 interface,NATS 實作(nats-transport.ts)**不動**(合「不改 NATS」),optional 欄位讓 NATS 回傳保持原樣。
- `send_to_peer` MCP tool 加 `to_filter` 參數;回應把 matched/命中清單/matched:0 講給 agent 聽。
- CLI `send` 加 `--instance <id>` / `--repo <name>`;`matched:0` 明確報錯。
- `~/bin/hb-send` wrapper 順帶支援(non-blocking)。

### P3 — 測試(成對正反,擋 dead-gate 假綠)
- **每條 filter 路徑同一 fixture 成對斷言**:「吻合者收到」+「不吻合者**零 event**」必須同時斷言(單測 negative 會讓 dead gate 假綠 —— 今天已踩過三次同類 bug)。
- shared:schema 接受/拒絕矩陣(subject×filter 互斥、完整 kind 白名單、未知鍵、空 filter、nullish guard)。
- relay fanout:instance 精確命中/未命中、`@team+repo` 跨 handle matched 計數、self-target、legacy-no-instance fail-closed 排除、presence 啟動窗(SSE 已 subscribe、presence 未 POST → repo fail-closed miss)顯式測。
- relay publish:directed chat **不進 store**(poll_inbox `since=''` 撈不到)、audit_log 有痕;directed `task_dispatch{instance}` **有 row + reply 鏈可用**;**reply-to-directed**(receiver 對 directed 回 in_reply_to:chat 該走 correlation_id、dispatch 該成功)必測;directed publish 的 idempotent replay(matched 回首次值)。
- 迴歸:既有 handle/@team/subject 交付不變。**`fanout-self.test.ts:66/101/103-104` 用 `toEqual` pin 死 `deliverDetailed` 回傳 `{delivered,selfExcluded}`;加 count 欄位這些斷言要一併更新(預期內)。attribution.test.ts:261-283 self-excluded-only stamp-delivered 必須維持綠(驗 B4:legacy 判定沒被改)。**

### P4 — 文件
- to_filter 語意、online-only、**降噪非保密**(明說同 handle poll_inbox 邊界)、subject vs to_filter 界線表、directed chat 的 `ephemeral`+correlation_id reply 契約、presence 啟動窗已知限制。
- `fanout.ts` P4'b 註解改寫:instance 僅在既授權 audience 內收窄,仍非授權依據(§2.7)。

### P5 — 部署(一次)
- 新 candidate → hosted CI(hangar-bridge CI workflow 目前 disabled;以本機全套件 + typecheck + build 為 admission 證據)。
- relay 先升(install-relay 重啟一次);peer 逐台升。fresh-nonce 驗收見 §5。

## 5. 驗收(fresh nonce,relay 端過濾證明)

| 檢查 | 要件 |
|---|---|
| 單 session 命中 | `to_filter{instance}` → 只該 session 收到;同 handle 其他 session **SSE 零 event** |
| repo 群組 | `@team + to_filter{repo}` → 所有該 repo session 收到、跨機;非該 repo 者零收到 |
| directed chat 不留痕 | 送完後別的 session poll_inbox(`since=''`)**撈不到** directed chat(含 `@team+repo` chat —— 全 team 任何 handle poll 都撈不到) |
| dispatch 落盤但無殭屍 | `task_dispatch{instance}` matched>0 有 row + reply 鏈可用;**matched=0 無 row**(poll 撈不到、不會補送、不會雙重執行) |
| matched:0 | filter 零吻合 → 回 `matched:0`,sender 收到明確未送達 |
| ACL | `task_dispatch+to_filter{repo}` → 400;`@team+to_filter` 非 chat → 400;`subject+to_filter` → 400 |
| 迴歸 | handle / @team / subject 既有行為不變 |

## 6. 關鍵決策(Fable r1 已裁,落檔)

1. **落盤策略** → **條件式 v1b**:directed `chat` 不落盤(隔離);directed `task_dispatch{instance}` 落盤(reply/task_result 鏈 + 稽核)。解掉 reply-to-directed 400。詳 §2.4。
2. **部分命中回報** → 回 `matched: n` **+ 命中清單 `[{handle, instance}]`**(instance 本經 list_peers 全 team 可見,無新洩漏;repo 群組漏誰要能看見才好補送)。
3. **presence 啟動窗 miss** → **可接受、不強制 subscribe 前先收 presence**(會把 connect+presence 耦合成兩段握手,失敗模式更多)。採 §3 delivery-time 查 registry 後只剩啟動窗;`matched:0`+命中清單已給回饋。文件化。
4. **instance 重複** → log warning、**兩個都送**,不 reject 不 dedup(同 bearer 互信,relay 無權裁決誰真;reject 會因 heartbeat 時序 flap)。
5. **v1 定址軸** → `instance`+`repo` 足夠;`worktree` 已在 presence(registry.ts:21),為最可能第三軸,schema 註解留名、v1 不開。

## 7. r2 待確認

- 條件式 v1b 是否同時解掉 reply-400 又保住 chat 隔離?directed task_dispatch 落盤的 peek 暴露面(單 receiver)可接受?
- `store.buildEnvelope` 抽取 + directed chat 走它建 envelope,有沒有漏掉 insert 才做的副作用(idempotency 記錄、attribution stamping 在 messages.ts 而非 store,應無)?
- fanout `deliver`/`deliverDetailed` 計數重整會不會動到既有 @team / self-exclusion 測試語意?
