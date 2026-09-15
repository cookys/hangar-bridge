# Rubric — Relay groups(plan `2026-09-16-relay-groups.md`)

Reviewer contract:每條以 PASS / FAIL 判定並附證據(plan 節號、或 `packages/**` 的 file:line)。
**禁止 argument-from-silence**:凡是關於現碼行為的斷言,必須實際讀檔(或執行)驗證,不得從
plan 文字推定;找不到證據就寫「未驗證」而不是「應該」。Blocker = 任一 FAIL 會讓實作出錯、讓既有
client 壞掉、或讓非成員得到任何 group 的存在性 / 內容 / 活躍度資訊;非 blocker 的改善寫成 Suggestion。

- R1: [problem is real] §0 對現況的描述與源碼一致:`routes/messages.ts` 的 subject 為 null 的 chat
  不過任何 per-recipient ACL;`routes/peers.ts` 對任何已認證 handle 回整份 roster + presence;
  `claims/store.ts` 的 key 空間是 `(team_id, claim_key)`;`stream.ts` cold start 對新 handle 的母體含
  歷史 `@team`。若現碼已有任何分組 / 可見性隔離機制而 plan 漏看,FAIL。

- R2: [overlay vs tenant] §2.1.1 選 C(group overlay on constant `team_id`)而非 B 的理由成立:
  `schema.sql` 的 `UNIQUE(team_id, handle)` 確實使一個 handle 無法同時屬於兩個 team;且 plan 的
  multi-membership 是唯一互通機制,沒有第二套 bridge 規則。若 reviewer 能指出 C 有 plan 未提的
  結構缺陷(例如 `idempotency_key` / `reply_idem` 的 key 不含 group 導致跨 group 重放),FAIL 並具體說明。

- R3: [write side is relay-stamped] §2.1.2:`group_id` 由 relay 從已認證 handle 的 membership 決定,
  client 供應的 `group`(body 或 meta)只能在 membership 內選,否則 404;reviewer 須對照 `messages.ts`
  現有的 `from` 蓋章與 B1 meta 剝除點,確認 plan 指的插入點存在且順序(group → membership → cap →
  recipient → subject ACL)不會讓任何一步在 group 判定前洩漏資訊。

- R4: [every read path is scoped] §2.1.3 表列的讀取點是否**窮舉**:reviewer 必須 `grep -n "prepare(" packages/relay/src/messages/store.ts`
  與 `grep -rn "fetch\|SELECT" packages/relay/src/routes/*.ts packages/relay/src/fanout.ts packages/relay/src/purge.ts`
  列出每一個回傳 message row 或 message 計數給 client 的函式,對照 plan 表。任一漏列 = FAIL(列出函式名)。

- R5: [no existence leak] §2.1.8 的錯誤碼原則自洽:非成員對 group / handle / message 的探測與「真不存在」
  同碼同 body;`/v1/peers` 不列;replay butler `by_sender` 不數;metrics 不給 peer bearer。reviewer 須
  指出 plan 中任何一條會讓非成員區分「存在但無權」與「不存在」的路徑(含 rate-limit 回應、
  `reply_idem` 重放、`idempotency_key` 命中、SSE `reauth` 事件本身、`/v1/whoami`),有則 FAIL。

- R6: [history since_join is sound] §2.1.5:`since_msg_id` 是 ULID 水位,與 message id / cursor 同序;
  reviewer 須確認 message id 確為 relay 產生的單調 ULID(`messages/store.ts` insert 路徑),且
  「加入前的 `@group` 廣播與直送都不可見」在 §2.1.3 的 SQL 條件下成立。若 ULID 在同毫秒內非嚴格單調
  而造成邊界列可見性不確定,指出並要求 plan 定義邊界(`>` vs `>=`)。

- R7: [revocation is immediate] §2.1.7:membership 縮小 → drop stream → 重連讀新 membership。reviewer 須
  對照 `cli/serve.ts reloadRoster` 與 `presence/connections.ts` 確認 plan 假設的「可以按 handle 關閉所有
  連線」在現碼中有對應機制或 plan 明確新增;並確認 `Fanout` 每則現查成員集的說法對「已建立的
  stream 上的 `deliverable` 快取」是否成立(§2.1.3 說 membership 連線時讀一次 —— 兩者要一致:
  縮小靠 drop、擴大靠 Fanout 現查,擴大時已存在 stream 的 `deliverable` 若用連線時快取會**漏收**,
  plan 必須說清楚哪一邊為準)。不一致 = FAIL。

- R8: [caps are complete] §2.1.6 的 kind → cap 表覆蓋 `message.kind` CHECK 的每一個值(`schema.sql`)與
  每一個寫入端點(`/v1/messages`、`/v1/replies`、`/v1/claim`、`/v1/permission/respond`、`/v1/grants/finalize`、
  `/v1/presence`)。漏任一寫入端點未定義 cap 行為 = FAIL。特別問:`POST /v1/replies` 回覆一則
  `task_dispatch` 是 `chat` 還是 `dispatch` cap?plan 要定。

- R9: [backward compatibility] §2.5-4 + §2.6:無 `groups` 段的 peers.json 行為逐位元相同 —— reviewer 須
  對 plan 列的每個 SQL 條件確認在「單一 `fleet` group、history all、since '0'、caps 全開」下退化為恆真;
  `@team` 別名落 default_group;`/v1/peers` 形狀 breaking 有部署順序對策。舊 peer-agent 打新 relay 的
  每個端點行為要能從 plan 推出(不能只說「同日重建」)。

- R10: [migration is safe] §2.1.10:v9→v10 在 transaction 內;`claim` 表重建保住資料與 TTL;重跑 idempotent;
  既有 `openDatabase` 啟動即跑 migration 的路徑(`db/db.ts`)確實會執行 `migrateV9ToV10`;`install-relay.sh`
  的 backup 在 migration 之前。任一未驗證 = FAIL。

- R11: [tests prove the claims] §4 P0–P3 的測試對 §2.5 每一條 Global Constraint 都有至少一個對應案例,
  且 P1-7 對抗 harness 是 depth-0 自寫、implementer 不得改;404 byte-equal 有斷言。缺對應 = FAIL(列出哪條)。

- R12: [non-goals don't contradict] §1 非目標(不動 NATS、不做 bridge、不加密、不做自助 API)與 §2 無矛盾,
  且不動 NATS 不會讓 NATS lane 成為繞過 group 的後門 —— reviewer 須讀 `docs/architecture.md` §5.2 NATS
  段確認 NATS lane 與 SSE lane 的訊息是否共用同一張 `message` 表 / 同一個 relay;若共用而 plan 未 gate
  NATS 入口,FAIL。

- R13: [scope honesty] plan 的 size 標記(四個 L)與 file map 相稱;§8 open questions 只含 operator 才能答的;
  無 TODO / TBD 於 load-bearing 步驟。
