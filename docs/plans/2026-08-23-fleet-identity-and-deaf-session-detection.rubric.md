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

## v2.2 增補軸線（P4 否決 + P4' 路由/歸屬解耦）

- R11: [P4-rejection] P4 的否決理由四條各自成立且有第一手證據支撐：不根治（同專案多 session
  仍互收）、兩種撞車形態只解一種、成本外部性（靜態 roster ⇒ 開專案=斷全 fleet SSE）、
  解錯問題（咬人的是歸屬不明非定址不細）。特別驗證第 4 條:8/22 事故中 per-project handle
  是否真的救不了。若任一條經源碼/文件檢驗不成立，指出。

- R12: [attribution-integrity] §「歸屬不確定性」對本次徵詢被汙染的記載誠實且完整，且
  「三席獨立收斂」的降級處理正確 —— 結論是否仍站得住（每條論證各自的第一手數據是否
  足以獨立支撐否決 P4），還是降級後其實已不足以支撐該結論？這是本 rubric 最重要的一題：
  **若答案是不足，plan 必須退回徵詢而非執行。**

- R13: [P4'a] per-message 歸屬（instance ULID + CLAUDE_CODE_SESSION_ID 進 meta）是否
  真能解掉 8/22 那類事故？驗證:(a) meta 是 peer 自宣告還是 relay server-stamp —— 若為
  自宣告，是否違反 `from` is authoritative 的同族不變量、能否被冒用？(b) 舊 peer 不帶
  這些欄位時，收訊端如何區分「舊 peer」與「刻意隱匿」？

- R14: [P4'b] fanout 直達分支排除寄件者的**粒度**正確:必須是 per-instance 而非
  per-handle —— 排除整個 handle 會使「送給同機另一個 session」變成無人收到（比現況更糟）。
  驗證 legacy（無 instance）路徑是否確實退回現行行為，以及 `@team` 分支語意未被改動。

- R15: [P4'c] DEAF 標記的三項要求可實作且不牴觸不變量:(a) 算繪在信封上而非僅 meta ——
  這是否等同修改 `<channel>` tag 形狀（CLAUDE.md「What not to do」明列禁止）？若是，
  給出不違反該紅線的替代；(b) 帶「聾了多久」；(c) 語意二分（自身狀態可信 / 對話歷史不可信）。
  另驗證「標記而非硬拒」的裁決是否正確。

- R16: [P0-gap] 失聰兩種 mode 的補強方案（runtime 收訊信號）是否可靠:「連線後 N 秒內
  是否曾成功 emit 過任何 inbound」對一個**健康但安靜**的 fleet 會不會誤判成 deaf？
  給出不誤判的判準，或說明為何無法避免。

- R17: [scope-creep] v2.2 新增的 P4'a–d 是否有偷渡「明確不做」清單內的項目（envelope
  schema、channel tag 形狀、instructions 弱化、claims API、to_instance 定址）？特別檢查
  P4'b 的 instance 排除是否事實上構成 `to_instance` 定址的前置。
