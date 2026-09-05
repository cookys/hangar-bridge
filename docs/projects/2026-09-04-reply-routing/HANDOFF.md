## 目標
以 `/l5` 實作 `REPLY_ROUTING_SPEC.md` v7 的 rollout step 1 + step 2 程式碼(relay + peer-agent + shared + switchboard),做到 merge-ready 的 `feat/reply-routing` 分支,不部署。goal 原文見本檔末。

## 現況
- 分支 `feat/reply-routing`（從 develop `39c7cc5` 開）。**D1 已 merge**（`f88e9e5`，8 commits，shared only）、**D2 已 merge**（`934cd62`，impl/reply-routing-D2 = `52b684e`，13 commits，relay data layer：schema v9 + backfill、store route/grant helpers、drain 自排除、`Fanout.snapshotDetailed` + frozen delivery、limiter、purge）。merge 後全 repo gate 綠：shared 145 tests / lines 100 %，relay 283 tests / lines 93.4 %，peer-agent 415，e2e 62。**D3 hands 進行中**（`impl/reply-routing-D3`，worktree `.claude/worktrees/agent-a076ed888ad9c0d21`，基底 934cd62，prompt `/tmp/autopilot-campaigns/D3.prompt.md`，reviewer spec `/tmp/qc/D3.spec.md`）。
- D2 qc 兩輪：第一輪三席都 FIX（fanout.ts 含 2 個原始 NUL byte → git 視為 binary、三席審不到；v9 版本號未與 backfill 同交易；purge 迴圈冗餘）；第二輪 MiniMax/glm SHIP、codex 4 項 hardening 採納（correlation 重複掉 route、drain 述詞明確排除 `@mailbox:`、frozen delivery 帶 selfExcluded、finalizeGrant blank+exact）。未採納（有證據）：insertRoute 改 OR IGNORE（spec 要 route 寫入失敗即中止）、limiter 雙連線併發測試（單述句原子性即證據）。
- 既有 flake：`packages/peer-agent/src/stream-client.test.ts` reconnect timing 在 `pnpm -r` 負載下偶發（今日 3 次，隔離重跑皆綠；D1/D2 未碰 peer-agent）→ 收尾時寫進 `docs/BACKLOG.md`。
- **執行模式已改為 `/l5` 的 precondition_failed fallback（operator 2026-09-05 決定）**：session-mode `l3 --entry-level l5 --fallback precondition_failed`。原因：dispatch-hetero 的 session-mode gate 在 ACTIVE l5 marker 下要求 sealed campaign **strict projection**（contract 要有 `mission_runtime` + `strict_dispatch`，即 Mission runtime），本 repo 無 Mission；v1 contract 只在非 l5/l6 admissible（autopilot `hooks/tests/dispatch-hetero.test.sh` 明文）。所以 implementer 改為 depth-0 派 Claude hands（sonnet，`Agent isolation:"worktree"`，分支 `impl/reply-routing-Dk`），qc 三席（codex gpt-5.6-sol / MiniMax-M3 / glm-5.3）照舊在 depth-0 跑；hetero 引擎路徑不再使用。
- 為了走到那一步修掉的環境阻塞（都已落地，見 decision ledger `/tmp/autopilot-campaigns/decision-ledger.jsonl` d-1..d-8）：`/etc/apparmor.d/bwrap`（userns，operator 核准）；autopilot `18f46faf`（agy `--effort`）、`ffe6838d`（live-probe budget 512）；本 repo `153cbed`（qc_panel_runners/efforts/endpoints）；`~/.agents/skills/game-logic-optimization/SKILL.md` 補 frontmatter（codex chrome frame）。六席 live probe 全 ready；`campaign_intake` 不得帶 `--campaign-ledger`。兩個 dead v1 campaign 留在 `.git/autopilot/implementation-campaign.jsonl`，未 resume。
- 工作檔（/tmp，session 重開仍在）：`/tmp/autopilot-campaigns/D{1..5}.prompt.md`（implementer prompt，D3–D5 依 D1/D2 實際 API 名稱再微調）、`/tmp/qc/D{1,2}.spec.md`（reviewer baseline）、`/tmp/qc/run-qc.sh <Dk> <diff> <spec>`（三席 detached 啟動，codex 要在 repo 目錄起）。
- D1 qc 結果：glm SHIP-AS-IS；MiniMax 1 誤報（message id 是嚴格 regex）+1 測試強化（採納）；codex 2 項（`all_sessions:false` 漏檢、`@mailbox:` 後綴未驗 handle）皆採納修復。

## 已決事項(不重議)
- ADR 與 spec 分家;`use_reply_verb` 與 §6 拒絕全在 `HANGAR_RELAY_ADDRESS_RULES` 後面,預設 off;不部署;out of scope = dotfiles `fleet`/`crew.zsh`、`@cookys/agent-call`、hangar `fleet-pulse`(寫進 `docs/BACKLOG.md`,不寫進程式)。
- 引擎路由(operator 指定,已 resolve 確認):foreman sonnet;implementer agy `gemini-3.8-flash` low;in-loop reviewer MiniMax-M3;qc panel gpt-5.6-sol / MiniMax-M3 / glm-5.3;`on_engine_unavailable=ask`。
- 工具鏈:裸 `pnpm` 不在非互動 shell 的 PATH,一律 `corepack pnpm`(10.32.1)。verify_cmd 已寫成這樣。
- deliverable 切分與順序照 deliverables.md;D1 ∥ D2 可平行(路徑互斥),其餘串行;每個 merge 進 `feat/reply-routing` 即一個 handoff 邊界。
- §13 錯誤表 `parent_unaddressable` 那格寫「route row is deleted」是 v6 殘句,與 §3.1/§5.1 的 tombstone 矛盾;D4 實作以 tombstone 為準並順手改 §13(已寫進 D4 節與 contract 的 allowed paths)。

## 下一步
1. fresh session：`node ~/projects/autopilot/scripts/session-mode.js set --level l3 --entry-level l5 --fallback precondition_failed --repo-root ~/projects/hangar-bridge`（不要再設 l5，會撞 strict projection gate）。
2. 讀本檔 + `l5-runbook.md` §3.5–3.8（qc / merge / GC / ledger 仍適用）+ `deliverables.md`。
3. D2：若 `impl/reply-routing-D2` 已有完整 6 commits → `git diff feat/reply-routing..impl/reply-routing-D2 > /tmp/qc/D2.diff` → `bash /tmp/qc/run-qc.sh D2 /tmp/qc/D2.diff /tmp/qc/D2.spec.md` → 合成 → merge `--no-ff` → 全 repo gate。否則以 `Agent(model:"sonnet", isolation:"worktree")` 重派 hands，prompt = `Engine: sonnet` + 「讀 /tmp/autopilot-campaigns/D2.prompt.md、`git checkout -b impl/reply-routing-D2`、TDD、自跑 gate、DONE 行」。
4. D3 → D4 → D5 串行，同樣流程（prompt 已寫好；派工前先 `sed -n` 看 D1/D2 實際 helper 名稱對一下）。每個 merge 後更新本檔並 commit。
5. 收尾照 runbook §4：`docs/BACKLOG.md` 補 out-of-scope；不部署、不 push develop。

## 驗證方式
```
cd ~/projects/hangar-bridge && corepack pnpm -r typecheck && corepack pnpm -r build && corepack pnpm -r test:ci
```
在 `feat/reply-routing` 全綠;`git log develop..feat/reply-routing` 依 §15 分檔;每個 campaign 的 `node ~/projects/autopilot/bin/autopilot.js status task --root-run-id <campaign-id> --json` `can_merge === true`(merge 前)且 lifecycle receipt `zero_residue === true`。hosted CI 刻意關閉,不以它為準。

## Read-order(總量約 600 行;超出者只在需要時 `sed -n` 該節)
1. `docs/projects/2026-09-04-reply-routing/l5-runbook.md` — 全部(≈180 行)。
2. `docs/projects/2026-09-04-reply-routing/deliverables.md` — 全部(≈170 行)。
3. `docs/projects/2026-09-04-reply-routing/campaigns/D1-shared.json`、`D2-relay-data.json`(要派哪個就讀哪個)。
4. **不要**整讀:`REPLY_ROUTING_SPEC.md`(implementer 與 reviewer 讀,depth-0 只在寫 brief 時 `sed -n` 該 deliverable 列出的節)、`skills/ceo-agent/references/level-front-door.md`、`references/hetero-dispatch.md`、`skills/l5/references/hetero-impl-loop.md`(runbook 已涵蓋派工所需;某條規則有疑義才 `grep -n` 關鍵字看那一段)。

## 陷阱
- 見 runbook §5(context 紀律)與 §3.5(codex 15–25 分鐘、`pkill -f` 自殺、glm no_verdict)。
- zsh 下 `echo =====SEP=====` 會把 `=SEP` 當可執行檔路徑展開而整條命令失敗;分隔線別以 `=` 開頭。
- `resolve-review-loop.sh` 不吃 `--repo-root`,要在 repo 根目錄執行。
- `engine implement-review --help` 不存在;用法在 `node bin/autopilot.js` 無參數的 Usage 段。
- `AUTOPILOT_LEVEL=l5` 要「provider-readiness trust root」、`--campaign-disposition-policy` 二選一——這兩點本 session 未實跑,runbook §3.3 寫了先試什麼、失敗只讀哪則錯誤。
- agy headless 對 build/test 不可靠;implementer 派 agy 是 operator 明定,verify 靠 `--verify-cmd` 與 git artifacts,不信自述。
- `.claude/settings.local.json` 已停用 `agent-call-local` MCP;`switchboard` 的 finalise/paste 以現行 `ac_taken` 檢查為底。

## goal 原文(給 `/l5`)
> Implement hangar-bridge REPLY_ROUTING_SPEC.md v7 (branch off develop as feat/reply-routing; decision = hangar decisions/_global/0015 accepted). Scope: the §15 file-by-file change list, rollout step 1 + step 2 code only (relay route/grant/limiter/idem tables + migration/backfill, POST /v1/replies, GET /v1/inbox, POST /v1/grants/finalize, HANGAR_RELAY_ADDRESS_RULES flag default off; peer-agent reply_to_peer + send_to_peer changes + instructions text + audience report; shared envelope/channel changes; switchboard persisted instance + return selector + finalise-before-paste). Out of scope: dotfiles fleet/crew changes, @cookys/agent-call changes, fleet-pulse gate. TDD per the spec's numbered sections; admission = the repo's existing local gate sequence (pnpm -r typecheck / build / test:ci; hosted CI is off on purpose). Do NOT deploy; stop at a merge-ready branch.
