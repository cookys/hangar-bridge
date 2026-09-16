# P0 campaign ledger

- campaign `relay-groups-p0b`, base `8a68351`, branch `feat/relay-groups-p0`, implementer codex gpt-5.5 high
  (`REVIEW_LOOP_CONFIG_OVERRIDE`, see project README), reviewer MiniMax-M3 xhigh.
- codex commit `9f4d3e1` — 13 files, +913/−52, all inside `allowed_path_prefixes`.
- **Engine campaign ended TERMINAL_STOP** with `cannot apply review_completed while campaign is VERTICAL_VERIFICATION`:
  `campaign_verification` failed in 1.4 s because the engine runs `verify_cmd` in a FRESH detached worktree
  (no `node_modules`, no `packages/shared/dist`) — infra, not code; the engine then still ran the review and
  its state machine refused the transition. Reported to the autopilot session (aimax395).
- Review r1 (MiniMax): FIX-THEN-SHIP, 8 MUST-FIX of which 5 self-retracted in the same text. Depth-0
  dispositions: `backfill-not-guarded-by-team` → accept, fixed `679e20f` (+ test); `v10-claim-rebuild-assert`
  (unique index across groups) → accept-defer-to-P1: codex added it because `claims/store.ts` upserts
  `ON CONFLICT(team_id, claim_key)` and store.ts is outside P0 scope; P1 rescopes claims and drops it (commented
  in code); `store-grep-test-flaky` → accept as Minor, left for P1 (P1 touches store.ts and will harden the guard).
- Depth-0 infra: `scripts/verify-groups.sh` bootstraps deps + builds shared (`679e20f`, `f840ee8`); proven in a
  fresh detached worktree (rc 0, 157 + 429).
- **Red-on-base proven**: the six test files checked out onto base `8a68351` → 7 shared + 26 relay failures.
- Review r2 (MiniMax, full diff `8a68351..f840ee8` + spec): **SHIP-AS-IS**, `review-r2-minimax-ship-as-is.json`.
- Merge decision: depth-0, on r2 verdict + fresh-worktree verify + red-on-base evidence.
