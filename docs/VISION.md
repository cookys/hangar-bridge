# hangar-bridge — role in the fleet (pointer)

> The fleet vision that used to live here was **promoted to `cookys/fuchikoma`** on 2026-06-27
> (`docs/VISION.md`, `docs/RISKS.md`, `docs/ROADMAP.md` there are the source of truth). This copy
> had drifted for two months (still described a "budget-bounded local-LLM self-loop" the K5 probe
> falsified on 2026-07-02). It is now a role pointer only, so it cannot drift again.

## What hangar-bridge is, in that vision

- **Organ:** the autonomic nervous system — cross-machine messaging between fleet principals
  (fuchikoma `docs/VISION.md` §2 organ table).
- **What it is not:** the resource-arbitration fabric §3 imagines. What got built (2026-08) is a
  **messaging** substrate: fleet-identity v2.1 (durable `<host>-<project>` handle + per-process
  instance id, `poll_inbox` durable pull) and the Agent Call final-mile ingress. Arbitration
  primitives remain undecided (fuchikoma `docs/RISKS.md` ②).
- **Trust rules it enforces:** every envelope is `authority: peer`; peer text never authorizes;
  receipts are never upgraded past "transport accepted". These are load-bearing for fuchikoma's
  acceptance-delegation ladder (verifier isolation) and are documented here, in `SECURITY.md` and
  `docs/architecture.md`.

## Where to read more

| Question | Where |
|---|---|
| Why does the fleet exist, what is L0→L3 | fuchikoma `docs/VISION.md` |
| What gates full autonomy | fuchikoma `docs/RISKS.md` |
| What is being built next, and the ladder | fuchikoma `docs/ROADMAP.md`, `docs/ladder/state.md` |
| This repo's current state as the fleet sees it | fuchikoma `docs/PORTFOLIO.md` § hangar-bridge |
| How a message actually travels | `docs/architecture.md` (this repo) |
