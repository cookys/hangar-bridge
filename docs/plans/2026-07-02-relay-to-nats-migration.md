# Plan — relay→NATS migration (Direction A)

> **Status:** 🟡 IN LOOP-REVIEW — g55xh (gpt-5.5 xhigh) blocking trajectory 7→… (R1 fixed).
> **Owner:** cookys (Board)
> **Repo / Branch:** `cookys/hangar-bridge` · base `develop` · impl branch `feat/relay-to-nats-migration`
> **Frame:** retire relay transport/infra → `nats-server` (core NATS + JetStream + KV); converge to envelope schema + MCP peer-agent + future arbitration substrate

## 0. Context / thesis

Direction A from the survey is authoritative: migrate now to self-hosted NATS, drop the relay transport/infra layer, and keep `@hangar-bridge/shared` + `@hangar-bridge/peer-agent` as the runtime substrate. This is consistent with `docs/VISION.md` §5, where NATS is already the acknowledged likely anchor and Direction (2) is a bounded-curiosity detour, not an ongoing open question.

The thesis is explicit: after cutover, system authority sits in the envelope schema + peer-agent + subject/transport conventions, with the arbitration protocol deferred to a follow-up plan. The six wire kinds in `packages/shared/src/envelope.ts` remain the format contract.

Cross-validation correction from the survey is non-negotiable. The relay’s retirement boundary is smaller than intuition: NATS does **not** buy permanent idempotency, correlation integrity, durable correlation memory, or arbitration protocol correctness by itself. The plan treats these as peer-agent/substrate work, plus a future protocol plan.

The `packages/shared/src/ulid.ts` monotonic factory and the relay resume cursor path are retained for now in current shared protocol behavior, but they are **OBSOLETE in the retired relay path** where SSE reconnect uses `?since=<ulid>` today. JetStream sequence numbers and KV revision checkpoints replace that cursor in the future NATS path.

## Retirement boundary (what changes layers)

| Retired (deleted from `@hangar-bridge/relay`) | Retained (stays in `shared` + `peer-agent`) |
|---|---|
| `packages/relay/src/app.ts` — Hono `app` root and route registration | `packages/shared/src/envelope.ts` envelope schema + `superRefine` invariants (`in_reply_to` required for `permission_verdict`/`task_result`, direct-only subject, ack-channel `subject=null` semantics) |
| `packages/relay/src/fanout.ts` in-memory fanout and live-session fanout registry | `packages/peer-agent/src/correlation.ts` correlation tracking and reply validation semantics |
| `packages/relay/src/routes/messages.ts` publish chokepoint + subject ACL gate | presence as source-of-truth heartbeat and transport-agnostic session-state handling |
| `packages/relay/src/routes/stream.ts` SSE subscribe chokepoint + backlog drain path | `packages/peer-agent/src/stream.ts` inbound stream loop and message dispatch integration |
| `packages/relay/src/db/schema.sql` (message/idempotency/delivery persistence) | `packages/shared/src/channel.ts` `<channel>` notification renderer and escaped-body injection gate (`</channel>` must never appear literally in escaped bodies) |
| `packages/relay/src/messages/store.ts` durable message store + `id` cursor semantics | `packages/peer-agent/src/instructions.ts` prompt-injection instructions string (explicitly UNCHANGED, security-critical) |
| `packages/relay/src/auth/middleware.ts` bearer middleware + `from` rewrite | `packages/shared/src/ulid.ts` retained as shared utility until all transport paths are re-based on stream sequence/KV revision |
| `packages/relay/src/auth/peers-file.ts` static peers bootstrap gate (retired; replaced by the NATS credential/ACL artifact `packages/operations/nats/nats-server.conf` for transport auth) | **App-side envelope-subject ACL** (fail-closed namespace ownership — publisher-owns + recipient-owns, `subject`-vs-`@team` direct-only, subjected reactive-kind rejection) relocated into `packages/peer-agent/src/` per SUBJECT_ROUTING_SPEC.md — NATS subject permissions gate `fleet.<handle>.>` but CANNOT inspect `Envelope.subject`, so this logic stays app-side (see AC11) |

## 1. Problem

`docs/architecture.md` and `SUBJECT_ROUTING_SPEC.md` define a one-relay physical topology with subject ACL chokepoints, protocol invariants, and per-kind semantics. Migration must preserve all protocol guarantees while removing relay dependence and replacing it with a single NATS anchor. The primary risk is loss of guarantees that were previously provided by relay code paths, especially sender identity, durable dedupe, presence truthfulness, and kind-specific backfill.

The immediate objective is to retire relay transport/infra now, not later, without weakening security or semantics established by `CLAUDE.md` and `docs/architecture.md`.

## 2. OKR / KRs

- **Objective:** complete migration to NATS-backed transport + JetStream + KV while keeping envelope protocol, six-kind wire semantics, and security invariants intact; keep relay source as transitional compatibility path until final phase.
- **KR1 (Direction A closure):** all transport-level functionality in `@hangar-bridge/relay` is retired by final phase and replaced by operationally equivalent NATS paths with testable gates.
- **AC1 — JetStream single-node and durable fsync:** `nats-server` deployed as single-node R1 streams with `replicas: 1` and `sync_interval: always` in the shipped config.
- **AC2 — Static NKey auth and deny-by-default subject publish ACL:** every fleet user authenticates by `nkey` only (no password/token fallback), publish allow is EXACTLY `fleet.<handle>.>`, deny-by-default. This transport-level subject-prefix ACL bounds WHERE a peer may publish; it is DISTINCT from the app-side envelope-subject namespace ACL (AC11) — NATS cannot inspect `Envelope.subject`. Gate: a named config test asserts each user block has an `nkey`, no `password`/`token`/`user` fallback line exists, and `publish.allow` is exactly `["fleet.<handle>.>"]` with deny-by-default.
- **AC11 — App-side envelope-subject ACL preserved (SUBJECT_ROUTING_SPEC.md fail-closed namespace ownership).** The fork's subject-ACL (publisher-owns AND recipient-owns the namespace; `subject != null ⇒ concrete `to`, never `@team`; subjected reactive/system kinds rejected; ack-channel `subject=null`) CANNOT be enforced by NATS subject permissions (which see only the wire subject, not the JSON `Envelope.subject`). It MUST relocate into the peer-agent (app-side), with the sender identity derived from the authenticated `fleet.<handle>.>` publish subject (AC2b), never from envelope `from`. Gate: executable tests for (a) publisher-not-owner rejected, (b) recipient-not-owner rejected, (c) `subject != null && in_reply_to != null` rejected, (d) subjected `presence_update`/`permission_*` rejected, (e) `subject != null && to == @team` rejected — reproducing `routes/messages.ts` + `routes/stream.ts` chokepoint semantics app-side. The single shared matcher (`namespaceOf`/`ownsNamespace`/`matchesInterest`) stays the sole implementation.
- **AC2b — Subject-derived sender identity (anti-spoof):** peer-agent MUST derive trusted sender from authenticated publish subject (`fleet.<handle>.>`), never from envelope `from`; spoofed `from` in envelope is rejected or overridden.
- **AC3 — `$SYS` account separation:** `$SYS` becomes an explicit admin account, not implicit/default anonymous.
- **AC4 — Reconnect overflow is never silent:** publishes during disconnect/buffer overflow must surface explicit failure or be queued to durable app outbox semantics.
- **AC5 — Permanent dedup:** repeat `task_dispatch` after the `Nats-Msg-Id` window (2 min) must still be deduped by KV.
- **AC6 — Two-tier kind routing:** exactly six kinds are assigned to either core NATS or JetStream backfill tiers, with explicit matrix and tests.
**Tier matrix:**
| Kind | Delivery tier | Backfill policy |
|---|---|---|
| `chat` | core NATS pub/sub | no backfill |
| `presence_update` | core NATS pub/sub | no durable task replay needed |
| `permission_request` | core NATS request-reply / dedicated subject | immediate, no durable task queue |
| `permission_verdict` | core NATS request-reply / dedicated subject | immediate, must keep `in_reply_to` |
| `task_dispatch` | JetStream `WorkQueuePolicy` stream | durable backfill for disconnected recipients |
| `task_result` | JetStream `WorkQueuePolicy` stream | durable backfill for disconnected result handlers |

- **AC7 — Presence hybrid:** presence heartbeat is source-of-truth; `$SYS` events are only accelerants and may be dropped.
- **AC8 — nats.js v3 client split packages only:** transport uses `@nats-io/transport-node`, `@nats-io/jetstream`, `@nats-io/kv`; no monolithic v2 `nats` package.
- **AC9 — No KV TTL lease assumption:** no logic in the plan binds correctness to KV TTL lease semantics; arbitration substrate remains CAS+heartbeat+revision staleness and explicitly forbids correctness-on-TTL assumptions. Plan also treats KV residuals as by-design constraints: `R3` inconsistent reads, `Get/Watch` missed keys, and default `history=1` watcher behavior.
- **AC10 — No leafnode federation and no `Nats-Request-Info` trust:** configuration ships with no `leafnodes` block and no protocol flow that trusts the header as identity.

## 2.5 Global Constraints (copied verbatim into every dispatch)

- Base branch for migration work is `develop` and implementation branch is tracked as `feat/relay-to-nats-migration`.
- Preserve the `@hangar-bridge/shared` envelope contract unchanged: six kinds `chat`, `presence_update`, `permission_request`, `permission_verdict`, `task_dispatch`, `task_result` and current `superRefine` logic.
- Preserve `in_reply_to` requirements for `permission_verdict` and `task_result` as hard protocol invariants.
- Preserve direct-only subject behavior where `subject != null` requires concrete `to`.
- Preserve `packages/peer-agent/src/instructions.ts` word-for-word and do not weaken prompt-injection posture.
- Preserve `<channel>` notification serialization and body escaping from `packages/shared/src/channel.ts`; the 500-run property test that escaped bodies never contain literal `</channel>` stays green and executable.
- Preserve peer-agent envelope parsing path via `packages/shared/src/channel.ts` in all inbound paths.
- Coverage thresholds remain shared 95%, relay 85%, peer-agent 80%; do not lower any threshold to pass tests.
- Do not modify `docs/plans/2026-06-25-cross-project-isolation.md` scope.
- No task may reduce security assumptions to transport-only identity; subject-level identity must be enforced application-side where required. The NATS `fleet.<handle>.>` publish permission bounds the transport prefix ONLY; the envelope-subject namespace ACL (publisher-owns + recipient-owns, fail-closed) and the subject-derived `from` MUST be enforced app-side in the peer-agent (AC2b + AC11) — the relay's `routes/messages.ts`/`routes/stream.ts` chokepoint semantics are preserved, not dropped.

## 3. File-structure map

| File | Change | Responsibility |
|---|---|---|
| `packages/relay/src/app.ts` | remove | removes HTTP/SSE server bootstrap |
| `packages/relay/src/fanout.ts` | remove | removes in-memory fanout registry |
| `packages/relay/src/routes/messages.ts` | remove | removes `/v1/messages` publish chokepoints and relay subject-ACL enforcement |
| `packages/relay/src/routes/stream.ts` | remove | removes `/v1/stream` SSE backlog/connect path |
| `packages/relay/src/db/schema.sql` | remove | removes SQLite durable buffer and schema migration surface |
| `packages/relay/src/messages/store.ts` | remove | removes durable store/read/write semantics |
| `packages/relay/src/auth/middleware.ts` | remove | removes bearer gate and relay `from` stamping |
| `packages/relay/src/auth/peers-file.ts` | remove (transport responsibility) | removes peers-file bootstrap for transport auth/subject ACL |
| `packages/shared/src/envelope.ts` | extend-preserve | retains kinds/in_reply_to/direct-only/ack invariants, no semantic weakening |
| `packages/shared/src/channel.ts` | preserve | keeps `<channel>` escaping and injection-safe rendering |
| `packages/shared/src/ulid.ts` | deprecate in transport flow | document that ULID resume cursor path is relay-only and sunset during cutover |
| `packages/peer-agent/src/stream.ts` | replace | inbound transport seam from SSE to NATS, while preserving channel serialization and six-kind handling |
| `packages/peer-agent/src/correlation.ts` | replace/extend | task correlation for `task_dispatch`/`task_result` + `in_reply_to` enforcement checks |
| `packages/peer-agent/src/instructions.ts` | unchanged | security wording, anti-injection posture remains unchanged |
| `packages/peer-agent/src/inbound.ts` | update call sites | continues peer message injection via shared `channel.ts` serializer |
| `packages/operations/nats/nats-server.conf` | **add (new)** | the hardened NATS config — single-node R1, `sync_interval: always`, static NKey users with `publish.allow=["fleet.<handle>.>"]` deny-by-default, isolated `$SYS` account with dedicated credentials, NO `leafnodes` block. The load-bearing artifact behind AC1/AC2/AC3/AC10 config-scanner tests. |
| `packages/operations/nats/nats-config.test.ts` (or e2e) | **add (new)** | CI config-scanner asserting `replicas: 1`, `sync_interval: always`, every user has `nkey` + no password/token fallback, exact `fleet.<handle>.>` publish allow, `$SYS` isolated, no anonymous `$SYS`-only bypass, no `leafnodes`. |
| `docs/VISION.md`, `docs/architecture.md` | keep as source of truth | no schema drift; architecture.md updated at Phase 5 cutover to describe the NATS topology |
| `docs/plans/2026-07-02-relay-to-nats-survey.md` | reference-only | keep as decision source for this plan only |
| `packages/operations/systemd/hangar-bridge-relay.service` | replace/join | new hardened NATS unit lifecycle, no transport relay service as primary path |
| `packages/operations/systemd/install-relay.sh` | extend | installs/reloads nats-server unit and optionally relay for rollback |
| `packages/operations/claude-config/hangar-bridge.fragment.json` | update | NATS-backed peer-agent fragment shape and env wiring |
| `packages/operations/claude-config/install-mcp.sh` | update | merge/install procedure for updated MCP fragment |
| `package.json` / `packages/peer-agent/package.json` / `packages/shared/package.json` | update | move to v3 nats client splits and remove monolithic v2 dependency |
| `packages/relay/vitest.config.ts` | remove from active test set in final phase | avoid stale relay gate when transport layer is retired |
| `docs/plans/2026-07-02-relay-to-nats-migration.md` | add | this authoritative plan |

## 4. Phases

### Phase 0 — NATS control-plane foundation in parallel with relay (size: H)
Goal: ship a hardened NATS control plane while keeping relay running for rollback.

Done when: `packages/operations/systemd/hangar-bridge-relay.service` and `packages/operations/systemd/install-relay.sh` can run a NATS unit side-by-side against the new `packages/operations/nats/nats-server.conf`, and AC1, AC2, AC3, AC10 gates are proven in CI (`nats-config.test.ts`); relay remains untouched for production traffic during this phase.

Resolved operational decisions (were open questions): **NKey secret storage** — each host's NKey seed lives at `~/.config/hangar-bridge/nats/<handle>.nk` mode `0600` (mirrors the existing `~/.config/hangar-bridge/secret` storage in architecture §4); the server config references public NKeys only (private seeds never leave the host, per the NKeys challenge-response model). **Rotation** — rotate by generating a new seed, updating the user's public `nkey` in `nats-server.conf`, and `systemctl reload` (a reload drops live connections cleanly, mirroring the relay re-seed discipline). A CI test asserts the config references no private seed material and no plaintext credential.

Rollback trigger and step: if any hardening gate fails, stop NATS rollout and continue relay-only operation by uninstalling/disable the new unit. No source-path changes are introduced in this phase.

### Phase 1 — Peer-agent transport seam and anti-spoof hardening (size: H)
Goal: replace SSE stream/client path in `packages/peer-agent/src/stream.ts` with a NATS transport seam that preserves envelope serialization via `packages/shared/src/channel.ts`.

Done when: AC4, AC8, AC2b, and AC11 (app-side envelope-subject ACL relocated from the retired `routes/messages.ts`/`routes/stream.ts` chokepoints into the peer-agent, using the single shared matcher) are passing, and inbound/outbound code paths show equivalent behavior with deterministic `subject` and `from` handling.

Rollback trigger and step: any regression in normal tool flow (dispatch/task/listening) reverts peer-agent transport config flag to SSE/relay path, leaving relay route available as the live fallback.

### Phase 2 — Two-tier delivery matrix and kind routing (size: L)
Goal: classify every one of six envelope kinds and enforce the delivery map.

Done when: AC6 matrix is implemented and validated with integration tests proving `task_dispatch`/`task_result` backfill via JetStream and `chat`/`presence_update` no-backfill on core NATS; `permission_request` + `permission_verdict` are assigned to the reactive core-NATS path. Per the `superRefine` invariant, `in_reply_to` is REQUIRED only on `permission_verdict` and `task_result` (→ their originating request/dispatch); `permission_request` does NOT require `in_reply_to`. Tests assert `permission_verdict` and `task_result` always carry a valid `in_reply_to`, and that a `permission_verdict`/`task_result` missing it is rejected by the shared schema.

Resolved (was an open question): the JetStream stream for `task_dispatch`/`task_result` is **strict `WorkQueuePolicy` retention only** (a message is removed once acked by its single consumer) — no history/audit-replay metadata stream in this plan. Audit-replay tooling is explicitly out-of-scope (§7). Test asserts the stream is created with `retention: workqueue` and `replicas: 1` (AC1).

Rollback trigger and step: if matrix causes type regressions, keep all peer traffic on request-reply core NATS temporarily and park JetStream routing behind a feature flag until matrix is corrected.

### Phase 3 — KV substrate for permanent dedup and correlation retention (size: H)
Goal: introduce durable key-tracked task dedup and CAS-backed repeat suppression independent of `Nats-Msg-Id`.

Done when: AC5 and AC9 are passing, including injected-time tests that replay the same `task_dispatch` across a simulated >2-minute window and prove KV-CAS dedup; correlation remains intact and consistent with `packages/peer-agent/src/correlation.ts`.

Rollback trigger and step: disable KV-gated dedup and fallback to relay-like acked replay discipline in transport feature gate; keep relay path unchanged for safety.

### Phase 4 — Presence hybrid under heartbeat source-of-truth (size: M)
Goal: convert presence behavior to transport-agnostic heartbeats as truth, with `$SYS` as optional accelerator only.

Done when: AC7 proves correctness when `$SYS` events are suppressed, and stale heartbeat TTL forces offline state even if last observed `$SYS` was CONNECT.

Rollback trigger and step: revert presence-state derivation to heartbeat-only path and disable `$SYS` subscriptions if their event handling breaks ordering.

### Phase 5 — Relay retirement, operations cutover, and coverage gate migration (size: H)
Goal: complete cutover, decommission relay code, update operations docs/scripts, and complete coverage gate disposition.

Done when: relay transport is retired from active runtime, `packages/operations/claude-config/hangar-bridge.fragment.json` + `packages/operations/claude-config/install-mcp.sh` are updated for NATS peer-agent startup, and CI test expectations are updated so shared 95% and peer-agent 80% gates are maintained while the relay 85% gate is removed along with runtime path.

Rollback trigger and step: if operational cutover fails, keep relay artifact and service available as immediate fallback by re-enabling the relay unit and disabling peer-agent NATS transport.

## 5. Test / validation

- **AC1 (JetStream hardening):** `nats-config.test.ts` scans `packages/operations/nats/nats-server.conf` and asserts `sync_interval: always`; an integration smoke asserts every JetStream stream is created with `replicas: 1` (single-node R1). Backed by the config file, not prose.
- **AC2 (static NKey auth + fail-closed negatives):** (a) `nats-config.test.ts` asserts every user block has an `nkey`, NO `password`/`token`/`user` fallback exists, and `publish.allow` is exactly `["fleet.<handle>.>"]` deny-by-default; (b) negative integration tests publish on `fleet.bad-handle.>` and verify deny; (c) a fixture in the GHSA-fr2g-9hjm-wr23 `$SYS`-only-accounts shape asserts anonymous/unauthenticated connect attempts are REJECTED (fail-closed verified by test, never trusted from config appearance).
- **AC2b (application anti-spoof):** negative test posts an envelope with `from: spoofed` under `fleet.<real_handle>.>` and expects peer-agent to reject or rewrite sender identity to the authenticated handle; assertions also verify no task or message is accepted as from the spoofed handle.
- **AC3 (`$SYS` segregation):** `nats-config.test.ts` asserts `$SYS` has a dedicated credential; an auth test proves a non-`$SYS` user cannot access `$SYS.>` subjects and only the explicit `$SYS` principal can subscribe/publish there.
- **AC4 (reconnect overflow):** disconnect/reconnect harness drives publish bursts above reconnect buffer; test asserts explicit error event or durable app-level outbox entry for all dropped publishes.
- **AC5 (permanent dedup):** repeat same `task_dispatch` with same correlation ID after a mocked clock advances past 2-minute `Nats-Msg-Id` window; test expects one active dispatch entry only (KV CAS win).
- **AC6 (kind matrix + backfill behavior):** matrix test verifies all six kinds are assigned exactly once; offline `task_dispatch` replays on reconnect via JetStream, offline `chat` does not. A second test proves `permission_verdict` and `task_result` always retain valid `in_reply_to`.
- **AC7 (presence hybrid):** test harness drops `$SYS` stream and proves heartbeat-only path still marks peers correctly; stale heartbeat scenario proves offline state from TTL expiry overrides any cached `$SYS` CONNECT impression.
- **AC8 (nats.js v3):** dependency-check test or lockfile check ensures `@nats-io/transport-node`, `@nats-io/jetstream`, `@nats-io/kv` are present and no monolithic `nats` package is used in transport package manifests.
- **AC9 (no KV TTL lease + KV known-issues handled):** executable tests, not prose. (a) A dedup/CAS test proves suppression is keyed on KV revision/CAS, NEVER on TTL expiry (grep-assert no `ttl`/expiry field drives correctness in the dedup module). (b) A `history=1` test proves the watcher path tolerates a silently-skipped revision (a consumer re-reads current revision via `get` and does not assume every revision is observed via `watch` — mitigates #4643/#4710/#4803). (c) A stale-holder reclaim test drives a holder past its heartbeat and proves reclamation via revision-staleness CAS (a losing CAS is retried/failed explicitly, never silently). No "documents a defer point" escape hatch — each is a passing test in Phase 3.
- **AC10 (no leafnodes + no request-info trust):** config-scanner test (`packages/operations/nats/nats-config.test.ts`) asserts the shipped `packages/operations/nats/nats-server.conf` contains no `leafnodes` block; a peer-agent test asserts no runtime auth/identity flow reads `Nats-Request-Info` as a trust source.
- **AC11 (app-side envelope-subject ACL):** executable tests reproducing the relay chokepoints app-side — publisher-not-owner rejected, recipient-not-owner rejected, `subject != null && in_reply_to != null` rejected, subjected `presence_update`/`permission_request`/`permission_verdict` rejected, `subject != null && to == @team` rejected; sender identity taken from the authenticated `fleet.<handle>.>` subject (AC2b), never envelope `from`. The single shared `namespaceOf`/`ownsNamespace`/`matchesInterest` matcher remains the only implementation.

### Coverage-gate disposition

- Shared coverage remains 95%; peer-agent coverage remains 80%; tests covering channel serialization, six-kind invariants, and anti-injection behavior stay under peer-agent/shared packages.
- Relay coverage is kept to 85% while relay exists in phased rollout for parity checks, then removed from active test set in Phase 5 as transport is retired.
- New NATS transport and protocol tests are placed in a dedicated e2e or new test package that does not carry shared numeric coverage gates.
- No threshold lowering is permitted at any gate.

## 6. Risks + inversion

- **What guarantees failure of AC2b:** if peer-agent trusts envelope `from`, a compromised peer can forge sender identity within its ACL namespace. The inversion gate is the explicit reject/rewrite test in AC2b.
- **What guarantees failure of AC6:** if kind matrix omits a kind or misroutes one lane, delivery invariants or backfill semantics drift; inversion check is matrix exhaustiveness and replay-path tests.
- **What guarantees failure of AC5:** if KV is treated as TTL cache, duplicate tasks can re-dispatch after timeout; inversion check is replay test beyond `Nats-Msg-Id` window.
- **What guarantees failure of AC7:** if `$SYS` events are treated as ground truth, a missed event causes permanent presence poisoning; inversion check is `$SYS`-dropped/stale-heartbeat test.
- **What guarantees failure of AC10:** if leafnode is configured or `Nats-Request-Info` is trusted, federation threat model becomes implicit. Inversion check is config scan and runtime header-trust review.

## 7. Out of scope

- Core arbitration protocol (capability negotiation, priority/interruption negotiation, offer/counter-offer rounds, binding allocation semantics) is out-of-scope as a protocol to be authored later. This plan only creates the substrate: KV/CAS, request-reply transport, and namespace-safe transport path.
- Leafnode federation is deferred and blocked by AC10 until a separate threat-model and identity plan is approved.
- nsc/JWT full auth machinery is out-of-scope; static NKeys are accepted for fixed 2–5 host fleet.
- Multi-node JetStream clustering is out-of-scope; AC1 fixes single-node R1 for this phase.
- **Audit-replay / message-history tooling** on top of JetStream is out-of-scope; the task stream is strict `WorkQueuePolicy` (Phase 2). A future durable-history stream is a separate plan.

## 8. Open questions (Board only)

- Subject-namespace granularity: keep `fleet.<handle>.>` as the sole transport prefix (this plan's assumption), or introduce per-kind suffixes (`fleet.<handle>.task.>`, `fleet.<handle>.chat.>`) for finer NATS-side ACLs? (Deferred; the envelope-subject ACL — AC11 — already gives per-namespace authority app-side, so this is an optimization, not a correctness gap.)
- Cutover sequencing across the live fleet: big-bang vs. per-host rolling (both hosts must agree on transport per envelope). Operational judgment for the Board at Phase 5.

_(Resolved and folded into the plan: NKey secret storage + rotation → Phase 0; JetStream retention = strict WorkQueue → Phase 2; audit-replay → §7 out-of-scope.)_

## Review log

- **R0 author (gpt-5.3-codex-spark, hetero dispatch):** drafted from the survey findings + `docs/VISION.md` + `docs/architecture.md` + `SUBJECT_ROUTING_SPEC.md` + `CLAUDE.md`. Brief itself was spec-reviewed (g55xh, 6 blocking) before dispatch — folding in AC2b (subject-derived `from`), AC6 six-kind matrix, AC9 no-KV-TTL-lease, AC10 no-leafnodes, `channel.ts` escaping preservation.
- **R1 (g55xh loop-review, gpt-5.5 xhigh): VERDICT REVISE, 7 blocking.** Fixed all 7: (1) envelope-subject ACL cannot move to NATS config (NATS can't see `Envelope.subject`) → added **AC11** app-side subject-ACL with publisher/recipient-owner + direct-only + reactive-kind tests, corrected the retirement boundary + §2.5; (2) `peers-file.ts` no longer listed in both columns; (3) added the concrete `packages/operations/nats/nats-server.conf` + `nats-config.test.ts` to the file map as the load-bearing config artifact; (4) AC2 now a named NKey-only config test (no password/token fallback, exact `fleet.<handle>.>` allow); (5) AC9 KV known-issues (#4643/#4710/#4803, `history=1`) are executable tests, removed the "documents a defer point" escape hatch; (6) Phase 2 `in_reply_to` corrected — required only on `permission_verdict`/`task_result`, not `permission_request`; (7) resolved the load-bearing open questions (NKey secret storage+rotation → Phase 0; JetStream retention = strict WorkQueue → Phase 2; audit-replay → §7 out-of-scope). Non-blocking confirmations: AC2b anti-spoof + §7 deferrals were assessed satisfied.
