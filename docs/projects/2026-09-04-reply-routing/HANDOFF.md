## 目標
以 `/l5` 實作 `REPLY_ROUTING_SPEC.md` v7 的 rollout step 1 + step 2 程式碼(relay + peer-agent + shared + switchboard),做到 merge-ready 的 `feat/reply-routing` 分支,不部署。goal 原文見本檔末。

## 現況（2026-09-05 收尾）
- **`feat/reply-routing` 為 merge-ready**（tip 見 `git log`，從 develop `39c7cc5` 開，63+ commits、五個 `--no-ff` merge：D1 `f88e9e5` shared、D2 `934cd62` relay data layer、D3 `dd27712` relay chokepoint/flag/grants、D4 `3b3ecbd` relay endpoints、D5 `92bfcc3` peer-agent）。**未 push、未部署、未合進 develop**（operator 決定）。
- 最終全 repo gate（feat tip，`corepack pnpm -r typecheck && build && test:ci`）全綠：shared 145 tests / lines 100 %；relay 386 tests / lines 94.3 %；peer-agent 492 tests / lines 92.5 %；e2e 62（2 skipped，無本機 NATS，既有行為）。`pnpm audit --prod --audit-level high` 無 high/critical（2 moderate，既有）。
- 每個 deliverable 都經過：git artifact 驗範圍 → depth-0 獨立 gate（在 hands worktree）→ 三席 hetero qc（codex gpt-5.6-sol / MiniMax-M3 / glm-5.3，`/tmp/qc/run-qc.sh`）→ 每條 finding depth-0 對 spec 重驗（採納者交 hands 修、駁回者附證據記 `/tmp/autopilot-campaigns/decision-ledger.jsonl` d-1..d-20）→ merge `--no-ff` → feat 全 repo gate。無任何 verified Critical 留存。
- 執行模式：`/l5` 的 precondition_failed fallback（l3 inline，sonnet hands 於 `Agent isolation:"worktree"`）；原因與環境修復見「已決事項」與 memory `l5-strict-projection-needs-mission`。
- 已知 flake（未修、已入 BACKLOG）：`packages/peer-agent/src/stream-client.test.ts` reconnect timing 與 `p1-independent.test.ts` 本機 nats-server 啟動，都只在 `pnpm -r` 高負載時偶發，隔離重跑皆綠。
- 文件：`REPLY_ROUTING_SPEC.md` STATUS 行與 `CLAUDE.md` 已改為「step 1+2 code implemented on feat/reply-routing」；`docs/BACKLOG.md` 有 out-of-scope 三項（dotfiles fleet/crew.zsh、@cookys/agent-call、hangar fleet-pulse gate）+ panel follow-ups + flake；`docs/evidence/address-rules-gate.json` 只是骨架。

## 已決事項(不重議)
- ADR 與 spec 分家;`use_reply_verb` 與 §6 拒絕全在 `HANGAR_RELAY_ADDRESS_RULES` 後面,預設 off;不部署;out of scope = dotfiles `fleet`/`crew.zsh`、`@cookys/agent-call`、hangar `fleet-pulse`(寫進 `docs/BACKLOG.md`,不寫進程式)。
- 引擎路由(operator 指定,已 resolve 確認):foreman sonnet;implementer agy `gemini-3.8-flash` low;in-loop reviewer MiniMax-M3;qc panel gpt-5.6-sol / MiniMax-M3 / glm-5.3;`on_engine_unavailable=ask`。
- 工具鏈:裸 `pnpm` 不在非互動 shell 的 PATH,一律 `corepack pnpm`(10.32.1)。verify_cmd 已寫成這樣。
- deliverable 切分與順序照 deliverables.md;D1 ∥ D2 可平行(路徑互斥),其餘串行;每個 merge 進 `feat/reply-routing` 即一個 handoff 邊界。
- §13 錯誤表 `parent_unaddressable` 那格寫「route row is deleted」是 v6 殘句,與 §3.1/§5.1 的 tombstone 矛盾;D4 實作以 tombstone 為準並順手改 §13(已寫進 D4 節與 contract 的 allowed paths)。

## 下一步（給 operator / 下一個 session）
1. 檢視 `git log --oneline develop..feat/reply-routing` 與五個 merge commit 的 qc 摘要；要的話 `git push -u origin feat/reply-routing`（允許，尚未做）。
2. 決定合進 develop 的時機：合併後 relay 啟動會跑 `migrateV8ToV9`（backfill 現有 chat/task_dispatch 列，log `{routes, null_sender_instance}`）；`HANGAR_RELAY_ADDRESS_RULES` 預設 off，`/v1/replies`、`/v1/inbox`、`/v1/grants/finalize` 立即可用，`/v1/messages` 行為不變。
3. 部署屬 hangar deployment skill 範圍（本 run 明文不部署）。旗標翻 on 前要先做 BACKLOG 的三項 client-side 工作與 §16 evidence manifest。
4. 若要重試真正的 `/l5` hetero rail：先在本 repo 建 Mission（authority + execution graph），否則會再撞 strict projection gate。
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
