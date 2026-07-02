# Survey: hangar-bridge relay → NATS 遷移選型

> Date: 2026-07-02 · 方法:autopilot:survey(researcher + skeptic 雙 agent 獨立搜索、交叉驗證)
> 裁決:**方向 A — 現在遷移**(cookys AFK,依 VISION §5 NATS-anchor stance + 預授權 pipeline 採納;可推翻)
> 下游:本文件是 `2026-07-02-relay-to-nats-migration` plan 的輸入。

## Background

`docs/architecture.md` 的功能對照確認 relay package 與 NATS 高度重疊(subject 語法已趨同
到 NATS 形狀:trailing `>` wildcard)。本調研回答五個選型問題,並針對「NATS 是 baseline」
的既有偏好挖掘反面證據(skeptic agent 專責負面資訊)。

## 五題結論

### Q1 — core NATS vs JetStream 邊界

**兩層切分**:chatter(`chat`、`presence_update`)走 core NATS pub/sub(無持久化,天然
「不 backfill」);`task_dispatch`/`task_result` 走 JetStream `WorkQueuePolicy` stream。
直接實作 VISION §4「missed message 是否 backfill 取決於 message type」。

⚠️ **Jepsen 反證(2025-12,NATS 2.12.1)**:JetStream 預設 ack 即回、每 2 分鐘才 fsync
(違反 sync-before-ack);協同斷電 14.1% 已 ack 訊息遺失、檔案損毀情境 49.7%;單節點斷電
可致永久 split-brain(#7549、#7567 未解)。homelab 無 UPS ⇒ 直接命中。

**緩解(plan 硬性 config)**:單節點 R1(避開 Raft 類 bug;SPOF 與現有單 relay 等價)+
`sync_interval: always`(2–5 host 訊息量下 fsync-per-write 成本可忽略)。

**Idempotency**:`Nats-Msg-Id` dedup 是 2 分鐘滑動視窗,host 離線數小時後重送即重複派工 —
**永久去重仍需自建**(KV entry keyed by task ID)。

### Q2 — 資源仲裁層原語(VISION §3)

- **KV + revision CAS** → binding allocation;**core request-reply(inbox)** → offer/counter-offer 回合。
- Service API(ADR-32)只是 request-reply + discovery/stats,**不是狀態化協商框架** — 協商協議是自己的程式碼,用哪個原語都一樣。
- **KV 無原生 TTL lease**(Discussion #4803):維護者 workaround(workqueue-stream 鏈)明言只適合快速任務 — GPU 長時任務需自建 heartbeat + revision staleness 檢查。
- KV 已知問題:R3 inconsistent reads(#4710)、Get/Watch 漏 key(#4643)、CAS in-flight 多筆時無即時成敗回饋;預設 history=1,watcher 可能靜默跳過 revision。
- **業界先例**:NVIDIA NVCF(GPU 需求 = JetStream queue-depth 訊號驅動 autoscale,非協商)、Choria AsyncJobs(JetStream job queue)、nats-cron(KV leader election)。**2026 主流 multi-agent 框架(LangGraph/MS Agent Framework/CrewAI/Google ADK)無一以 NATS 為一級 transport** — 本專案是此 niche 的早期採用者。

### Q3 — auth 模式

**靜態 NKeys(Ed25519 challenge-response)+ per-user `permissions` block**;不用 nsc/JWT
全套(NATS 自家指南:動態群體才需要;固定 2–5 host 屬過度配置)。

```
authorization {
  users = [ { nkey: "U...",
      permissions: { publish: ["fleet.<handle>.>"], subscribe: ["fleet.>", "_INBOX.>"] } } ]
}
```

- `publish allow: "fleet.<handle>.>"` 重現 **from-stamp 防偽**(server 強制,非 client 自報)。
- deny-by-default 重現 **fail-closed subject ACL**。

⚠️ footguns(plan 需含負面測試):
- GHSA-fr2g-9hjm-wr23:`accounts` 只含 `$SYS` 會靜默開匿名使用者(2.10.2 已修,但示範 auth config 是 footgun 形狀 — fail-closed 必須用測試驗證,不能信 config 長相)。
- `$SYS` 不鎖 = admin account。
- leafnode `Nats-Request-Info` header 可偽造(CVE-2026-33246)— 未來若用 leafnode 聯邦要重新評估。

### Q4 — presence

**混合**:保留現有 `presence_update` heartbeat 為 SoT(transport 無關、語意已知);
`$SYS.ACCOUNT.*.CONNECT/DISCONNECT` 僅作低延遲加速訊號。`$SYS` 事件無持久化/replay
(#5768,維護者確認),重啟期間漏掉即永久遺失,不可單獨依賴。

### Q5 — nats.js client

**v3 split packages**(`@nats-io/transport-node` + `@nats-io/jetstream` + `@nats-io/kv`)。
型別化錯誤(`RequestError`/`TimeoutError`/`NoRespondersError`)對長駐 stdio process 的
reconnect 決策有實質價值。

⚠️ 兩個坑:
1. v3 是 breaking rewrite — 網路範例與 LLM 訓練資料多為 v2 語法,會微妙地錯;以官方 `migration.md` 為準。
2. **reconnect buffer(預設 8MB)靜默丟失**:斷線期間的 publish 可能永遠不送出且無應用層錯誤 — peer-agent 必須自建 overflow/backpressure 處理。

## 交叉驗證關鍵修正:退役範圍比直覺小

| 「NATS 免費給你」的直覺 | 實況 |
|---|---|
| Idempotency | 2 分鐘視窗;永久去重自建(KV) |
| task correlation(`in_reply_to` 強制) | request-reply 是 ephemeral;仍是自己的程式碼 |
| presence | `$SYS` 不可靠;heartbeat 留著 |
| 仲裁協商 | 原語有,協議全是自己的程式碼 |

**真正退役**:HTTP/SSE server、fanout、ULID resume cursor、SQLite buffer、auth
middleware、subject-ACL 執行點(→ server conf)= relay package 主體。
**留下**:envelope schema(shared)、correlation、永久去重、heartbeat、`<channel>` 注入
與 prompt-injection 防線(peer-agent)、未來仲裁協議。

## Options

| Option | Pros | Risks | Fit |
|---|---|---|---|
| **A. 現在遷移**(R1 + `sync_interval: always` + NKey 靜態 auth + 兩層切分) | 退役 transport/infra 層;Phase-B 不蓋在將棄地基上;仲裁層地基就位 | Jepsen 級 bug 靠 config 緩解;v3 client 新;app 層去重/correlation 重寫一次 | 2.5/3 |
| B. 延後遷移(仲裁層動工時) | 零近期風險;等 #7549/#7567 修復 | Phase-B ops 投資蓋在將棄地基上,重做一次 | 2/3 |
| C. 不遷移、加固 relay | 四大不變量原生滿足;SQLite 損毀故事成熟 | 仲裁原語屆時全手造;持續維護非差異化 infra | 1.5/3 |

**採納 A**;前提是 skeptic 清單固化為 plan 驗收條件(見 Q1/Q3/Q5 的 ⚠️ 項)。

## Sources

- [Jepsen: NATS 2.12.1](https://jepsen.io/analyses/nats-2.12.1) — 已 ack 遺失 14–49.7%、split-brain 不自癒
- [nats-server#7564](https://github.com/nats-io/nats-server/issues/7564) — 預設 2 分鐘 fsync 違反 sync-before-ack(root cause);同族 #7549、#7567 未解
- [nats-server#7817](https://github.com/nats-io/nats-server/issues/7817) — workqueue + R3 訊息遺失,2.12.3/2.12.4 仍有報告
- [Disaster Recovery | NATS Docs](https://docs.nats.io/running-a-nats-service/nats_admin/jetstream_admin/disaster_recovery) — R1 節點不可復原時 backup 是唯一路徑
- [Streams | NATS Docs](https://docs.nats.io/nats-concepts/jetstream/streams) — limits/interest/workqueue 三種 retention
- [JetStream Anti-Patterns (Synadia)](https://www.synadia.com/blog/jetstream-design-patterns-for-scale) — 「策略性使用 JetStream」;數百 disjoint subject filter 即不穩
- [KV Walkthrough | NATS Docs](https://docs.nats.io/nats-concepts/jetstream/key-value-store/kv_walkthrough) — revision CAS
- [nats-server discussion #4803](https://github.com/nats-io/nats-server/discussions/4803) — KV 無 TTL lease;workaround 限快速任務
- [ADR-32 Service API](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-32.md) — micro 非協商框架
- [Authorization | NATS Docs](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/authorization) — allow/deny、deny-by-default
- [NKeys | NATS Docs](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro/nkey_auth) — challenge-response,server 不存私鑰
- [GHSA-fr2g-9hjm-wr23](https://github.com/nats-io/nats-server/security/advisories/GHSA-fr2g-9hjm-wr23) — `$SYS`-only accounts 靜默 auth bypass(2.2.0–2.10.1)
- [CVE-2026-33246](https://advisories.gitlab.com/pkg/golang/github.com/nats-io/nats-server/v2/CVE-2026-33246/) — leafnode 身分 header 偽造
- [System Events | NATS Docs](https://docs.nats.io/running-a-nats-service/configuration/sys_accounts) + [discussion #5768](https://github.com/nats-io/nats-server/discussions/5768) — `$SYS` 事件無 replay
- [nats.js migration.md](https://github.com/nats-io/nats.js/blob/main/migration.md) — v2→v3 breaking changes
- [Reconnect buffer | NATS Docs](https://docs.nats.io/using-nats/developer/connecting/reconnect/buffer) — 斷線期 publish 可能靜默不送
- [NVCF open source](https://blog.kubesimplify.com/nvcf-is-now-open-source-inside-nvidia-s-gpu-function-platform) — GPU + JetStream 最接近先例
- [choria-io/asyncjobs](https://github.com/choria-io/asyncjobs) — JetStream job-queue 先例
- [Synadia/CNCF 商標事件](https://thenewstack.io/synadia-attempts-to-reclaim-nats-back-from-cncf/) — 2025-04 BSL 嘗試,2025-05 落幕留 Apache 2.0;治理風險資料點
