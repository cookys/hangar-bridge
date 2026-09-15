# Plan — Relay groups:同一個 hub 上多個互不可見的圈子,訊息安全由 relay 逐則裁決

status: DRAFT r2 — gen-1 22/22 + gen-2 10/10 折入;待 gen-3 確認
owner: cookys
branch: `feat/relay-groups`(base `develop`)
scope: `packages/shared`(envelope / constants)、`packages/relay`(schema v10、peers-file、acl、每條 route、fanout、presence、claims、purge、SIGHUP reload)、`packages/peer-agent`(config、tools、channel tag)、dotfiles `bin/fleet`(送件 / peers 顯示)、hangar docs(ADR + runbook + tower)
origin: hangar session 2026-09-16 —「放同事進來大家就摻在一起做撒尿牛丸」;relay 現況 = 有認證、無隔離(`schema.sql:3` D10 single-tenant;live roster 10 個 handle `subjects` 全 null)

## 0. 任務目標

hangar-bridge relay 今天是**一個 roster、一個廣播池、一張訊息表、一個 presence 名單、一個 claim 空間**。
第三方(同事)的 handle 一旦進 `peers.json`,他就:收得到所有 `@team` 廣播、`list_peers` 看得到每台機器的
cwd / repo / busy 狀態、能直送任何 handle(subject 為 null 的 chat 不過 ACL,`routes/messages.ts:310`)、
能 `task_dispatch` 任何機器、能拿走任何 claim key、第一次 stream 還會回放歷史 `@team`(itx-chatgpt 初次
poll 吃到 148 則)。現有 subject ACL 是**命名空間** ACL(`acl.ts`),不是人的分組,且 opt-in。

目標:引入 **group** 作為可見性與可達性的唯一單位。一個 handle 屬於 ≥1 個 group;**每一則訊息、每一個
presence 快照、每一個 claim、每一條 reply 路由都帶一個 relay 蓋章的 `group_id`**,relay 只把東西交給該
group 的成員。不同 group 的成員彼此**看不見、送不到、列不出、回放不到**。要讓兩個圈子互通,唯一方式是
把某個 handle 同時放進兩個 group(multi-membership),沒有「跨 group 橋接」這種第二套規則。

一句話驗收:**新建一個 `guest` handle 只放在 `guest-lab` group,它對 `fleet` group 的一切,行為上等同
於 relay 上根本沒有 `fleet` 這個東西**(不是 403,是「不存在」)。

## 1. 非目標(明確不做)

- 不做 group 的動態自助 API(建 group / 加成員 / 退出)。membership 唯一來源仍是 relay operator 手上的
  `peers.json` + SIGHUP,維持「no dynamic registration」不變量(`architecture.md` §5.1)。
- 不做跨 group 的 bridge / forward / 轉發規則。需要互通 = multi-membership。
- 不做 group 內的角色階層(owner / admin)。v1 只有「成員」加上每個成員的能力集(§2.1.6 caps)。
- 不動 NATS lane(`fleet-roster.json` / NKey 主題權限)。**不變量:非 `fleet` group 的成員永不核發 NKey、永不進
  `fleet-roster.json`**(NATS lane 是獨立 transport、不經 relay message 表,任何拿到 NKey 的人都繞過 group);
  hangar 的「加同事」runbook 只發 relay secret。NATS 主題分 group 是另一份 plan,`docs/BACKLOG.md` 留列,
  trigger =「第一個需要 NATS lane 的非 fleet 成員出現」。
- 不做 message 內容加密(relay 仍是 trust anchor,§6 residual trust 不變)。
- 不改 `subject` 命名空間 ACL 的語意;它繼續在 group 過濾**之後**再收窄(兩層 AND)。
- 不做 per-group retention;沿用 `team.retention_days`。

## 2. OKR / KRs

- **O**:同一個 hub 可以安全地容納不屬於 cookys 的成員。
- KR1:P3 live 驗收 8 條全 PASS —— 一個只在 `guest-lab` 的 handle,對 `fleet` 的 messages / peers / stream / claims / replies 全部得到「不存在」等價回應。
- KR2:legacy `peers.json`(無 `groups` 段)下,既有 relay 測試套件零改動全綠(行為與回應 body 逐位元相同,含錯誤碼)。
- KR3:P1-7 對抗 harness 覆蓋 §4 P1-7 列出的全部 15 個 relay 端點 × {成員, 非成員} × {有 cap, 無 cap},零 diff;每條「不存在」路徑的回應與真不存在 byte-equal。
- KR4:SIGHUP 縮小 membership 後,受影響 stream 在 ≤ 1 heartbeat 內收到 `reauth` 並關閉(整合測試量測)。

## 2.1 設計決策

### 2.1.1 ⭐ group 是 overlay,不是 tenant

三個候選:

- **A. 每個圈子一個 relay 行程**(零 code)—— 完全隔離但無法互通,cookys 要跨圈就得掛兩個 peer-agent,
  `fleet` CLI 也要學會多 relay。當「暫時給同事用一下」的 workaround 可以,不是設計。
- **B. `team_id` 從常數變成 token 綁定**(真 multi-tenant)—— schema 的 `UNIQUE(team_id, handle)` 會強迫
  一個 handle 只能在一個 team;cookys 的 `cuda` 要同時在自家 fleet 和某個共同專案 group 就得開第二把
  secret、第二個 handle。跟 §0「multi-membership 是唯一互通方式」衝突。
- **C(採用)group overlay**:`team_id` 維持 `'hangar'`(它代表「這個 relay 安裝」),新增 `group` /
  `group_member` 兩張表,handle ↔ group 多對多。所有既有 row 回填到一個 `fleet` group,行為 100% 等同
  今天;隔離只在第二個 group 出現時才「長出來」。

### 2.1.2 ⭐ 每則訊息一個 group,relay 蓋章,sender 不能選它不屬於的

- POST `/v1/messages` 接受選填 `group`(regex 同 `HANDLE_REGEX`)。缺省 = sender 的 `default_group`
  (peers.json 每個 peer 必填,且必須是它的 membership 之一,否則 relay 啟動 fail)。
- **插入點(必須在所有會回應的既有步驟之前)**:group 解析 → membership → cap → 收件人成員判定,緊接在
  B1 meta 剝除(`messages.ts:175-181`)與 `x-hangar-instance` 解析之後、**`thread_root` 續串(`:250`)之前**;
  addressRules 區塊(`:269-300`,prod 為 on)與 subject ACL(`:310`)全部在其後。理由:`thread_root` 續串與
  addressRules 的 refusal(`handle_needs_all_sessions` 會帶 `live_instances`)都是在 group 判定前就回應的洩漏點。
- relay 驗:`group ∈ memberships(sender)` 否則 **404 `unknown_group`**(對非成員而言 group 不存在,避免枚舉)。
- 直送(`to` = handle):再驗 `to ∈ members(group)`。**嚴格模式**(peers.json 有 `groups` 段)→ **404
  `unknown_recipient`**,同一個碼與 body 同時涵蓋「handle 不存在」與「存在但不在這個 group」;**legacy 模式**
  維持現行 400 `invalid_message`(`store.ts:88` 的 `unknown recipient` Error 路徑)原 body,逐位元相同
  (KR2)。P1-7 harness 只在嚴格模式跑。
- **`in_reply_to` 父查詢**(`store.ts:92-97` `buildEnvelope`)加 `AND group_id=?`(= 本次解析的 group);找不到
  與「父不存在」同碼同 body(沿用 400 `invalid_message` `unknown in_reply_to`,legacy 逐位元相同)。這同時封掉
  跨 group 的存在性 oracle 與 `thread_root` 跨 group 綁定 —— `permission_verdict` / `task_result` 都走這條。
- **`thread_root` 續串**(`resolveThreadContinuation`,`:250-260`)要求 `route.group_id == 本次送件 group`,否則
  403 `not_in_thread`(與 route 不存在同碼、既有 body)。
- **`idempotency_key` 命中**(`:158-165`,key 只含 tokenId)早於一切判定 → 命中時先解析 body 的 group(缺省
  default_group),與 cached 回應中的 `group` 比對:不同 → 422 `idempotency_mismatch`;相同但 sender 已不在該
  group → 404 `unknown_group`。cached 回應的 `group` 欄位由本 plan 新增;**pre-v10 的 cached row 缺 `group` 視為
  `DEFAULT_GROUP_ID`**。**legacy 模式命中路徑維持現行「不解析 body 直接回 cached」**(逐位元),只有嚴格模式才比對。
- 廣播:`to` 從 `@team` 改為 `@group`(常數 `GROUP_BROADCAST_HANDLE`),語意 = 「這個 group 的所有成員」。
  `@team` 是 **wire 上的相容別名 = `@group` on `default_group`**;relay 在 chokepoint **正規化為 `@group` 後才
  build / persist**(`message.to_handle`、`reply_route.to_handle` 一律存 `@group`),audit `deprecated_team_alias`,
  一個 minor 版後移除(BACKLOG 列)。所有讀取 SQL 用 `to_handle IN ('@team','@group')` 相容 migration 前的舊 row;
  shared 的 `AddressSchema` / `refineToFilter` / `durableReport` / `classifyLegacyWidth` 以單一 helper
  `isBroadcastHandle(to)` 取代字面比較。
- `fleet_wide: true` 在 `@group` 的語意 = 「該 group 的每一台」;`unqualified_broadcast` enforce 訊息文字以 group
  命名;兩者 audit 帶 `group_id`。
- `group_id` 是 `message` 表的 NOT NULL 欄位,和 `from_handle` 一樣 **relay 寫入、client 唯讀**;`meta` 裡若帶
  `group` 一律剝除(沿用 B1 剝除點)。

### 2.1.3 ⭐ 讀取側全部以「讀者的 membership」過濾,不是以「訊息的 to」

每一個把 message row / 計數 / 投遞決定交給 client 的地方,都在 SQL 層加 `AND group_id IN (<reader memberships>)`
(以及 §2.1.5 的 since 水位)。**窮舉清單**(P0 開工第一步以 `grep -n "prepare(" messages/store.ts` 與
`grep -rn "fetch\|SELECT" routes/ fanout.ts purge.ts` 重新核對,差異寫回本表):

| 讀取點 | 現況 | 改法 |
|---|---|---|
| `GET /v1/stream` cold start / resume(`stream.ts:165-167` → `store.fetchPendingSince` / `fetchSince`) | `to_handle IN (handle,'@team')` | 加 group + since 條件 |
| `GET /v1/messages` poll(`messages.ts:82-140` → `fetchInboxSince`) | cursor + owned-set | 同上 |
| `GET /v1/inbox`(`fetchMailboxSince`,`@mailbox:<handle>`) | to_handle 精確比對 | mailbox 列帶 group_id;仍以 membership 過濾 |
| replay butler `fetchInboxIdsAfter`(`store.ts:222`)→ `pending` / `by_sender` | 同 poll | 同上;只數看得到的 |
| `buildEnvelope` 的 `in_reply_to` 父查詢(`store.ts:92-97`) | `id=? AND team_id=?` | 加 `AND group_id=?`(§2.1.2) |
| `resolveThreadContinuation`(`messages.ts:250`)/ `getRoute` / `getLiveRoute` / `getRouteByCorrelation` | route by msg_id | 呼叫端加 `route.group_id` 檢查(§2.1.2、§2.1.4) |
| `replies.ts resolveParentRoute` → `checkAudience` | route 存在 → 403 `not_a_recipient` | route 查詢加 `AND group_id IN (replier memberships)`,**在 checkAudience 之前**回 null → 404 `unknown_parent` |
| `permission.ts:31-36` 的父訊息 SELECT | by id | 加 group_id 條件 |
| `grants.ts finalize` → `hasGrant` / `finalizeGrant` | by (msg_id, handle, instance) | grant 只在同 group 內發(§2.1.4),finalize 不另加條件 |
| `Fanout.deliver` 即時投遞(`fanout.ts`) | 依 to_handle 找連線,每個候選 sub 再過 `accept`(= deliverable,`fanout.ts:181`) | `@group` → `members(group)` ∩ 連線;直送 → 收件人已通過成員判定;**`presence_update` 例外**:group 判定在 Fanout 層做(受眾 = `SELECT DISTINCT handle FROM group_member WHERE group_id IN (sender memberships)` ∩ 連線),`deliverable` 對 `kind='presence_update'` **跳過** `e.group` 檢查 —— 否則 `accept` 會把聯集砍回單一 group |
| `delivered_at` 判定(`messages.ts:559-566`,`onlineHandles(team)`) | 任一非 sender 在線即 stamp | `@group`:`onlineHandles ∩ members(group) − {from}` 非空才 stamp;直送:`isOnline(to)` 已被成員判定涵蓋 |
| superseded stream 的 queue 重投(`stream-superseded`) | 沿用連線母體 | 走同一個 `deliverable`,自動受 group 條件 |
| `purge.ts` | 不回傳給 client | 不變;`group_member` 不 purge |

經 `/v1/messages` 持久化的 `presence_update` row 仍以 default_group 入庫,不追求 backlog 可見(心跳非 durable 契約,沿用 `presence.ts:57-63` 的理由)。

**membership 讀取時點 —— 單一規則:live 與 backlog 都以「每則現查」為準**(presence_update 除外,見上)。`deliverable(e)` 對 `e.group`
做一次 indexed lookup(`group_member(group_id, handle)` PK),經由 per-reload-epoch memo(reload 時整個清空)
避免每則打 DB;不再有「連線時讀一次的 membership 快取」。縮小靠 §2.1.7 的主動 drop(讓 since / caps 立即
生效),擴大靠現查(新成員在既有 stream 上**即刻**收得到新廣播)。owned-set(subject ACL)維持連線時讀一次的
既有行為不動。

### 2.1.4 presence / peers / claims / reply 路由 / permission 全部 group-scoped

- **`GET /v1/peers`**(`peers.ts:20`):**保留陣列形狀**(additive,舊 peer-agent 不會因形狀改變而 roster 為空
  → `SenderGate` 靜默拒絕所有 inbound);每個 entry 加 `groups: [{id, caps}]`,只列與讀者共享的 group;不共享任何
  group 的 handle **不出現**;session 明細(cwd / repo / branch / busy)只給共享 group 的讀者。分節顯示由
  peer-agent / `fleet` 在 client 端做。**既有 2 秒全域快取(`peers.ts:6,18-22,52`)不分讀者** → 快取 key 改為
  讀者 membership 集合(排序後的 group id 串);不同 membership 永不共用 body。
- **`POST /v1/presence`**(`presence.ts:36-71`)的 `presence_update` 心跳走 `fanout.deliver` 到 `@team`、**不經
  group** → 改為:受眾 = 與 sender 共享 ≥1 個 group 的 handle 的連線(`SELECT DISTINCT handle FROM group_member
  WHERE group_id IN (sender memberships)`);Envelope.group 記 sender 的 default_group,但 Fanout 以成員**聯集**
  投遞。同規則套用到 `POST /v1/messages` kind `presence_update`。presence 本身(registry)不分 group,
  `to_filter.repo` 比對(`stream.ts:106`)只在同 group 內成立。
- **claims**(`claims/store.ts`):PK 從 `(team_id, claim_key)` 改為 `(team_id, group_id, claim_key)`;
  `POST /v1/claim`、`POST /v1/claim/release`、`DELETE /v1/claim`(`claims.ts:21,56-71` 目前不接任何 group)都接選填
  `group`(缺省 default_group,非成員 → 404 `unknown_group`);`GET /v1/claims` 回讀者所有 group 的聯集、每列帶
  `group_id`;release 只能 release 該 group 內自己的。
- **reply routing**(`reply_route` / `reply_grant`,`replies.ts`、`grants.ts`):`reply_route` 加 `group_id`
  (= 父訊息的);`POST /v1/replies` 的 route 查詢加 `AND group_id IN (replier memberships)`,在 `checkAudience`
  之前就回 null → **404 `unknown_parent`**(沿用既有碼與 body,`replies.ts:382`);`writeRefusal` 寫入
  `reply_idem` 的 error row 亦同碼。grants 只發給該 group 成員。**跨 group 的 thread 由兩處 group 相等檢查
  保證不可能**:`in_reply_to`(§2.1.2)與 `thread_root` 續串(§2.1.2)。
- **permission**:`ask_team` 路由在 peer-agent `approval-routing.ts:23`,verdict 走 `POST /v1/messages` kind
  `permission_verdict`(`tools.ts:790-797`)→ group 閘門 = §2.1.2 的 `in_reply_to` group 檢查 + `permission`
  cap;`/v1/permission/respond` 的 SELECT(`permission.ts:31-36`)另加 group_id 條件。peer-agent 的
  `permission_relay.routing` 枚舉新增 `ask_group`,`ask_team` 保留為別名(同 §2.1.2 的 deprecation 節奏)。
- **`task_dispatch` / `task_result`**:直送規則已由 §2.1.2 涵蓋;另受 §2.1.6 `dispatch` cap。

### 2.1.5 ⭐ 歷史可見性:`history: since_join`(預設)

新成員加入 group 時**不應**回放他加入前的東西——這正是「同事第一次 stream 看到 148 則舊廣播」的病根,
也是同事最在意的「我看得到你們以前講什麼嗎」。

- `group_member` 表帶 `member_since`(ISO)與 `since_msg_id`:**由 `newMessageId()`(`shared/ulid.ts`,與 message id
  同一個 monotonic factory、同 `msg_` 前綴)產生**——存裸 ULID 會讓 `'msg_…' > '01J…'` 恆真而讓 since_join 靜默失效。
- 所有 §2.1.3 的讀取點加 `AND message.id > since_msg_id`(嚴格 `>`,只對該 group)。SIGHUP 路徑在 relay 行程內產生
  水位為準;`init` CLI 與 serve 是不同行程,init 產生的水位允許同毫秒邊界模糊(記入 ADR)。migration 寫 `'0'`
  (小於任何 `msg_`)。
- peers.json group 級 `history: "since_join" | "all"`,預設 `since_join`;`all` 給 cookys 自己的 `fleet`
  group 用(migration 時 `fleet` 寫 `all`,所有既有成員 `since_msg_id = '0'`,行為零改變)。
- 被移出再加回:`since_msg_id` 重設為重加當下 → 中間那段看不到。這是 by design,寫進 ADR。

### 2.1.6 每個成員的能力集(caps)

peers.json 的 membership 是 `{"handle": {"caps": [...]}}`,caps ⊆ `chat | broadcast | dispatch |
permission | claim`,**缺省 = 全部**(既有 fleet 成員零改變)。relay 在 POST `/v1/messages` /
`/v1/claim` / `/v1/permission/respond` 依 kind 查表:

| 動作 | 需要的 cap |
|---|---|
| chat 直送 | `chat` |
| `to: @group` | `broadcast` |
| `task_dispatch` / `task_result` | `dispatch` |
| `permission_request` / `permission_verdict` | `permission` |
| `POST /v1/claim`、`POST /v1/claim/release`、`DELETE /v1/claim` | `claim` |
| `POST /v1/replies`(回覆恆為 chat kind,不論父是 dispatch) | `chat` |
| `presence_update`(經 `/v1/presence` 或 `/v1/messages`) | 不需 cap(成員身分即可;受眾依 §2.1.4 成員聯集) |
| `POST /v1/grants/finalize` | 不需 cap(只能對已持有 grant 的 msg 操作) |

缺 cap → **403 `cap_denied`**(這裡用 403:成員身分已成立,拒絕的是動作,不是存在性)。audit event
`group.cap_denied {group, handle, cap}`。同事的典型設定:`caps: ["chat"]` —— 能講話、看得到彼此,
不能派工、不能廣播、不能搶 claim。

### 2.1.7 membership 變更 = SIGHUP,縮小要即時生效,消失的 handle 要真的撤

現行 `reloadRoster()`(`serve.ts:40`)是 additive;`seedPeers`(`peers-file.ts:57-97`)**從不停用或撤銷
peers.json 裡消失的 handle**(只在 secret 變更時 revoke 舊 token)。group 讓「撤」變成安全需求,所以:

- reload 後計算 **`DB human ∖ peers.json`**,對差集:`UPDATE human SET disabled_at=now`、`UPDATE token SET
  revoked_at=now`、`DELETE FROM group_member WHERE handle=?`、`fanout.dropHandle(team, handle, 'removed')`、
  audit `peer.removed`。嚴格模式必做;legacy 模式沿用舊行為(不撤),因為 guest 場景一定是嚴格模式。
- reload 後計算每個 handle 的 membership diff;**任何縮小**(移出 group、cap 減少、group 刪除、since 重設)→
  `fanout.dropHandle(team, handle, 'membership_changed')`。**機制放在 `Fanout`**(`presence/connections.ts` 的
  `ConnectionRegistry` 只是 refcount Map、不在 `Deps` 上;關流能力在 `fanout.ts` 的 subs):對
  `subs.get(team).get(handle)` 每個 sub 呼叫 `close(reason)`;`stream.ts` 的 close 回呼收到
  `reason='membership_changed'|'removed'` 時先 `writeSSE event: reauth` 再結束。peer-agent 收到 `reauth`
  走既有 reconnect(不計入 final-mile 失敗);`removed` 的重連得到 401。
- `reloadRoster` 簽名改為 `(deps, peersFile)`(或回傳 diff 由 `startServer` 呼叫 `fanout.dropHandle`),並清空
  §2.1.3 的 membership memo。
- 擴大(加成員、加 cap)不掉線;§2.1.3 每則現查讓新成員**即刻**收得到新廣播。
- `peers.json` 語法錯 → reload 拒絕、保留記憶體內舊 roster(既有行為),多印一行 `groups: unchanged`。

### 2.1.8 錯誤碼與資訊洩漏原則(整份 plan 的安全紅線)

| 情境 | 回應 | 理由 |
|---|---|---|
| 指定不屬於自己的 group | 404 `unknown_group` | 不承認 group 存在 |
| 直送非同 group 的 handle | 404 `unknown_recipient` | 與「handle 不存在」同碼,防 roster 枚舉 |
| 回覆自己不在其 group 的父訊息(`/v1/replies`) | 404 `unknown_parent`(既有碼與 body) | 與「msg 不存在」同碼同 body;`reply_idem` error row 亦同 |
| `in_reply_to` / `thread_root` 指到他 group 的 msg | 與「不存在」同碼同 body(400 `invalid_message` / 403 `not_in_thread`) | 存在性 oracle 封口 |
| addressRules 的 §6.1-6.3 refusal(`use_reply_verb` / `sender_instance_required` / `handle_needs_all_sessions` / `dispatch_needs_instance`) | 只在收件人已通過 group 成員判定後才回;`live_instances` 只列共享該 group 的 instance | 否則洩漏存在性 + 活躍度 |
| `presence_update` 心跳 | 只投遞給共享 group 的連線 | 否則 guest 看到每台機器的 cwd / branch |
| `idempotency_key` 命中 | 先比 group,再驗 membership(§2.1.2;legacy 模式不比) | 快取不能繞過判定 |
| `reply_idem` 重放(committed / final row) | 不重驗 group —— 回的是該 handle 自己已收到的結果 | 無新資訊、無新投遞;error row 同碼 |
| 有成員身分但缺 cap | 403 `cap_denied` | 動作級拒絕,可告知 |
| `list_peers` / `/v1/peers` | 只回共享 group | 不列 = 不存在 |
| replay butler `by_sender` | 只數看得到的 | 不洩漏其他 group 的活躍度 |
| `/metrics`(`metrics.ts`;**現況完全無認證**,`app.ts:23` 掛在 bearer 之外) | 先加 `HANGAR_METRICS_TOKEN` bearer 閘(缺 env → 整個路由 404);**auth 落地後**才加 `group` label;peer bearer 一律 401 | peer 不該從總量推別 group 的流量 |
| audit_log | 每個 group 拒絕事件都記,含 `group_id` | operator 事後可查 |

### 2.1.9 CLI / MCP 介面

- MCP `send_to_peer`:新增選填 `group`;`to: "@group"`;`BROADCAST` 開頭內容的閘門不變(每 group 各算)。
  `list_peers` 輸出按 group 分節。`poll_inbox` 每則多一個 `group` 欄位。channel tag 多一個屬性:
  `<channel source="hangar-bridge" from="…" group="…" msg_id="…">`,讓收件 Claude 知道語境。
- dotfiles `bin/fleet`:`fleet send --group <g>`、`fleet peers` 分 group 印、`fleet whoami` 印
  memberships + default;`@team` 用法印 deprecation 提示。
- peer-agent config 新增 `default_group`(選填;缺省信 relay 回的 `/v1/whoami`——本 plan 新增這個唯讀端點,
  回 `{handle, groups:[{id, caps, history}], default_group}`,同時是 §5 驗收工具)。

### 2.1.10 Migration(schema v9 → v10)與 peers.json v2

**peers.json v2 形狀**(現行是扁平 `{<handle>: {...}}`,頂層鍵受 `HANDLE_REGEX` 約束,`peers-file.ts:20`,
所以不能直接塞 `groups` 鍵):

```json
{ "peers":  { "<handle>": { "secret_sha256_hex": "…", "display_name": "…", "subjects": {…}, "default_group": "fleet" } },
  "groups": { "<gid>": { "description": "…", "history": "since_join|all", "members": { "<handle>": { "caps": ["chat", …] } } } } }
```

- **legacy 判定 = 頂層無 `peers` 且無 `groups`**(扁平 record;一個恰好叫 `groups` 的 handle 仍走 legacy,向後相容)。
  v2 檔頂層多餘鍵 → 啟動 fail。`peers-groups-init.js` 輸出 v2。
- **模式是「每一次成功 load」的屬性**,啟動與 SIGHUP 走同一條路徑、同一套 fail-closed 驗證(不是只在啟動時判定
  一次)。**legacy → strict 翻轉允許**,並對 DB 現況跑完整嚴格 diff(§2.1.7 差集撤銷 + membership diff → dropHandle);
  **strict → legacy 翻轉一律拒絕**(`relay.roster.reload_failed reason=groups_section_removed`,保留舊 roster)。
- legacy 模式 = 所有 peer 在 `fleet`、history all、caps 全開,啟動印一行 WARN;strict 模式每個 peer 必須至少在
  一個 group、`default_group` 必填且 ∈ memberships,否則 fail(寧可不起也不要靜默把人放進 `fleet`)。

**schema v10**:`schema.sql` 升到 v10 形狀作為 fresh DB 的 canonical(`peer_group` / `group_member`
`CREATE TABLE IF NOT EXISTS`、`message` / `reply_route` 帶 `group_id … DEFAULT 'fleet'`、`claim` 新 PK);
schema.sql 先於 migration 執行(`db.ts:15-16`),所以 `migrateV9ToV10(db)` **逐步 guard**(照現碼慣例,不是單一
version guard):

0. 整體 `BEGIN … COMMIT`。
1. `peer_group` / `group_member` 用 `IF NOT EXISTS`(**不能叫 `group`——SQLite 保留字**);索引 `idx_group_member_handle(handle)`。
2. `INSERT OR IGNORE peer_group('fleet','hangar','migrated single group','all')`;每個 `human` `INSERT OR IGNORE
   group_member('fleet', handle, <全 caps>, now, '0')`。
3. `message.group_id` / `reply_route.group_id`:`pragma table_info` 缺欄才 `ALTER TABLE ADD COLUMN`(照 `db.ts:163-166`)。
4. `claim` 重建(SQLite 不能改 PK):只在 `sqlite_master.sql` 不含 `group_id` 時做(照 `db.ts:272-278`):
   `claim_v10(team_id, group_id, claim_key, …)` → 搬資料 → 前後 `COUNT(*)` assert → rename → **重建 `idx_claim_expires`**。
5. 新索引 `IF NOT EXISTS idx_message_group_id(team_id, group_id, id)`、`idx_message_group_to(team_id, group_id, to_handle, id)`。
6. `INSERT OR IGNORE schema_version(10)`。

## 2.5 Global Constraints(逐字傳播到每個 implementer / reviewer dispatch)

1. `from` 與 `group_id` 都是 relay 蓋章;任何 client 供應的同名欄位一律忽略或剝除,不得成為路由依據。
2. 非成員對一個 group 的任何存在性探測,回應必須與「該物件不存在」無法區分(404 同碼、列表不出現、計數不含)。
3. 讀取側過濾以「讀者當下的 membership + since_msg_id」為準,寫在 SQL WHERE,不在 JS 事後 filter。
4. 沒有 `groups` 段的 peers.json 下,既有 peer-facing `/v1/*` 端點行為與回應必須與 v9 逐位元相同(既有 fleet 零改變);`/metrics` token 閘與新 `/v1/whoami` 是 mode-independent 的明列例外。有 `groups` 段則 fail-closed。
5. membership 縮小必須在 SIGHUP 後 ≤ 1 個 heartbeat 內反映到所有 live stream(主動 drop)。
6. 每個拒絕都進 `audit_log` 且含 `group_id`;拒絕路徑不得比允許路徑更多字節或更慢(timing 一致性:先查 membership 再查存在性,兩者皆為 indexed lookup)。
7. 不引入任何新的 trust 機制(hash chain / 簽章 / attestation);group 只是 relay 內的 authorization 資料。
8. 每個 phase 先紅後綠:測試先寫、在 base 上必須失敗、實作後才綠。

## 2.6 Change-policy decisions

- **Compatibility impact**:`additive-with-deprecation` —— wire 上新增 `group` 欄位與 `@group`;`@team`
  保留一個 minor 版;`/v1/peers` **維持陣列形狀**(entry 加 `groups`,additive),舊 peer-agent 打新 relay 的每個
  端點行為:messages / stream / inbox / replies 不變(它不送 `group` → default_group)、peers 多一個它忽略的欄位、
  `@team` 照常被接受。部署順序仍 relay-first,全 peer 重建是**建議**(拿到 group 顯示與 `reauth` 處理),不是前提。
- **Dependency decision**:`none` —— 不新增套件;SQLite / hono / zod 既有。

## 3. File-structure map

| 檔案 | 責任 |
|---|---|
| `packages/shared/src/constants.ts` | `GROUP_BROADCAST_HANDLE='@group'`、`GROUP_ID_REGEX`(= HANDLE_REGEX)、`MEMBER_CAPS` 常數、`DEFAULT_GROUP_ID='fleet'`、`isBroadcastHandle()` |
| `packages/shared/src/envelope.ts` | Envelope 加 `group: string`(relay 側 NOT NULL;client 送件 schema 為 optional);`to` 接受 `@group`;`@team` 別名判定 |
| `packages/relay/src/db/schema.sql` + `db/db.ts` | schema.sql 升到 v10 形狀(fresh DB 的 canonical);`migrateV9ToV10` 逐步 guard |
| `packages/relay/src/auth/peers-file.ts` | `PeersFileSchema` 加頂層 `groups`、peer 級 `default_group`;`seedPeers` 同步 `group` / `group_member`(含 since_msg_id 只在**新**成員時寫);legacy 判定 |
| `packages/relay/src/groups.ts`(新) | `loadMemberships(db, handle) → Map<groupId,{caps,since_msg_id}>`、`members(db, groupId) → Set<handle>`、`requireCap()`、SQL 片段產生器 `readerScope(memberships)`(給 store 用的 `(group_id, since)` 對) |
| `packages/relay/src/messages/store.ts` | 所有 fetch*(`fetchSince` / `fetchPendingSince` / `fetchInboxSince` / `fetchInboxIdsAfter` / `fetchMailboxSince`)接 `readerScope`;`buildEnvelope(team, from, msg, groupId)` 的父查詢加 group;`insert` 帶 group_id;route 存取回傳 `group_id` |
| `packages/relay/src/routes/messages.ts` | POST:group 解析 + 成員 / 收件人 / cap 驗證(§2.1.2、§2.1.6);GET:readerScope |
| `packages/relay/src/routes/stream.ts` | 連線時讀 memberships;`deliverable` 加 group 條件;cold/resume 用 readerScope;`reauth` 事件 |
| `packages/relay/src/routes/peers.ts` | entry 加 `groups`,只列共享;快取 key = 讀者 membership |
| `packages/relay/src/routes/presence.ts` | 心跳受眾 = 成員聯集 |
| `packages/relay/src/routes/inbox.ts`、`replies.ts`、`grants.ts`、`permission.ts`、`claims.ts` | 各自的 group 檢查(§2.1.4) |
| `packages/relay/src/claims/store.ts` | PK 含 group_id |
| `packages/relay/src/routes/whoami.ts`(新) | `GET /v1/whoami` |
| `packages/relay/src/routes/metrics.ts` | 改用 `HANGAR_METRICS_TOKEN`;group label |
| `packages/relay/src/fanout.ts` | `dropHandle(team, handle, reason)`;`@group` 展開為成員連線;`presence_update` 的 group 判定在此層(成員聯集 ∩ 連線),其他 kind 交給 `deliverable` |
| `packages/relay/src/cli/serve.ts` | `reloadRoster(deps, peersFile)`:差集撤銷 + membership diff → `dropHandle`;清 memo |
| `bin/install-relay.sh` | 停 relay 後、啟動前 `sqlite3 <db> ".backup <db>.bak.<ts>"`(或 cp .db/.db-wal/.db-shm 三檔) |
| `packages/relay/src/purge.ts` | purge 不分 group(沿用),但 `group_member` 不 purge |
| `packages/peer-agent/src/config.ts`、`tools.ts`、`inbound.ts`、`index.ts` | `default_group`、`group` 參數、channel tag 屬性、`reauth` 處理、`ask_group` |
| dotfiles `bin/fleet` | `--group`、peers 分節、whoami、deprecation 提示 |
| `docs/architecture.md` §5.1 / §5.7 | group 模型;D10 註記改寫 |
| `docs/DEPLOYMENT.md` + `bin/peers-groups-init.js`(新) | 把 legacy peers.json 一鍵改寫成顯式 `groups` 段(所有人進 `fleet`,history all) |
| hangar:`decisions/tower/hangar-bridge/NNNN-relay-groups.md`、`runbooks/hangar-bridge-add-guest-group.md`、`tower/hangar-bridge/README.md` | ADR、加同事 runbook、版本 |

## 4. Phases

### P0 — 型別、schema v10、peers-file、groups.ts(size L;純 relay 內部,無 route 行為改變)

1. `packages/shared`:常數 + Envelope 型別 + `isBroadcastHandle`;`envelope.test.ts` 加 `@group` / `@team` 別名 / `group` regex / `isBroadcastHandle`(`@team` / `@group` / 其他)案例(先紅)。
2. `db/schema.sql` v10 + `migrateV9ToV10`;`db.test.ts`:(a) 對一份 v9 fixture DB 跑 migration → `fleet` group 存在、每個 human 一列 member、message.group_id 全 `fleet`、claim PK 遷移後 count 不變、`idx_claim_expires` 存在、schema_version 含 10;(b) **重跑 idempotent**;(c) fresh DB 直接 `openDatabase` → 不拋、schema_version 含 10、表形狀正確;(d) fresh DB 開兩次 idempotent。
3. `peers-file.ts`:schema 擴充 + legacy 判定 + `seedPeers` 同步 group 表。測試:(a) legacy 檔 → 全員 fleet/all/caps 全開 + WARN;(b) 顯式檔缺 `default_group` → throw;(c) `default_group ∉ memberships` → throw;(d) 既有成員再 seed **不改** `since_msg_id`,新成員寫入值符合 `^msg_[0-9A-HJKMNP-TV-Z]{26}$`;(e) 移出 group → `group_member` 列刪除;(f) 從檔案消失的 handle(嚴格模式)→ `disabled_at` 與 token `revoked_at` 皆非 null,legacy 模式不動;(g) legacy 檔啟動後 reload strict 檔 → `group_member` 與檔案一致、差集撤銷生效;(h) strict 後 reload 無 groups 段 → 拒絕、DB 不變;(i) 扁平檔含一個叫 `groups` 的 handle → 仍照 legacy 解析;v2 檔頂層多餘鍵 → fail。
4. `groups.ts` + 單元測試:`loadMemberships` / `members` / `requireCap` / `readerScope` 產生的 SQL 在 `:memory:` DB 上直接執行驗證;另一條 grep 測試斷言 `store.ts` 五個 fetch* 不含後置 `.filter(`(§2.5-3;subject ACL 在 route 層的既有 JS filter 允許)。

**Acceptance**:`pnpm -F @hangar-bridge/relay test` 新增測試全綠;既有 relay 測試(數字以 P0 開工時實跑為準,寫進 ledger)零改動仍綠(legacy 路徑逐位元相同,§2.5-4)。

### P1 — relay 端全面 enforcement(size L;本 plan 的安全核心)

1. `routes/messages.ts` POST:依 §2.1.2 / §2.1.6 順序 —— 解析 group → membership → cap → 收件人成員 → 既有 subject ACL → insert(group_id)。測試矩陣(`messages.group.test.ts`,fixture:`fleet{a,b}`、`lab{b,c}`、`c` caps=[chat];default_group:a=fleet、b=fleet、c=lab;嚴格模式):
   - a→c 直送 → 404 unknown_recipient;a→不存在的 handle → **同一個** body;addressRules=on 時 a→c 不帶 all_sessions → 仍 404,body 不含 `live_instances`。
   - c 以 a 在 fleet 的 msg_id 當 `in_reply_to` 送 chat / task_result → 與 `in_reply_to` = 隨機 id 的回應 byte-equal;c 以該 id 當 `thread_root` → 403 not_in_thread 與 route 不存在同 body。
   - `idempotency-key` 重放但 body 換 group → 422;重放但 sender 已被移出該 group → 404 unknown_group;cached row 無 `group` + body 缺省 → 200 replay。
   - b `@team` → 落 fleet;b `to:@group, group:lab` → lab;b `to:@group` 不帶 group → fleet。
   - a 指定 `group: lab` → 404 unknown_group;b 指定 `lab` 給 c → 200。
   - c `to:@group` → 403 cap_denied;c `task_dispatch` 給 b → 403 cap_denied;c chat 給 b → 200。
   - `@team` 從 a → 落在 `fleet`,audit 有 `deprecated_team_alias`。
   - meta 帶 `group` → 剝除。
2. `messages/store.ts` + `routes/messages.ts` GET + `routes/inbox.ts` + replay butler 計數:readerScope。測試:b 在兩個 group,poll 回兩邊;c 只回 lab;c 加入 lab 前的 lab 訊息(`since_msg_id`)不回;`pending` / `by_sender` 只含可見;migration 前的 `to_handle='@team'` 舊 row 仍被 fleet 成員讀到。
3. `routes/stream.ts` + `fanout.ts` + `routes/presence.ts`:cold start / resume / live 三路都過 group;`@group` 只 fan 給成員;presence 心跳只到共享 group;`delivered_at` 只看成員;`reauth` 事件。測試(SSE 整合,沿用 `stream-superseded.test.ts` 的 harness):a 廣播 → b 收到、c 沒有;b 在 lab 廣播 → c 收到、a 沒有;a 心跳 → c 的 stream **零** `presence_update` 事件;b(fleet+lab)心跳 → c 收到 presence_update;a 廣播 lab 時只有 fleet-only 的 x 在線 → `delivered_at` NULL,c 之後 cold start 收到;SIGHUP 把 b 移出 lab → b 的 stream 收到 `reauth` 並關閉,重連後 lab 廣播不再到;SIGHUP 把 c 從檔案移除 → `reauth`,重連 401;SIGHUP 把 x 加進 lab(x 的 stream 不斷)→ 下一則 lab 廣播 x 即刻收到。
4. `routes/peers.ts` + `/v1/whoami`:c 看 peers 只見 b、c(各帶 `groups:[lab]`),看不到 a 的存在;a 看不到 c;b 看到 a、c 且自己的 entry 帶兩個 group;a 先打 `/v1/peers` 後 1 秒內 c 再打 → c 仍只見 lab(快取不共用)。
5. claims / replies / grants / permission:各一組正反測試(§2.1.4)。特別是 **reply 跨 group**:c 拿到 b 在 lab 的 msg_id 回覆 → 200;c 猜到 a 在 fleet 的 msg_id 回覆 → 404 unknown_parent,body 與隨機 id byte-equal。claims:b 在 lab 取 claim 後以 `group:lab` 釋放 → released:true;不帶 group → released:false(fleet 無此 key)。每種拒絕(unknown_group / unknown_recipient / cap_denied / unknown_parent / 跨 group not_in_thread / peer.removed)各一條 `SELECT detail_json FROM audit_log WHERE event=?` 斷言含 `group_id`(§2.5-6)。
6. `metrics.ts`:無 token / peer bearer → 401,缺 env → 404;`serve.ts` reload 差集撤銷 + membership diff + `dropHandle`;audit 事件齊全。
7. **對抗 harness(depth-0 自寫,不信 implementer 的綠)**:一支 `tests/adversarial/groups.ts` 以三個真 token 打真 relay(`serve` 起在 ephemeral port,嚴格模式 peers.json),枚舉下列 **15 個端點** × {成員, 非成員} × {有 cap, 無 cap},斷言回應碼與 body 形狀表;同時斷言每條「不存在」路徑的回應與真不存在路徑 **byte-equal**(§2.5-6):
   `GET /health` · `GET /metrics` · `GET /v1/messages` · `POST /v1/messages` · `GET /v1/stream` · `POST /v1/presence` · `GET /v1/peers` · `POST /v1/permission/respond` · `POST /v1/claim` · `GET /v1/claims` · `POST /v1/claim/release` · `DELETE /v1/claim` · `POST /v1/replies` · `GET /v1/inbox` · `POST /v1/grants/finalize`(+ 本 plan 新增的 `GET /v1/whoami`)。

**Acceptance**:矩陣全綠;`pnpm test` 全綠(除既知 3 個 nats-server 環境失敗);對抗 harness 零 diff。

### P2 — peer-agent + `bin/fleet`(size L)

1. `config.ts`:`default_group` 選填;啟動時打 `/v1/whoami` 校驗(config 指定但 relay 說不是成員 → 啟動 fail,理由印清楚)。
2. `tools.ts`:`send_to_peer.group`、`@group`、`list_peers` 分節輸出、`poll_inbox` 每則 `group`;`@team` 送出前印 deprecation 到 stderr。
3. `inbound.ts` / `index.ts`:channel tag `group="…"`;`reauth` → 走既有 reconnect(不視為錯誤,不計入 final-mile 失敗次數);`permission_relay.routing` 接受 `ask_group`。
4. dotfiles `bin/fleet`:`send --group`、`peers` 分節、`whoami`;bats 補三案。
5. `docs/PROJECT_ISOLATION.md` 補一段:project isolation(同機跨專案)與 group(跨人)是正交的兩層。

**Acceptance**:peer-agent 測試綠;手動:本機 hub session `list_peers` 輸出分節、`send_to_peer group:` 送達;`fleet peers` 在 hub 印 `== fleet` 一節(legacy 期只有一節)。

### P3 — migration 工具、rollout、live 驗收、hangar 文件(size L;operator 閘門)

1. `bin/peers-groups-init.js`:讀 legacy peers.json → 寫出顯式 `groups.fleet`(全員、history all、caps 全開)+ 每 peer `default_group: fleet`;dry-run 預設,`--write` 才動,原檔 `.bak.<ts>`。
2. `docs/DEPLOYMENT.md` 加「§X groups」:`install-relay.sh` 在停 relay 後、啟動前備份 DB(`.backup` 或三檔 cp),`openDatabase` 啟動即跑 `migrateV9ToV10`;**rollback = 還原 `.bak` + 回舊 revision**;rollout 順序:`peers-groups-init.js --write`(relay 以 strict 啟動)→ systemd drop-in 設 `HANGAR_METRICS_TOKEN`(目前 hangar tower/fleet 無 scraper,亦可明寫「接受 /metrics 404」)→ relay → peer 重建(建議同日,非前提)→ courier 重啟。P3-3 從 strict 出發。
3. **Live 驗收(hub 上,operator 在場)**:
   - 加一個 `guest` handle(新 secret)只進 `guest-lab` group,`caps:["chat"]`;`openclaw` 同時加進 `guest-lab`。SIGHUP。
   - 以 guest token:`GET /v1/peers` → 只有 `guest-lab:[guest, openclaw]`;`GET /v1/stream?since=<很舊>` → 零 fleet 列、零 backlog;`POST /v1/messages to:cuda` → 404 unknown_recipient(與 `to:nonexist` 同 body);`to:@group` → 403 cap_denied;`to:openclaw` → 200 且 hub session 收到 `<channel … group="guest-lab">`。
   - 以 openclaw token 對 guest 回覆 → guest `poll_inbox` 看到;`fleet peers` 在 hub 印兩節。
   - 移除 guest → SIGHUP → guest 的 stream 收 `reauth` → 重連 401;`human.disabled_at` 與 token `revoked_at` 非 null。
   - 全部貼進 `docs/projects/<date>-relay-groups/README.md` 的 evidence 段。
4. hangar 側:ADR(採 C 的理由、since_join、404 同碼原則)、runbook「加一個外部 group / 同事」(從產 secret 到驗收的逐步命令)、`tower/hangar-bridge/README.md` 版本、BACKLOG 三列(`@team` 別名移除、NATS 主題分 group、group 自助 API 若有需求)。

**Acceptance**:evidence 段 8 條全 PASS;hangar `bin/lint.sh` 0 errors;deploy record 完整。

### 相依

P0 → P1 → P2 → P3 嚴格序;P2 的 `bin/fleet` 可與 P1 後段並行(只依賴 wire 形狀,P0 已定)。

## 5. Test / validation

- script-gated:P0–P2 的 vitest + bats;P1-7 對抗 harness(depth-0 擁有,implementer 不得改它)。
- human-gated:P3-3 live 驗收(operator 產 guest secret、看 hub session 的 channel tag)。
- 回歸:既有 relay 測試零改動(legacy peers.json)是 §2.5-4 的機械證明;若任何既有測試需要改,必須在 disposition 說明為何行為變了。

## 6. Risks + inversion

| 會讓它失敗的事 | 緩解 |
|---|---|
| 漏掉一個讀取點沒過 group(例如 purge 前的 `delivered_at` 掃描、replay butler 的 `pending_after`) | P1-7 harness 枚舉**所有** 15 個端點(+ whoami) + `fetch*` 函式清單在 P0 就 grep 出來寫進 plan(`grep -n 'prepare(' messages/store.ts`);reviewer rubric 一條專門對「每個 SELECT message 都有 group_id 條件」 |
| 404 同碼但 timing / body 長度不同 → 仍可枚舉 | harness 斷言 body byte-equal;兩條路徑都先做 membership lookup |
| `@team` 別名讓舊 client 把訊息落到錯的 group | 別名只能落 `default_group`,而 default_group 必是 sender 的成員;audit 可追 |
| migration 在有 claim 活躍時重建表,丟 claim | migration 在 transaction 內;claim 資料先 count 後 assert |
| `/v1/peers` 若改形狀,舊 peer-agent 的 roster 變空 → `SenderGate` 靜默拒收(不是 crash) | 形狀維持陣列、additive(§2.1.4);peer-agent 對缺 `groups` 欄位的舊 relay 也要能跑 |
| `group` 是 SQLite 保留字 | 表名 `peer_group`(§2.1.10) |
| `seedPeers` 從不撤銷消失的 handle | §2.1.7 差集撤銷,P0-3(f) 測試 |
| SIGHUP drop 導致所有人重連風暴 | 只 drop membership **縮小**的 handle;擴大不 drop |
| since_join 讓 operator 自己加新機器時看不到舊廣播 | `fleet` group `history: all`;runbook 明講「自家機器進 fleet,外人進新 group」 |

## 7. Out of scope

見 §1;另:group 級 retention、group 級 rate limit、跨 relay 聯邦、UI。

## 8. Open questions(只有 operator 能答)

1. `fleet` 這個名字給既有圈子 OK?(替代:`cookys`)—— 它會出現在每則 channel tag 與 `fleet peers` 節標題。
2. 同事預設 caps 要不要**連 `permission` 都關**(他們回不了你機器的 permission_request)?本 plan 預設關(`["chat"]`),runbook 讓 operator 逐 handle 開。

## Review log

- R2(2026-09-16)gen-2 Fable 5.1 → **FIX-THEN-SHIP**(10 findings / 3 blockers G1 G2 G4;R7、R10 FAIL;F1–F22 17 resolved / 5 partial),artifact `.g2-artifact.json`;disposition `.g2-disposition.json`:**10/10 accept-and-fold**。
- R1(2026-09-16)gen-1 Fable 5.1 → **FIX-THEN-SHIP**,artifact `2026-09-16-relay-groups.g1-artifact.json`(13 rubric:10 FAIL / 3 PASS;22 findings / 15 blockers)。disposition `2026-09-16-relay-groups.g1-disposition.json`:**22/22 accept-and-fold**(F15 採 A:legacy 400 逐位元、嚴格 404)。depth-0 自驗過的 reshaping claims:messages.ts 判定順序(:158 idem → :250 thread_root → :269 addressRules → :310 subject)、`/v1/peers` 2 秒全域快取、`presence.ts:65` 心跳走 `@team`、`seedPeers` 無差集撤銷、`/metrics` 掛在 bearer 之外、`store.ts:88` unknown recipient 為 Error→400。
- R0(2026-09-16)author:本 session(Opus 5)。logical_plan_id `relay-groups-2026-09-16`;manifest
  `docs/plans/2026-09-16-relay-groups.plan-review-manifest.json`(單席 claude-native `claude-fable-5-1`,
  operator 指定);rubric `docs/plans/2026-09-16-relay-groups.rubric.md`。
