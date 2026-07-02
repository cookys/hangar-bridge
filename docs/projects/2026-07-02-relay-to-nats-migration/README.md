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
| P0 | NATS control plane:conf + roster + provision script + config-scanner | AC1/2/3/10/12 | pending |
| P1 | peer-agent transport seam + anti-spoof + app-side ACL 搬遷 | AC4/8/2b/11/13 | pending |
| P2 | two-tier delivery matrix | AC6 | pending |
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
- 2026-07-02:verification-writer 家族選 Anthropic(native Agent)— l6 要求與 implementer(OpenAI)不同家族;agy/Gemini 寫檔有已知 bug(reviewer-only 可靠),故寫 harness 用 Claude、決相關 review 用 gpt-5.5/gemini(read-only 路徑)。
