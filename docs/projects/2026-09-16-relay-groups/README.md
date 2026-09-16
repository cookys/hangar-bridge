# relay groups — project tracking

Plan: [`docs/plans/2026-09-16-relay-groups.md`](../../plans/2026-09-16-relay-groups.md) (REVIEWED r4, Fable 5.1 plan loop ×4).
Branch: `feat/relay-groups`. Mode: `/l5` — one sealed campaign per phase, merged `--no-ff` in order.

| Phase | Campaign | Implementer | Status |
|---|---|---|---|
| P0 types / schema v10 / peers v2 / groups.ts | `campaign-p0/` | codex gpt-5.5 | in flight |
| P1 relay enforcement + adversarial harness | `campaign-p1/` | — | pending |
| P2 peer-agent + `bin/fleet` | `campaign-p2/` | — | pending |
| P3 migration tool / rollout / hangar docs | `campaign-p3/` | — | pending |

Consult (2026-09-16, `dispatch-consult.sh`, resolved native sonnet — grok balance exhausted): codex for all
phases (agy no-ops on >40-line briefs, cannot run tests), one campaign per phase, adversarial harness written
by depth-0 BEFORE P1 and included in `verify_cmd`.
