# Rubric v2 — Fleet 身分模型重構 + 跨 harness 送達 + 失聰免疫

- R1: [narrative] §1.1 的「兩條安裝路徑 config-key drift」敘事與源碼一致（`mcp-registration.ts:20` 寫
  `hangar-bridge-peers`；operations fragment 寫 `hangar-bridge-peer-agent` 且 `_comment` 含正確指令），
  統計「4/7 確認失聰、3 無證據」帶分母且不過度斷言。

- R2: [identity] §2.1「一層 durable handle（`<host>-<project>`）+ instance ULID 僅供 presence/觀測」
  是對問題的最小充分解：durable 層錨定 backlog/claims/cursor（`store.ts:66,83`、`claims.ts:32,59`、
  `stream.ts:91-92`）；instance 不承載定址。若 instance 被賦予任何定址/投遞語意即 FAIL。

- R3: [worktree] §2.2 撤銷 worktree handle 的三個理由各自成立（32 字元 `constants.ts:26`；靜態 roster
  `architecture.md:125-127`；同 repo 同名推導 `init-project.ts:70`），且替代方案（instance metadata +
  subject/claims）對 `/l4`–`/l6` foreman 的實際派工足用。若存在 worktree 必須是 durable 收件人的真實
  情境而替代方案覆蓋不了，FAIL。

- R4: [native facts] §2.3 的原生能力表全部與官方文件一致：bypass→bypass 直投；跨機送方無 RC 可送但
  單向；非 Claude harness 為「不支援」（可單向注入 socket、不能成為可收對等節點）。三條腿
  （durable 回補 / 結構化 / 跨帳號跨 harness）各有源碼或文件依據。60 天證偽條件附可執行的測量計畫。

- R5: [presence fix] P2 規格覆蓋全部已知競態：instance id 同時上 `/v1/stream` 與 `/v1/presence`、
  兩路徑共用 label resolver、per-label connection generation/refcount（cleanup 每連線恰一次、最後
  一條關閉才 remove）、舊 client 無 header 退回現行且新舊互不誤刪。缺任一即 FAIL。

- R6: [cutover safety] P3（cursor 持久化）為 P4 的硬前置；P4 含完整 drain（靜默期 → pending 清空 →
  claims release → peers.json 備份 → 單次重啟）與遷移驗收測試（cutover 前寄舊 handle 的 dispatch
  cutover 後仍送達）。`@team` per-row delivered_at 的殘餘風險已明文列於 BACKLOG 而非遺漏。

- R7: [cross-harness] §2.4 的 hybrid 與實測矩陣一致（MCP inbound push 四家全無 —— 探針證據；
  opencode serve API / kimi web API / codex Stop-hook / grok 降級），`poll_inbox` 為 pull 主路徑。
  herdr.dev 的不引入理由（無 per-message 認證的注入面）成立。

- R8: [disposition] §2.5 的 disposition meta 慣例足以讓「拒絕/反提案/進行中」被 correlation 追蹤，
  且失聯偵測改以「無任何 disposition」為訊號後，防線 3 降級為 claim-aware 無告警 telemetry 的
  誤報率可接受。若 meta 慣例（無 schema 強制）不足以支撐偵測語意，指出並給出不違反「明確不做」
  清單的替代。

- R9: [deaf immunity] §2.6 把偵測轉為結構保證的設計成立：loopback 驗證 + `channels_verified` 使
  「可列出≠可投遞」不再可能靜默存在；config key 經 env plumbing 解決 peer-agent 不知自身 key；
  DEAF 走 health-state builder 不被 heartbeat 覆寫；`/proc` 走祖先鏈且 fail-open。對非 Claude
  harness 的 "verified" 定義明確。

- R10: [ordering & scope] P0→P5 相依正確（P2 程式碼先於 P4 cutover；P3 為 P4 硬前置）；「明確不做」
  清單各項理由成立且無偷渡；全 plan 與 CLAUDE.md invariants 及 "What not to do" 無牴觸。
