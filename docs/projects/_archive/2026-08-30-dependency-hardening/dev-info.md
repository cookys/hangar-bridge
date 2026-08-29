# Development info

- Session start SHA: `49ecd7522abd5d2579ede69da203cc22ef9b55fa`
- Working branch: `develop`
- Merge target: `main` by non-force fast-forward after hosted CI
- Package manager: `pnpm@10.32.1`
- Runtime baseline: Node.js `v24.16.0`; hosted Node.js `v24.19.0`
- Review route: Autopilot heterogeneous read-only reviewer; no Copilot pipeline
- Remediation SHA: `356f5f1473ca0dec01413c2982351e40b6d19acc`
- Hosted `develop` CI: `https://github.com/cookys/hangar-bridge/actions/runs/33269704732` (`PASS`)
- Hosted `main` CI: `https://github.com/cookys/hangar-bridge/actions/runs/33269758967` (`PASS`)
- Holdout: SHA-bound mutation receipt `PASS`; `undici@6.20.0` caused the production audit to fail
  with four high advisories.
