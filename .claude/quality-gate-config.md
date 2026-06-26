# Quality Gate — Project Config (hangar-bridge)

## Test Command
- `pnpm -r typecheck && pnpm -r test:ci`

## Scan Command
- Completeness scan (no stubs/TODO/mock leakage): autopilot `scripts/completeness-scan.sh` over `packages/*/src`.

## Code Review
- `autopilot:reviewer` (only entry — superpowers is NOT installed). See `.claude/dispatch-config.md`.

## Route Overrides
- S:      scan → review (skip completeness if scan clean)
- L:      test → scan → completeness → review (full pipeline)
- Fix:    test → review only

## Security-critical surfaces (always full review, never fast-path)
- Envelope schema (`packages/shared` zod), `<channel>` tag serializer/escaping, peer-agent `instructions` string,
  sender-stamp / `from` server-population, roster gate, idempotency, SSE cursor-resume monotonicity.
  Changes here require reading spec §4/§6 reasoning — do not weaken wording or escaping.

## Anti-Rationalization
- anti_rationalization: true
