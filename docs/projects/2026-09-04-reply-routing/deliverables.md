# reply-routing — deliverable 切分(spec v7 §15 → 五個 per-PR 大小的 campaign)

順序 D1 → D2 → D3 → D4 → D5,每個都疊在前一個 merge 後的 `feat/reply-routing` tip 上。
D1 與 D2 路徑互斥可平行(width ≤ 3),其餘串行。每節就是 foreman brief 與 implementer
prompt 的內容來源;spec 節號指 `REPLY_ROUTING_SPEC.md`,implementer 只需讀列出的節。

共同規則(每個 prompt 都貼):
- TDD:先寫紅的測試(檔名依現有慣例:同目錄 `*.test.ts`,relay 整合測試在
  `packages/relay/tests/integration/`),再實作,再綠;一個邏輯變更一個 conventional commit。
- 工具:`corepack pnpm`(裸 `pnpm` 不在 PATH)。coverage 門檻 shared 95 / relay 85 / peer-agent 80
  行,不得下調。
- 不改 `SUBJECT_ROUTING_SPEC.md` 語意;不改 `<channel>` 標籤形狀;`instructions.ts` 的六點安全
  charter一字不動,只換 §15 指定的那一句。
- 禁止:push、merge、改依賴、網路安裝、碰 `allowed_path_prefixes` 以外的檔。
- 所有新錯誤回應形狀:`{ error, message, retryable, ...detail }`(§13)。

## D1 — shared:envelope / channel / 常數(§2、§6.5、§7、§8.3、§11、§13)

- 路徑:`packages/shared/src/{envelope.ts,channel.ts,constants.ts,index.ts}` 及對應 `*.test.ts`。
- 內容:
  1. `OutboundMessageSchema` 新增可選 `all_sessions: boolean`、`thread_root: msg_id`(§6.1、§7);
     `all_sessions` 只允許 `kind=chat` 且 `to` 為具名 handle(非 `@team`、不與 `fleet_wide` 並存)。
  2. reserved-address refines(§6.5):`to` 不得為 `@mailbox:*`(錯誤 `reserved_address`);
     `to_filter.instance` 不得為 `~cli`(`reserved_instance`);常數 `RESERVED_CLI_INSTANCE='~cli'`、
     `MAILBOX_PREFIX='@mailbox:'`、`isMailboxHandle()`。
  3. `Envelope` 型別/schema 容納 `to='@mailbox:<handle>'` 的列(relay 內部寫入,不經 client schema)。
  4. `channel.ts`:chat frame 多一行 reply 提示,**依接收者**(§8.3):bridge Claude 收到的 frame
     印 `Reply: reply_to_peer in_reply_to=<msg_id>`;`meta.reply_route='none'`(或等價旗標,由
     D3 relay 蓋章)時印 `reply route unavailable`,不印命令。body escaping 不變;property test
     照舊必過。
  5. 錯誤碼常數表(§13 全表)匯出給 relay / peer-agent 共用;`REPLY_LIMITER_DEFAULTS`(10 / 10 min)、
     `EPHEMERAL_ROUTE_TTL_MS`、`LEGACY_ROUTE_TTL_MS`(7 d)(§12)。
- 驗收:`corepack pnpm -F @hangar-bridge/shared exec vitest run --coverage` 綠且 ≥ 95 %;
  `corepack pnpm -r typecheck` 綠(relay / peer-agent 尚未用新欄位也要能編譯)。
- 預估 diff:300–450 行。

## D2 — relay 資料層:schema v8、migration+backfill、store/fanout helpers、limiter(§3.1、§3.3、§3.4、§4 drain 述詞、§5.3、§9)

- 路徑:`packages/relay/src/db/{schema.sql,db.ts,db.test.ts}`、`packages/relay/src/messages/store.ts`
  (+`store.test.ts`)、`packages/relay/src/fanout.ts`(+`fanout.test.ts`)、
  `packages/relay/src/reply-limiter.ts`(新,+test)、`packages/relay/src/purge.ts`。
- 內容:
  1. 四張表原文照 §3.1(`reply_route`、`reply_grant`、`reply_limiter`、`reply_idem`)+ 唯一索引
     `reply_route_correlation`;schema 版本 8,由 `migrateV7ToV8` 記錄(比照 v7 只在 migration 完成後
     插入)。
  2. backfill(§5.3 表):對 `kind IN ('chat','task_dispatch')` 的每列建 route;`sender_instance` 取
     `json_extract(meta_json,'$.sender_instance')`;`legacy_width` 依列形狀;`thread_root=COALESCE(thread_root,id)`;
     `expires_at = migration + 7d`;migration 回傳並 log `{routes, null_sender_instance}` 計數。
  3. `MessageStore` 新增:`insertRoute/insertGrants`(同一交易的 helper)、`getRoute(msg_id | correlation_id)`、
     `tombstoneRoute`、`hasGrant(msg_id, handle, instance, selector)`、`finalizeGrant`(§8.1 狀態機:
     blank→replace、再 finalise→insert、已存在→no-op、皆無→null)、`fetchMailboxSince(handle, since, limit)`
     (§8.2 述詞 `to_handle='@mailbox:<h>' AND id > since`,不蓋 delivered_at)。
  4. drain 自我排除(§4):`fetchSince/fetchPendingSince/fetchInboxSince` 對 direct 列加
     `AND (json_extract(meta_json,'$.sender_instance') IS NULL OR … != <poller instance>)`;三者都
     不含 `@mailbox:` 列(現有述詞已排除,加測試釘死)。
  5. `Fanout.snapshot(envelope)`:回傳「若現在送會 match 的 `{handle, instance}` 集合」但**不送**;
     `deliverDetailed(envelope, snapshot?)` 接受凍結快照只送給快照內的 subscriber(§3.2 步驟 4)。
  6. `reply-limiter.ts`:fixed window `floor(now/10min)`,單一條件式 `INSERT … ON CONFLICT DO UPDATE
     SET count=count+1 WHERE count<10`(回傳是否成功與 `retry_after_s`);`purge.ts` 掃掉兩個 window
     前的列與 `expires_at` 過期的 route(cascade 帶走 grant)。
- 驗收:`corepack pnpm -F @hangar-bridge/relay exec vitest run --coverage` 綠 ≥ 85 %;既有
  `attribution.test.ts` § self-excluded delivery accounting 不變綠;新測試至少覆蓋:migration 冪等、
  backfill 四種 width、NULL sender_instance 計數、限流器並發(兩個交易只有一個過 `count<10`)、
  snapshot 與 fanout 集合一致、drain 自我排除。
- 預估 diff:600–900 行。

## D3 — relay 送信 chokepoint + stream/poll grants + 住址規則旗標(§3.2、§4、§6、§7、§10、§11、§13)

- 路徑:`packages/relay/src/routes/messages.ts`、`packages/relay/src/routes/stream.ts`、
  `packages/relay/src/deps.ts`、`packages/relay/src/app.ts`、`packages/relay/src/cli/serve.ts`
  (讀 env `HANGAR_RELAY_ADDRESS_RULES`,預設 off)、`packages/relay/tests/integration/{messages,stream,inbox,to-filter,attribution}.test.ts`
  與新 `address-rules.test.ts`。
- 內容:
  1. `deps.addressRules: 'off'|'on'`,預設 `'off'`(比照 `broadcastGate`)。
  2. 寫入順序(§3.2):對 user-authored kind:validate → `fanout.snapshot` → 一個交易(route、每個快照
     項一筆 grant、按現行規則決定是否 `message` 列)→ `deliverDetailed(built, snapshot)` → 回應。route
     insert 失敗 = 500、不送。directed `task_dispatch` matched 0 → 無 route(§3.1 例外)。`thread_root`
     依 §3.3 永不 NULL。
  3. 解析 `x-hangar-return-selector`(文法 `<name>@<ULID>` 或 `~none`,壞的 400)存進 `route.return_selector`;
     `meta.local_target` 在 `/v1/messages` 維持今日語意、不進 route。
  4. `thread_root`(§7):驗 caller「sent OR granted」(含 selector 規則、legacy 只認 handle),否則
     403 `not_in_thread`;通過則 canonicalise 為該 route 的 `thread_root`。**不受旗標控制**。
  5. 旗標 on 才生效的拒絕(§6.1–6.3、§13):`use_reply_verb`(user-authored kind 帶 `in_reply_to`)、
     `sender_instance_required`、`handle_needs_all_sessions`(detail `live_instances[]`)、
     `dispatch_needs_instance`;旗標 off,`/v1/messages` 行為與今日逐字元相同(既有整合測試全綠即證)。
     `reserved_address`/`reserved_instance` **不受旗標控制**(§6.5)。
  6. 回應多帶 audience report(§11):`live[]`(快照,courier 項標 `(unconfirmed)`)、`durable[]`
     (`[]`|`[<handle>]`|`[repo:<name>]`|`[team]`)、`matched`。
  7. `stream.ts`:`x-hangar-instance=~cli` 拒絕 400 `reserved_instance`;cold-start drain / `?since=` replay
     在 `writeSSE` 前寫 grant `(msg_id, handle, subscriber instance)`;**不動**既有 supersession 路徑。
     `GET /v1/messages`(poll_inbox):寫 grant `(msg_id, handle, poller instance)`;無 instance 時旗標 on
     → 400 `instance_required`,旗標 off → 照舊回傳但 `attribution_status: unverifiable`。
  8. 重寫 `messages.ts` 中「never positive routing」註解為 §10 的措辭(「positive routing for replies,
     under same-bearer mutual trust; never authorization」)。
- 驗收:relay 整合測試全綠 ≥ 85 %;新測試至少:旗標 off 時舊行為位元相同(用既有測試)、旗標 on 四種
  拒絕各一、route+grant 在 SSE 事件前已存在(subscriber 在 deliver 回呼內查表)、快照後新訂閱者不收 live
  但 drain 得到 grant、`~cli` stream 拒絕、poll grant。
- 預估 diff:500–800 行。

## D4 — relay 新端點:`/v1/replies`、`/v1/inbox`、`/v1/grants/finalize`、evidence manifest 骨架(§5.1、§5.2、§5.4、§8.1 finalise、§8.2、§9、§13、§16)

- 路徑:`packages/relay/src/routes/{replies.ts,inbox.ts,grants.ts}`(新)、`packages/relay/src/app.ts`
  (掛載)、`packages/relay/tests/integration/{replies,mailbox-inbox,grants-finalize}.test.ts`(新)、
  `docs/evidence/address-rules-gate.json`(新)。
- 內容:
  1. `POST /v1/replies {in_reply_to, content, meta?}`,嚴格 schema(拒 `to/to_filter/fleet_wide/all_sessions/subject`);
     `Idempotency-Key` 必填、文法 `[A-Za-z0-9_-]{1,64}`;`key_hash = sha256(len‖team_id, len‖handle, len‖key)`;
     `request_digest = sha256(JCS({in_reply_to, content, meta}))`(RFC 8785 canonical JSON,自寫小函式
     即可,不加依賴);狀態機 pending/committed/final/error 與 lease 圍欄照 §5.1 步驟 1 逐句:pending 等
     10 s→409 `reply_in_progress`;60 s 舊 pending 由一個 CAS(lease 與 reserved_at 同時)接管;所有狀態
     寫入 `WHERE key_hash=? AND lease=?`,零列 → 409。
  2. 步驟 2–5:`unknown_parent`(404,含過期、correlation alias 查找)、`not_a_recipient`(403,含 selector
     比對)、`legacy_unreplyable`(403)、`parent_unaddressable`(410,tombstone `unaddressable_at`,不刪
     列;§13 表寫「deleted」是 v6 殘句,以 §3.1/§5.1 的 tombstone 為準,並順手改 §13 那格)、
     `reply_storm`(429,`retry_after_s`,idem 列 `error_until`)。
  3. 步驟 6 session 分支與 mailbox 分支(`sender_instance='~cli'` → `to='@mailbox:<h>'`,持久化、單一
     grant、不 fanout);回應 = audience report + `sender_state`、`legacy_parent`,commit 後 fanout 前崩潰
     的重試回 `fanout: unknown`。relay 蓋 `meta.local_target = route.return_selector`,刪 client 供的。
  4. `GET /v1/inbox?since=&limit=`(§8.2):`{messages, last_id, has_more}`,limit 1..500 預設 100,
     不蓋 delivered_at、不刪。
  5. `POST /v1/grants/finalize {msg_id, selector}`(§8.1 狀態機,404 `grant_not_found`),bearer +
     `x-hangar-instance` 即 courier 身分。
  6. `docs/evidence/address-rules-gate.json`:`{ pins: {relay, peer_agent, courier_artifact,
     fleet_cli_commit, agent_call_version}: 全 null, entries: { cli_directed: null, courier_pane: [],
     mailbox: null } }` 骨架 + 一段 `_comment` 說明 §16 填法。
- 驗收:relay 整合測試全綠 ≥ 85 %;至少:同 key 重放回同結果且不重計限流、不同 digest 422、並發兩請
  求只有一個 pending 通過、接管 CAS、五種拒絕、mailbox 往返(reply → inbox 分頁 → 用 `~cli` 回
  reply)、finalize 三態。
- 預估 diff:700–1000 行。

## D5 — peer-agent:`reply_to_peer`、`send_to_peer` 變更、instructions、switchboard 持久 instance + 回程選擇器 + finalise-before-paste、CLI 標頭(§5.1 MCP 面、§8.1 courier、§8.3、§11)

- 路徽:`packages/peer-agent/src/{tools.ts,tools.test.ts,instructions.ts,switchboard.ts,switchboard.test.ts,config.ts,config.test.ts,cli/send.ts,mcp-server.ts,outbound.ts}` 與相關測試。
  若 diff 超過 55 KB,拆 D5a(tools/instructions/cli/send/outbound)與 D5b(switchboard/config)。
- 內容:
  1. `reply_to_peer({in_reply_to, content, meta?})` → `POST /v1/replies`,每次呼叫鑄一個 ULID 當
     `Idempotency-Key` 並在重試沿用;`$TMUX_PANE` 有值時從本機 `agent-call` registry 讀本 pane 的
     `name@generation` 當 `x-hangar-return-selector`(讀不到就不帶;**不**呼叫 attach — attach 屬
     dotfiles/agent-call,out of scope)。回傳兩段式 audience report(§11)加 `sender_state`。
  2. `send_to_peer`:接受 `thread_root`、`all_sessions`,轉送 relay;`in_reply_to` 在旗標 on 時被 relay
     以 `use_reply_verb` 拒絕 → 工具把 §13 的 hint 原樣回給模型(工具本身不預先拒絕,旗標在 relay)。
     回傳兩段式 audience report。
  3. `instructions.ts`:只把「Reply with the send_to_peer tool, passing to = the sender's handle and
     optionally in_reply_to = the msg_id…」換成 reply verb 說明(`reply_to_peer` 帶 `in_reply_to`,不帶
     任何住址;要換聽眾就用 `send_to_peer` + `thread_root`);六點 charter 逐字保留。
  4. `switchboard.ts`(courier):instance 持久化到 `~/.config/hangar-bridge/config.json → instance`
     (`config.ts` 讀寫,啟動時有就用);收到 `meta.local_target=<name>@<generation>` 的 reply 時,先
     `POST /v1/grants/finalize`,200 才貼;失敗 → final-mile failure `reason: finalize_failed`;registry
     查核 generation/pid/harness,不符 → `return_target_gone` `reason ∈ {not_registered, generation_stale,
     harness_changed, pid_dead, none_selector}`;**刪掉**任何「fallback 到專案所有 pane」的路徑。
  5. `cli/send.ts`:一律送 `x-hangar-instance`(pane 內為 courier instance;pane 外為 `~cli`)與
     `x-hangar-return-selector`(有 registry 資訊時 `<name>@<generation>`,否則 `~none`)。
  6. audience report 兩段式印出:`live: …` / `durable: …`(§11)。
- 驗收:`corepack pnpm -F @hangar-bridge/peer-agent exec vitest run --coverage` 綠 ≥ 80 %;
  `instructions.test`(若無則新增)釘死六點 charter 字串不變;switchboard 測試覆蓋 finalize 200/404、
  五種 `return_target_gone`、無 fallback。
- 預估 diff:600–900 行(可能拆二)。

## 每個 deliverable 共用的 verify_cmd(campaign contract `verify_cmd`)
```
corepack pnpm -r typecheck && corepack pnpm -r build && corepack pnpm -r test:ci
```
(`-r test:ci` 含 e2e 套件;若 e2e 因無本機 NATS/docker 被跳過屬既有行為,不算紅。)
