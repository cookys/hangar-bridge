# Model routing — hangar-bridge (operator-mandated, 2026-09-04)

Read by `autopilot/scripts/resolve-dispatch.sh` (first matching row wins).
Tree-table roles are prefixed `tree:`. Fable (this session model) is never a
dispatch target; every Agent/leaf dispatch names its model explicitly.

| Role | Model | Mode | Notes |
|------|-------|------|-------|
| tree:sub-orchestrator | sonnet | default | foreman for /l4–/l6 runs (operator: 工頭派 sonnet) |
| planner | sonnet | plan | analysis only |
| reviewer | sonnet | plan | Claude-side read-only review; hetero panel lives in review-loop-config.md |
| test-runner | haiku | default | execution-focused |
| implementer | haiku | default | Claude-side mechanical leaf only; the real implementer is the hetero engine in review-loop-config.md (agy gemini-3.8-flash low) |
