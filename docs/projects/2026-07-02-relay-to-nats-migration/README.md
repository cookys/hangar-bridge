# Project — relay→NATS migration(Direction A 執行)

> **Status:** 🔄 in progress(/l6 CEO mode,hetero impl + hetero verification authoring)
> **Plan:** [docs/plans/2026-07-02-relay-to-nats-migration.md](../../plans/2026-07-02-relay-to-nats-migration.md)(CONVERGED @ `128ff64`)
> **Survey:** [docs/plans/2026-07-02-relay-to-nats-survey.md](../../plans/2026-07-02-relay-to-nats-survey.md)
> **Branch:** `feat/relay-to-nats-migration`(base `128ff64` on develop)
> **Board:** cookys · **CEO:** Claude(depth-0 orchestration only)

## OKR

依 CONVERGED plan 執行 relay→NATS 遷移。每個 phase 的 impl 走 hetero engine
(`engine implement-review`,gpt-5.3-codex-spark + gpt-5.5 xhigh 內迴圈),verification
authoring 走與 implementer 不同家族(Anthropic/Claude 撰寫獨立 harness;OpenAI 為
implementer 家族),depth-0 只做 orchestration、執行 committed artifacts、跑機械檢查、
持有 merge 權 — dispatched green 不具權威。

## Phases(對應 plan §4)

| Phase | 內容 | 驗收 | 狀態 |
|---|---|---|---|
| P0 | NATS control plane:conf + roster + provision script + config-scanner | AC1/2/3/10/12 | ✅ `932bba1`(live-verified) |
| P1 | peer-agent transport seam + anti-spoof + app-side ACL 搬遷 | AC4/8/2b/11/13 | ✅ `2329e0a`(live-verified,85% cov) |
| P2 | two-tier delivery matrix | AC6 | ✅ `e6cbbe7`(live-verified,雙 oracle) |
| P3 | KV permanent dedup | AC5/9 | pending |
| P4 | presence hybrid | AC7 | pending |
| P5 | fleet cutover + soak | **Board 閘** — 超出 DOA(需真實主機+operator 決策) | blocked |
| P6 | relay 刪除(不可逆) | **Board 閘** — 鐵律程序 | blocked |

## Scope Completeness Audit(L-1.5,2026-07-02)

| Dimension | 判定 |
|---|---|
| Source | P0–P4 涵蓋(operations/nats/* 新增、peer-agent seam/ACL/dedup/presence) |
| Tests | AC1–AC13 逐 phase 落地;placement rule:relocated 邏輯 = peer-agent-local unit tests(80% gate),cross-process = e2e(無 gate) |
| Docs | architecture.md / SUBJECT_ROUTING_SPEC / README 對帳 **pin 在 Phase 6**(plan §3)— P0–P4 明確 out-of-scope |
| API 表面 | MCP tools 介面不變(plan 不變量)|
| CHANGELOG / version | repo 無 CHANGELOG;workspace packages private 不 bump — n/a |
| Migration / rollback | plan 逐 phase rollback triggers;P5 前 relay 全程可回退 |
| Consumers(fleet 主機) | Phase 5 — Board 閘,本輪 out-of-scope |
| Dogfood | 既有 relay loopback e2e 全程保綠(P5 前 relay 不動);NATS 跨進程行為由 P2/P3 integration tests 覆蓋 |
| Credit | NATS 官方文件/ADR 已在 plan/survey 內引用 — 無未署名吸收 |

## 環境前置(P0 內處理)

- `nats-server` binary 未安裝 → P0 以 user-local 方式安裝並釘版本(記錄於 operations/nats/)。
- `pnpm` 經 `corepack pnpm`(10.32.1,符合 packageManager)。

## 決策記錄(CEO log)

- 2026-07-02:tree dual-run 跳過 — `tree.js` 將路徑硬解析至 autopilot repo root,無法指向本 repo(工具限制,非裁量)。TaskCreate 維持權威。
- 2026-07-02:P0 `engine implement-review` 首發 fail-closed(`reviewer_qualified:false` — 環境缺 gpt-5.5-via-codex 的 qualification 記錄,round 0 即擋)。判定為登記缺口非能力缺口:本 session 稍早 /l5 跑中同一 reviewer 連做六輪對抗 review、抓五輪真實 ACL bug,能力已證。以 `--allow-unqualified-reviewer`(文件化 escape hatch)放行 — DOA 內戰術決策,此處記錄。
- 2026-07-02:P0 首發 impl 失敗(`question_suspected`,實為 gpt-5.3-codex-spark context window 燒盡)— agent log 顯示它在 runtime 探索 JetStream provisioning 機制(狂打 `/jsz` monitoring endpoints、web search),零檔案。根因是 brief 把 provisioning 寫成「pick ONE mechanism」而 `nats` CLI 未裝。DOA 內策略改變(非 3 連敗、非 Board):裝 `nats` CLI v0.3.1、brief 釘死逐字 `nats` 指令 + 禁 runtime discovery + 精簡篇幅,重派。
- 2026-07-02:verification-writer 家族選 Anthropic(native Agent)— l6 要求與 implementer(OpenAI)不同家族;agy/Gemini 寫檔有已知 bug(reviewer-only 可靠),故寫 harness 用 Claude、決相關 review 用 gpt-5.5/gemini(read-only 路徑)。
- 2026-07-02:**P2 完成(`e6cbbe7`)**。最硬一階。內部迴圈又 `blocked`(壞 JSON),且 implementer 這次**弱化了我的 live test ACL 成 `[">"]`**(test-integrity 回歸,已還原 scoped)。載重的「1-of-2 task replay 失敗」裁決為**測試 fixture bug 而非 impl 缺陷**(非法 `in_reply_to:'task_1'` 被 EnvelopeSchema 正確拒 —— impl 做對了)。真修:outbox head-of-line(task 先 flush)、JS teardown race。兩套去相關 oracle 皆 live 證 AC6(durable task replay + core no-replay),第二套獨立佐證 teardown race。186 tests、84% cov。
- 2026-07-02:**P1 完成(`2329e0a`)**。同 P0 pattern:內部 gpt-5.5 迴圈 `blocked`(reviewer 吐壞 JSON,非 clean verdict)—— internal green 不可信。depth-0 抓修的真缺陷:`fleet-subject.ts` 用 `TEAM_BROADCAST_HANDLE` 未 import(**編譯錯**)+ parseFleetSubject 把 wire `team` 映射成 `@team` 導致 nats-transport **丟棄所有 inbound team broadcast**。獨立 harness 報 3 fail 全為 harness ABI 膠合 bug(直接測證 impl 正確:checkPublish owner→owner=`{ok:true}`、overflow 真的 onOverflow)—— 修 harness 而非 impl。自寫 nkey live round-trip 證 anti-spoof + self-drop。教訓延續:hetero「內部綠 / committed」非權威,必 depth-0 tsc+真跑。
- 2026-07-02:**P0 完成(`932bba1`)**。內部 gpt-5.5 迴圈 5 輪停在 FIX-THEN-SHIP(non_converged),且 implementer 自測 `nats-config.test.ts` collection 即 crash(自製 HOCON parser)——「內部綠」不可信,depth-0 權威閘(兩套去相關 harness + live nats-server provisioning)才是真閘。共抓修 5 個真 defect,其中 **2 個只有 live 執行抓得到**:provision reconcile 非 idempotent(`--defaults` 對 immutable 欄位失敗)、kv-add 因 admin 缺 `$JS.API.STREAM.NAMES`/`$JS.API.INFO` 而 deadline。移除 implementer 崩潰的自測,以 Claude 去相關 harness 為 canonical(36 assertions)。教訓:hetero implementer 的自測與內部 review 迴圈的「committed/verdict」都非權威,必須 depth-0 真跑。
