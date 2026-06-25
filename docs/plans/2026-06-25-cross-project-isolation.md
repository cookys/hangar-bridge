# Plan — Same-box cross-project isolation (handle-per-project)

> **Status:** ✅ PASS — g55xh (gpt-5.5 xhigh) loop-review converged at R6 (blocking 5→3→2→2→1→0). Ready for implementer.
> **Owner:** cookys (Board) · plan authored by Claude (hangar session)
> **Repo / Branch:** `cookys/hangar-bridge` · base `main` · impl branch `feat/cross-project-isolation`
> **Frame:** operationalize the SUBJECT_ROUTING_SPEC §12.1 "non-goal" into a real, ergonomic feature

## 0. Context / thesis

The subject-routing + fail-closed namespace ACL shipped (schema v5, `99daa5d`) is a
**cross-box** namespace gate. It deliberately does **NOT** solve **same-box
cross-project isolation** — `SUBJECT_ROUTING_SPEC.md` §12.1 / §12.2 name this an
explicit non-goal and accepted residual, and point to the intended fix:

> "Same-box cross-project isolation — handled by project-scoped `.mcp.json` + a
> dedicated `HANGAR_CONFIG_DIR`/handle per project, NOT by this ACL."

The enabling primitive is **already implemented**: `paths.ts:configDir()` honours
`$HANGAR_CONFIG_DIR`, and `cli/init.ts:runInit()` already writes secret + config to
that dir and prints the relay `peers.json` entry. What is missing is (a) the
**project-scoped MCP registration** (today registration is global-only, `~/.claude.json`,
with no `HANGAR_CONFIG_DIR` env) and (b) an **ergonomic one-shot provisioning command**
that ties config-dir + handle derivation + `.mcp.json` writing together. This plan
delivers exactly those two, plus docs — no relay code change.

## 1. Problem

**The context-pollution defect (`SUBJECT_ROUTING_SPEC.md` §, "by handle only"):**
routing identity is the **host handle**. `fanout.deliver()` for a direct message to
a host iterates **every** subscriber (every Claude Code session on that box). So a
session working on project A receives dispatches/messages addressed to project B on
the same host. Verified live: `fanout.ts` `deliver()` loops the whole `Set<Subscriber>`
for `e.to`; the only per-stream gate (`accept`) is keyed on the authenticated **handle**
(host) and is a no-op for `subject === null` (legacy fan-out).

**User goal:** a project running on a shared host is a **distinctly addressable
identity**, so messages to project A never enter project B's session context — an
enforced boundary, not cooperative noise-reduction.

**Why handle-per-project needs no relay change (verified delivery path):** the bearer
secret is mapped to `peer.handle` in auth (`auth/middleware.ts:67-92`); publishing stamps
`from` from that authenticated peer (`routes/messages.ts:68-78`); streams subscribe under the
authenticated handle (`routes/stream.ts:36-74`); and DMs deliver only to `byHandle.get(e.to)`
(`fanout.ts:61-68`). So a distinct project secret → distinct handle → distinct stream bucket,
with zero relay `src/` edits.

## 2. OKR / KRs

- **O:** Two Claude Code sessions on the same host, in different projects, never
  receive each other's directed traffic.
- **KR1:** `hangar-bridge init-project <name> --relay <url>` (the CLI bin is `hangar-bridge`,
  per `packages/peer-agent/package.json:6`; `init-project` is a new sibling of the existing
  `init`/`respond`/`send` subcommands in `cli.ts`) provisions a project identity
  (`<hostname>-<name>` handle) in one command — it COMPUTES the project config dir
  (`${root}/projects/<name>`), writes secret+config there, writes the project `.mcp.json`,
  and emits the relay `peers.json` line. (`--config-dir <abs>` overrides the computed dir.)
- **KR2:** Launching `claude` inside project A's repo connects the peer-agent under
  handle `<host>-A`. Observable: from that session, a `set_summary`/presence write (or any
  `send_to_peer`) makes the relay reflect handle `<host>-A` — i.e. `list_peers` shows `<host>-A`
  online **after the presence POST**, or a sent message is relay-stamped `from: <host>-A`.
  (NOTE: stream-open alone does NOT set `online` — `/v1/peers.online` is fed only by
  `POST /v1/presence` (`relay/routes/peers.ts:28-36`, `relay/routes/presence.ts:23-25`).)
- **KR3:** A `dispatch_task`/`send_to_peer` to `<host>-A` is delivered ONLY to project
  A's session(s); project B's session on the same host does not receive it
  (integration test, relay-level).
- **KR4:** Zero regression for hosts that do NOT opt in — the bare host handle keeps
  working exactly as today (global `~/.claude.json` path unchanged when no project
  `.mcp.json` is present).

## 2.5 Global Constraints (copied verbatim into every dispatch)

- Target repo `cookys/hangar-bridge`, base branch **`main`** (NOT `develop`).
- **NO relay `src/` changes** in this plan — relay already supports arbitrary handles via
  `peers.json`. Touch scope: `packages/peer-agent/**` + docs + **one relay TEST-only file**
  under `packages/relay/tests/**` (KR3 e2e guard). No file under `packages/relay/src/**`.
- The bearer secret is **43-char URL-safe base64** (`randomBytes(32).toString('base64url')`);
  never `openssl rand -hex`. Relay gate: `/^Bearer [A-Za-z0-9_-]{43}$/`.
- **Identity authority = secret → `peers.json` key.** `config.json` has no authoritative
  `self_handle`; do not introduce one as the identity source.
- Handle derivation default = `${os.hostname()}-${project}`, lowercased, non-`[a-z0-9_-]` → `-`,
  collapse repeated `-`. The result MUST satisfy `HANDLE_REGEX = /^[a-z][a-z0-9_-]{0,31}$/`
  (`shared/src/constants.ts:8`, enforced on `peers.json` keys at `relay/auth/peers-file.ts:20`):
  if the first char is not `[a-z]`, prefix `h`; truncate to 32 chars. If it still cannot match
  (e.g. empty after sanitising), **fail with a clear error suggesting explicit `--handle`** rather
  than emitting an invalid key. Caller may always override with `--handle` (also `HANDLE_REGEX`-validated).
- **`HANGAR_CONFIG_DIR` is the EXACT config directory, NOT a root** — `paths.ts:configDir()`
  returns it verbatim (`paths.ts:12-15`) and `runInit` writes `secret`/`config.json`/`audit/`
  directly under it (`cli/init.ts:25-47`). Therefore `init-project <name>` COMPUTES the project
  dir = `${root}/projects/<name>` (root = `$XDG_CONFIG_HOME/hangar-bridge` or `~/.config/hangar-bridge`)
  and sets `process.env.HANGAR_CONFIG_DIR` to that exact dir for the `runInit` call. An explicit
  `--config-dir <abs>` overrides the computed value (used verbatim, no `projects/` suffix added).
- **File modes — `init-project` sets them explicitly; do NOT claim `runInit` already does.**
  `runInit` only chmods the secret `0600` (`cli/init.ts:36-37`); it creates dirs with no mode
  (`:25-27`) and writes `config.json` with no mode (`:47`). So `init-project` MUST, after `runInit`:
  `chmod 700` the project config dir + its `audit/`, and `chmod 600` the `config.json`. Secret is
  already `0600` from `runInit`.
- **Node ≥ 22** (`package.json` `engines: node >=22`) / TypeScript ESM with `.ts` import specifiers.
- Every new behaviour has a vitest test; do not lower coverage. Build = `corepack pnpm -r build`,
  test = `corepack pnpm -r test`, both green before done.

## 3. File-structure map

| File | Change | Responsibility |
|---|---|---|
| `packages/peer-agent/src/mcp-registration.ts` | **extend** | Add `writeProjectMcpJson({ dir, configDir })`. The server entry MIRRORS `ensureMcpRegistered`'s exact shape (`mcp-registration.ts:14-18`): `command: process.execPath`, `args: [resolve(join(here, 'index.js'))]` (`here = dirname(fileURLToPath(import.meta.url))`), and ADDS `env: { HANGAR_CONFIG_DIR: <abs configDir> }`. It writes/merges `${dir}/.mcp.json` `mcpServers["hangar-bridge-peers"]`. The existing global `ensureMcpRegistered` (writes `~/.claude.json`, no env) stays untouched. |
| `packages/peer-agent/src/cli.ts` | **extend** | Add `init-project <name>` subcommand: resolve project config dir + derive handle, run `runInit` against that dir (via `HANGAR_CONFIG_DIR`), then call the project-scoped registration writer. Reuse `argValue`. |
| `packages/peer-agent/src/cli/init-project.ts` | **new** | Orchestrator for `init-project`: compute config dir + handle (Global Constraints), set/scope `HANGAR_CONFIG_DIR`, call `runInit`, write `.mcp.json`, print the relay `peers.json` line + the "restart relay" reminder. |
| `packages/peer-agent/src/cli/init.ts` | **read-only ref** | Unchanged. `runInit` already honours `configDir()` → `HANGAR_CONFIG_DIR`; `init-project` reuses it verbatim. |
| `packages/peer-agent/src/paths.ts` | **optional helper only** | If convenient, add `configRoot()` (XDG-or-home root, no `HANGAR_CONFIG_DIR`) and `projectConfigDir(name)` = `${configRoot()}/projects/<name>`. Pure refactor — do NOT change `configDir()`'s existing env precedence. Skippable if `init-project` computes the path inline. |
| `packages/peer-agent/src/cli/init-project.test.ts` | **new** | Unit: handle derivation, config-dir resolution, `.mcp.json` shape (`env.HANGAR_CONFIG_DIR` absolute), secret/peers-line emission. |
| `packages/relay/tests/integration/cross-project-isolation.test.ts` | **new** | Integration (KR3): two handles `box-a` / `box-b` seeded; a direct message to `box-a` reaches only `box-a`'s stream, not `box-b`'s. Mirrors existing `subject-acl.test.ts` harness. |
| `docs/PROJECT_ISOLATION.md` | **new** | The pattern: when to use, `init-project` walkthrough, relay-side step, `list_peers` verification, reinstall discipline. |
| `SUBJECT_ROUTING_SPEC.md` | **edit §12.1/§12.2** | Flip the "non-goal / accepted residual" note to "implemented — see `docs/PROJECT_ISOLATION.md`" (keep the breadcrumb; the ACL itself is still cross-box only). |
| `README.md` | **edit** | One row/line pointing at `docs/PROJECT_ISOLATION.md` under usage. |

## 4. Phases

### Phase 0 — SPIKE: prove Claude Code applies project `.mcp.json` env + same-name precedence (size: Fix, GATING)
The whole design rests on: (a) a project-scoped `.mcp.json` `env` block actually reaches the
spawned peer-agent process, and (b) a project server named `hangar-bridge-peers` takes precedence
over (or is the one used vs) a global `~/.claude.json` server of the same name. This is verified
ON-DEVICE before any other phase — do not assume it.
- **Setup (exact):** `D=$(mktemp -d)`; `C=$(mktemp -d)`. Write `$C/config.json` =
  a valid peer-agent config (`relay_url` to the live relay `http://192.168.101.6:8443`, `token_path`
  → a real provisioned secret in `$C/secret`, presence on) + the secret (43-char base64url),
  registered on the relay under a throwaway handle `spike-proj`. Write `$D/.mcp.json` with
  `mcpServers["hangar-bridge-peers"] = { command: process.execPath, args:[<abs dist/index.js>],
  env: { HANGAR_CONFIG_DIR: "$C" } }`. Leave the global `~/.claude.json` host entry as-is.
- **Probe — BOTH, in order. Probe 2 is the mandatory gate (Probe 1 alone does NOT prove the
  assumption — it only re-checks the already-proven `configDir()` primitive at `paths.ts:12-15`):**
  1. _Primitive precheck (necessary, not sufficient):_ `cd $D && HANGAR_CONFIG_DIR=$C
     <abs bin/peer-agent.sh>` fed an MCP `initialize` + a `set_summary` call on stdin → expect
     serverInfo + stderr `peer.startup` whose `relay_url` came from `$C/config.json`, and the relay
     `list_peers` then shows `spike-proj` **online** (presence write; stream-open alone would NOT —
     see KR2 note). Proves the peer-agent honours `HANGAR_CONFIG_DIR`. **This is a precheck only.**
  2. _**MANDATORY GATE — the actual assumption:**_ launch real Claude Code in `$D` WITHOUT setting
     `HANGAR_CONFIG_DIR` in the shell — `cd $D && claude --dangerously-load-development-channels
     server:hangar-bridge-peers` (the `server:<name>` channel selector is REQUIRED — `README.md:590-593`;
     without it channel notifications are skipped, `README.md:596-599`; the e2e driver uses it,
     `packages/e2e/src/claude-driver.ts:24`). If the fallback per-project server name is chosen, the
     selector becomes `server:hangar-bridge-peers-<proj>` (propagate to docs + smoke). The only source
     of the env is the project `.mcp.json`. Trigger a presence/`set_summary` write
     from that session and assert the relay reflects **`spike-proj`** (online via presence, or
     `from`-stamp on a sent message), NOT the bare host handle. This proves Claude Code (a) applied
     the project `.mcp.json` `env` AND (b) used the project server over the global same-name entry.
     Phase 1 MUST NOT start until Probe 2 passes (or its fallback is chosen).
- **Acceptance / decision gate:** if the project `.mcp.json` server connects under `spike-proj`
  (project handle), the design holds → proceed. **If it does NOT** (env dropped, or global same-name
  server wins) → trigger the FALLBACK recorded for Phases 1-2: use a **distinct server name per
  project** (`hangar-bridge-peers-<proj>`) so there is no collision with the global entry; update
  `writeProjectMcpJson` + `init-project` to take the server name. Either way, Phase 0's outcome is
  recorded in the Review log before Phase 1 starts.
- Tear down: remove the `spike-proj` relay entry + restart, `rm -rf $D $C`.

### Phase 1 — Project-scoped MCP registration writer (size: L)
- In `mcp-registration.ts`, add `writeProjectMcpJson({ dir, configDir })`: writes/merges
  `${dir}/.mcp.json` with `mcpServers["hangar-bridge-peers"] = { command: process.execPath,
  args: [resolve(join(here, 'index.js'))], env: { HANGAR_CONFIG_DIR: <abs configDir> } }` —
  the `command`/`args` derivation copied EXACTLY from `ensureMcpRegistered` (`mcp-registration.ts:14-18`;
  `here = dirname(fileURLToPath(import.meta.url))`), only `env` added. If `${dir}/.mcp.json`
  exists, parse it and set just the `mcpServers["hangar-bridge-peers"]` key (do not clobber
  other servers); if absent, create `{ "mcpServers": { ... } }`.
- **Acceptance:** unit test writes to a tmp dir, asserts JSON has `command === process.execPath`,
  `args[0]` ends with `index.js` (absolute), and `env.HANGAR_CONFIG_DIR` is the absolute dir passed;
  a pre-existing unrelated server key in a seeded `.mcp.json` survives the merge.

### Phase 2 — `init-project` CLI orchestrator (size: L)
- `cli/init-project.ts`: parse `<name>` + `--relay <url>` (fallback `$HANGAR_RELAY`) +
  optional `--handle` / `--config-dir` / `--dir <project-root, default cwd>` / `--force`.
  **Validate `<name>` first:** reject any name containing a path separator (`/`, `\`) or `.`/`..`
  segments before it is interpolated into `${root}/projects/<name>` (no path traversal); require
  `<name>` to match `^[A-Za-z0-9._-]+$` minus `.`/`..`, else exit 2 with a clear message.
  Compute config dir + handle per §2.5; set `process.env.HANGAR_CONFIG_DIR` to the project
  config dir; run `runInit({ relayUrl, handle, force })`. Then **explicitly set modes** (§2.5):
  `chmodSync(projectDir, 0o700)`, `chmodSync(join(projectDir,'audit'), 0o700)`,
  `chmodSync(join(projectDir,'config.json'), 0o600)` (secret already 0600 from `runInit`).
  Then `writeProjectMcpJson({ dir: projectRoot, configDir: projectDir })`. Print: secret path,
  the `peers.json` line (from `runInit`'s return), and the relay-restart reminder.
- Wire into `cli.ts` `init-project` branch. `argValue` is currently a private helper in `cli.ts:7-10`;
  **export it** (or lift it to a tiny `cli/args.ts`) and import it into `init-project.ts` — do NOT
  duplicate a second parser. Usage string on missing args, exit 2.
- **Acceptance:** with `HANGAR_CONFIG_DIR` unset and `XDG_CONFIG_HOME` pointed at a temp dir (so the
  test never writes under the real home), `hangar-bridge init-project foo --relay http://x:8443 --dir <tmp>`
  creates `<root>/projects/foo/{secret(0600),config.json(0600),audit/(0700)}`, dir mode `0700`,
  + `<tmp>/.mcp.json` with `env.HANGAR_CONFIG_DIR = <root>/projects/foo`, prints
  `"<host>-foo": { "secret_sha256_hex": ... }`. Existing `init` path unaffected (regression test).

### Phase 3 — Relay-level isolation integration test (size: L)
- `cross-project-isolation.test.ts`: seed `peers.json` with `box-a` + `box-b`, open two SSE
  streams, POST a direct `chat` (null-subject) to `box-a`, assert only `box-a`'s stream receives
  it and `box-b`'s does not. NOTE: `Fanout.deliver()` already routes a DM only to `byHandle.get(e.to)`
  (`fanout.ts:61-68`) and `fanout.test.ts:21-28` already unit-covers single-recipient routing — so
  this is an **end-to-end guard** over the auth→stream→store→fanout path for KR3, not the first proof
  of fanout behaviour.
- **Acceptance:** test green; fails if a future change makes `fanout` cross-deliver between handles.

### Phase 4 — Docs + spec reconciliation (size: Fix)
- Write `docs/PROJECT_ISOLATION.md`; flip `SUBJECT_ROUTING_SPEC.md` §12.1/§12.2 notes to
  "implemented" + breadcrumb; add README pointer.
- **Acceptance:** `docs/PROJECT_ISOLATION.md` walkthrough commands match the actual `init-project`
  flags (no drift); spec no longer calls it an unsolved non-goal.

**Dependency map:** **P0 GATES everything** (its outcome may flip Phases 1-2 to per-project server
names). P1 → P2 (P2 calls P1's writer). P3 independent of P0/P1/P2 (relay test-only, can run in
parallel). P4 after P0+P1+P2 (docs must match shipped flags + the P0 server-name decision).

## 5. Test / validation

- **Script-gated:** `corepack pnpm -r build` + `corepack pnpm -r test` green (incl. the 3 new tests).
- **Script-gated:** `.mcp.json` shape assertion (Phase 1 test) + `init-project` end-to-end (Phase 2 test).
- **Human-gated (驗收, Board):** a real two-project smoke on one host — provision `<host>-proj1`,
  launch `claude` in two repos, confirm `list_peers` shows the project handle and a `dispatch_task`
  to one project does not surface in the other's session. (Manual; not in CI.)

## 6. Risks + inversion

- **What guarantees failure:** Claude Code does not actually apply project-scoped `.mcp.json`
  `env`, or a project `.mcp.json` server does not override the global `~/.claude.json` server of
  the same name. → **Mitigation/spike:** this is exactly **Phase 0 Probe 2** — the gating on-device
  check (real Claude launch in `$D`, no shell `HANGAR_CONFIG_DIR`, asserting the project handle
  reaches the relay), which MUST pass before Phase 1. If precedence is additive-not-override, fall
  back to a distinct server NAME per project (`hangar-bridge-peers-<proj>`).
- **Secret sprawl:** N projects × M hosts secrets/peers.json entries; each new project needs a relay
  restart (drops all SSE briefly). → Documented in PROJECT_ISOLATION.md; batch provisioning; out of
  scope to auto-hot-reload the relay.
- **Handle collision:** `runInit` does NOT detect handle collisions — it only refuses to overwrite an
  existing `secret` in the *current* config dir (`cli/init.ts:25-33`) and stores no handle
  (`:39-47`). So: (a) re-running for the SAME `<name>` is safe-by-default because it targets the same
  `projects/<name>` dir → `runInit` blocks without `--force`; but (b) two DIFFERENT names that sanitise
  to the same handle are NOT auto-caught. Mitigation: `init-project` prints the derived `peers.json` key
  prominently and `PROJECT_ISOLATION.md` instructs the operator to confirm the key is unused before
  adding it + restarting the relay. Optional hardening (in scope if cheap): if the relay's `peers.json`
  is locally readable, `init-project` reads it and aborts on a duplicate key before emitting anything.
- **Inversion check (correct tripwire mapping):** the env-dropped / handle-reused risk lives in the
  project MCP registration + peer-agent config selection (`mcp-registration.ts`, `paths.ts:12-15`), so
  its tripwires are **Phase 0 Probe 2** (Claude actually applies project `.mcp.json` env + precedence)
  and the **Phase 2** `.mcp.json`/`HANGAR_CONFIG_DIR` unit test. **Phase 3 is NOT this tripwire** —
  it only guards relay delivery-bucket isolation (two seeded handles) and would stay green even if
  project registration were broken.

## 7. Out of scope (focus-as-subtraction)

- **Approach A — per-session interest auto-derivation** (one host handle, narrow subjected delivery by
  cwd/repo): a *noise-reduction* layer, NOT an isolation boundary (fail-open per `inbound.ts`;
  null-subject/@team still floods). `SUBJECT_ROUTING_SPEC` already adjudicated this fork toward
  handle-per-project. Deferred; may return as a separate enhancement.
- **Relay hot-reload of `peers.json`** (avoid restart per new project).
- **Auto-deriving the project handle from the git repo** without an explicit `init-project` step.
- **Any relay schema / fanout / ACL change.**

## 8. Open questions (Board only)

- Naming: `init-project` vs extending `init --project`? (Plan assumes new subcommand for clarity;
  Board may prefer the flag.)
- Should the global `~/.claude.json` host-handle entry be auto-removed on a box that goes
  fully project-scoped, or always kept as the "host-wide" fallback? (Plan keeps it — KR4.)

## Review log

- **R0 (author):** Claude, hangar session, 2026-06-25. Grounded on live reads of `fanout.ts`,
  `stream.ts`, `inbound.ts`, `acl.ts`, `routes/messages.ts`, `paths.ts`, `cli/init.ts`, `cli.ts`,
  and `SUBJECT_ROUTING_SPEC.md` §12. Engines/preconditions verified: `codex` 0.142.0, `agy` 1.0.12,
  model "Gemini 3.5 Flash (High)" present; base branch `main`.
- **R1 (g55xh loop-review, gpt-5.5 xhigh):** VERDICT FAIL, 5 blocking. Fixed all 5: (1) §2.5 file-mode
  claim corrected — `init-project` now explicitly chmods dir/audit/config (runInit only does secret);
  (2) §2.5 scope now allows one relay TEST-only file; (3) Phase 1 registration shape pinned to
  `ensureMcpRegistered`'s exact `process.execPath`+`index.js` derivation + added `env`; (4) `HANGAR_CONFIG_DIR`
  clarified as exact-dir (not root), KR1/§2.5/Phase 2 made consistent; (5) added gating **Phase 0 spike**
  with exact commands + per-project-server-name fallback trigger. Also folded in non-blocking citations
  (delivery-path proof in §1, Phase 3 reframed as e2e guard). Design assessment: PASS (handle-per-project
  is the right boundary; per-session-interest insufficient).
- **R2 (g55xh, gpt-5.5 xhigh):** VERDICT FAIL, 3 blocking. Fixed: (1) Node floor ≥20→**≥22** (matches
  `package.json` engines); (2) invalid observable — `list_peers.online` comes from presence POST not
  stream-open; KR2 + Phase 0 now verify identity via a `set_summary`/presence write or `from`-stamp;
  (3) handle derivation now validates against `HANDLE_REGEX /^[a-z][a-z0-9_-]{0,31}$/` (leading-letter
  prefix, 32-char truncate, fail-with-`--handle`-hint). Non-blocking: Phase 2 test sets `XDG_CONFIG_HOME`
  to temp. Design assessment: PASS.
- **R3 (g55xh, gpt-5.5 xhigh):** VERDICT FAIL, 2 blocking. Fixed: (1) Phase 0 Probe 2 (real Claude
  launch proving project `.mcp.json` env + same-name precedence) is now the MANDATORY gate; Probe 1
  demoted to primitive precheck; Phase 1 blocked until Probe 2 passes. (2) §6 inversion tripwire
  corrected — env/handle risk is caught by Phase 0 Probe 2 + the Phase 2 unit test, NOT Phase 3
  (which only guards relay delivery buckets). Both non-blocking items were confirmations (design +
  primitives verified). Design assessment: PASS.
- **R4 (g55xh, gpt-5.5 xhigh):** VERDICT FAIL, 2 blocking. Fixed: (1) CLI bin name — `peer-agent`→
  **`hangar-bridge`** (`package.json:6`), `init-project` is a sibling of `init`/`respond`/`send`; (2)
  false handle-collision mitigation replaced with the real behaviour (`runInit` only blocks same-dir
  secret overwrite; cross-name handle collisions are operator-confirmed via the printed key + optional
  relay `peers.json` read). Non-blocking: `paths.ts` marked optional-helper; §6 stale "Phase 2 spike"
  ref repointed to Phase 0 Probe 2. Design assessment: PASS.
- **R5 (g55xh, gpt-5.5 xhigh):** VERDICT FAIL, 1 blocking. Fixed: Phase 0 Probe 2 Claude launch now
  includes the REQUIRED `server:hangar-bridge-peers` channel selector (`README.md:590-593`; e2e driver
  `claude-driver.ts:24`), with the fallback `server:hangar-bridge-peers-<proj>` propagated. Non-blocking:
  `argValue` to be exported/lifted from `cli.ts:7-10` (not duplicated). Design assessment: PASS.
- **R6 (g55xh, gpt-5.5 xhigh): VERDICT PASS.** 0 blocking. Folded the one non-blocking: `init-project`
  validates `<name>` against path traversal (`/`,`\`,`.`,`..`) before interpolation. Design assessment:
  PASS — handle-per-project is the right enforced-isolation boundary; per-session-interest correctly
  deferred. **Plan ready for agy (Gemini 3.5 Flash High) implementation.**
