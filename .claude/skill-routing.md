# Skill Routing — Project Config (hangar-bridge)
# Maps project keywords to skills. No project-specific skills exist yet; these route domain
# terms to the right autopilot methodology skill so dispatch is sharp.

| Keyword | Invoke |
|---------|--------|
| envelope / wire format / zod schema | autopilot:debug (evidence-first; schema is a compile-time contract across relay+peer-agent) |
| channel tag / escaping / injection | autopilot:reviewer (security surface — review, don't guess) |
| SSE / cursor / resume / ULID ordering | autopilot:debug |
| relay / Hono / sqlite / idempotency | autopilot:debug |
| peer-agent / MCP / stdio / dispatch_task | autopilot:debug |
| coverage / vitest / property test | autopilot:test-strategy |
| latency / throughput / slow | autopilot:profiling |
