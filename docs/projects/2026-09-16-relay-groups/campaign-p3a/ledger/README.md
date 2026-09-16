# P3a campaign ledger
Base `811c600`; codex gpt-5.5 `ac66ec9` (7 files: `peers-groups-init` CLI + tests, DEPLOYMENT §2.4/§5, architecture
§5.1/§5.2/§5.7, PROJECT_ISOLATION, README). Engine verify PASS. MiniMax r1 FIX-THEN-SHIP 6: accepted (a) stdout
monkey-patching to silence the legacy warn → `loadPeersFile(path, {warnLegacy:false})` (depth-0, touches peers-file.ts
signature additively); (b) §5 rollback wording — roster and sqlite restore must come from the same §2.1 backup;
(c) `--group` on an already-v2 file now says it is ignored. Refuted: em-dash typo (none in code), envelope `group` on
legacy rows (relay fills the default), `assertWrittenStrict` uniqueness (the tool refuses to run on v2 input, so extra
groups cannot pre-exist). No sol pass: docs + a 150-line CLI with round-trip tests; dry-run against the live
`peers.json` produced 10 peers → `cookys`/all with secrets preserved.
