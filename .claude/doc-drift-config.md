# Doc-Sync — Project Config (hangar-bridge)
# Domains autopilot:doc-sync audits. Scoped mode only audits domains whose code the diff touched.

## Domains

### readme-overview
docs:  README.md
code:  packages/shared/src/, packages/relay/src/, packages/peer-agent/src/, package.json
focus: package roles, MCP tool names (send_to_peer/dispatch_task/list_peers/...), routes list, status/phase claims, test counts

### subject-routing
docs:  SUBJECT_ROUTING_SPEC.md
code:  packages/relay/src/, packages/shared/src/
focus: envelope kinds (chat/presence_update/permission_request/permission_verdict/task_dispatch/task_result), routing/subject semantics, what is implemented vs spec'd

### project-isolation
docs:  docs/PROJECT_ISOLATION.md, docs/plans/2026-06-25-cross-project-isolation.md
code:  packages/operations/, packages/peer-agent/src/, packages/relay/src/
focus: same-box cross-project isolation — name auto-derivation, collision gate, unique server name, peers-file checks

### contributor-guide
docs:  CLAUDE.md
code:  packages/, package.json, .claude/
focus: commands, coverage thresholds (shared 95 / relay 85 / peer-agent 80), invariants, what-not-to-do list — must match reality

## Deterministic gate (Layer 1)
gate_command: node <autopilot>/scripts/doc-drift-gate.js .   # links + fences baseline; extend as drift classes are found

## Staleness threshold
staleness_days: 30

## Fix policy
- README / CLAUDE.md / env examples → always correct to current code reality.
- SUBJECT_ROUTING_SPEC.md: design-target-not-yet-built → keep + mark "NOT YET IMPLEMENTED" + open a BACKLOG item.
