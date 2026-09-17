# Rubric — relay follow-ups (plan `2026-09-17-relay-followups.md`)

Reviewer contract: 每條以 PASS / FAIL 判定並附證據(plan 節號、或 `packages/**` 的 file:line)。
禁止 argument-from-silence:凡是關於現碼行為的斷言,必須實際讀檔驗證,不得從 plan 文字推定;
找不到證據就寫「未驗證」而不是「應該」。Blocker = 任一 FAIL 會讓實作出錯、破壞既有 client、
或讓 relay 對已上線的 8 個 peer-agent 產生 wire 不相容。非 blocker 的改善寫成 Suggestion。

- R1: [item 2 closure is real, not assumed] `packages/relay/src/routes/presence.ts` 的 POST handler
  只呼叫 `deps.store.buildEnvelope(...)` 再 `deps.fanout.deliver(envelope)`,從未呼叫
  `deps.store.insert(...)` 或任何 INSERT;`packages/relay/src/messages/store.ts` 的 `insert()` 才是唯一
  寫 DB 的路徑。若 reviewer 找到 presence 仍以其他路徑寫入durable buffer(例如另一個呼叫點、或
  `buildEnvelope` 內部本身有副作用寫入),FAIL 並指出 file:line。

- R2: [Phase 1 problem is real] `packages/relay/src/presence/registry.ts` 的 `PresenceSession` 介面
  (13-27 行)不含 `summary` 欄位,`toSession()`(76-86 行)未複製 `SessionState.summary`;
  `get()`(163-182 行)的 handle 層 `summary` 來自 `sessions[0]`(Map 插入順序),非最新寫入。任一
  斷言與現碼不符 FAIL。

- R3: [Phase 1 fix does not break existing wire] `/v1/peers` 既有欄位(`handle`/`display_name`/`online`/
  `summary`/`last_seen`/`subscribed`/`sessions`/`groups`)不因新增 `session.summary` 而改變型別或消失;
  舊 peer-agent(不讀 `sessions[].summary`)必須繼續正常運作 —— 新欄位是加法,不是取代。若 plan 的
  "most recent non-empty" 選取邏輯在「所有 session summary 皆空」時的 fallback 不明確或會拋錯,FAIL。

- R4: [Phase 1 renderer scope is bounded] 對 `packages/peer-agent/src/tools.ts` 的
  `renderPeerLine`/`renderGroupedPeers` 改動只在「該 handle 有 >1 session」時多印縮排行,單一 session
  的既有輸出格式(`renderPeerLine` 回傳的單行字串)必須逐字元不變 —— 既有測試若對這行做字串相等
  斷言,改動不能讓它們變成多行。若 plan 沒有承諺這個不變式,FAIL。

- R5: [Phase 2 problem & fix location are real] `packages/relay/src/fanout.ts` 的
  `resolveMatches()` 中,`handle === e.from && e.to !== GROUP_BROADCAST_HANDLE` 分支內,
  `to_filter == null` 目前直接 `continue`(整個 handle 被跳過),`to_filter != null` 才呼叫
  `filterOutInstance` 只排除發送 instance。若 reviewer 讀到的行為與此不符,或發現拿掉
  `to_filter == null` 的 early-exit 後會使某個既有測試斷言「未收窄的 @team 廣播不回到寄件者的任何
  session」失真(而非只是「不回到寄件 instance」),FAIL 並引 file:line + 測試名。

- R6: [Phase 2 legacy safety] 沒有 `sender_instance`(`senderInstance === undefined`)的舊 client 送出
  未收窄 `@team` 廣播時,行為維持「整個 handle 被排除」不變 —— plan 是否明確保留這個 legacy guard,
  遺漏視為 FAIL(會讓舊 client 收到自己的回聲)。

- R7: [Phase 2 scope boundary] `GROUP_BROADCAST_HANDLE`(`e.to === GROUP_BROADCAST_HANDLE`)分支的既有
  行為(102-16 行的 sibling-groups 路徑)不受本項變動觸及。若 reviewer 認為兩者共用某段邏輯而
  plan 未察覺其耦合,FAIL。

- R8: [Phase 3 problem is real] `packages/relay/src/routes/messages.ts` 的 ephemeral 送信分支(168-169
  行附近)僅設定 `ephemeral='1'`,未產生 `correlation_id`;而 sender 提供的 `correlation_id` 在更早
  (108 行附近)被剝除。若現碼其實已有生成 correlation_id 的路徑(plan 看漏),FAIL。

- R9: [Phase 3 fix does not silently persist ephemeral content] plan 提出「relay 記住
  `correlation_id -> 對象` 的 in-memory、有 TTL 的路由表(對齊 `EPHEMERAL_ROUTE_TTL_MS`)但不寫
  durable buffer」——reviewer 須確認這條路由表本身不等於把 ephemeral 訊息內容變相持久化(它只存路由
  metadata,不存 content),且 relay 重啟後路由表清空是可接受的降級(回信會如同 unknown_parent 一樣
  被拒絕,而不是靜默丟失或誤投給錯誤對象)。若 plan 沒有講清楚重啟後的行為,FAIL。

- R10: [Phase 3 failure mode matches existing contract] 逾時或未知 correlation_id 的回覆,回應 shape
  沿用既有「unknown parent」的 400 語意(reviewer 需在 `messages.ts` 找到既有 `unknown_parent`-類錯誤的
  實際回應格式並確認一致),而非發明一種新的靜默失敗。不一致 FAIL。

- R11: [phase independence & ordering] 三個 phase(1/2/3)彼此不共用可能衝突的程式碼路徑(Phase 1 動
  `registry.ts`/`peers.ts`/`tools.ts`;Phase 2 動 `fanout.ts`;Phase 3 動 `messages.ts`),可以任意順序
  合併不互相踩線。若 reviewer 發現交叉依賴(例如 Phase 3 的 correlation_id 路由表需要 Phase 1 的
  session 資料),FAIL 並指出。

- R12: [item 5 skip is honest] plan 對「sibling processing rights」與兩條 replay-butler 項目的跳過理由
  (需要產品決策 / 兩條 S-size 項目共用同一段熱路徑但缺共用回歸測試)站得住腳,不是為了省事而編造。
  若 reviewer 認為任一條其實可以在本行安全地機械式完成,標記為 Suggestion(不是 blocker)並具體說明
  範圍。

- R13: [tests are sufficient] 三個 phase 各自的「先紅」harness 描述(Phase 1:雙 session 不同時間點
  summary;Phase 2:未收窄廣播 sender instance 排除但 sibling instance 收到;Phase 3:ephemeral 回覆
  往返成功)足以在 base `565cb42` 上重現對應的缺陷。缺口列為 Suggestion 或 Major,由 reviewer 判定是否
  blocker。
