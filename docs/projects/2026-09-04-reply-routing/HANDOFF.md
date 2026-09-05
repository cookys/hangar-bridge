## 目標
以 `/l5` 實作 `REPLY_ROUTING_SPEC.md` v7 的 rollout step 1 + step 2 程式碼(relay + peer-agent + shared + switchboard),做到 merge-ready 的 `feat/reply-routing` 分支,不部署。goal 原文見本檔末。

## 現況
- 分支 `develop`,HEAD `df42993`(本次 handoff commit 之前)。工作樹乾淨。**`feat/reply-routing` 尚未建立,零實作。**
- DONE(2026-09-05 這個 session):L5 前置全部讀完並**蒸餾落地**成三份檔,下一個 session 靠它們就能派工,不必再讀 rail 原文:
  - `docs/projects/2026-09-04-reply-routing/l5-runbook.md` — depth-0 完整命令序列(session-mode、seal、foreman 派工、watcher + 死人開關、引擎命令、outcome 表、qc 三席、status task、merge、GC、decision ledger)與已解析 roster 值。
  - `docs/projects/2026-09-04-reply-routing/deliverables.md` — spec §15 切成 D1 shared → D2 relay 資料層 → D3 relay chokepoint → D4 relay 新端點 → D5 peer-agent,每節即 foreman brief / implementer prompt 的內容(路徑、spec 節、驗收、預估 diff)。
  - `docs/projects/2026-09-04-reply-routing/campaigns/D1..D5*.json` — campaign contract 草稿(schema `implementation-campaign-contract` 必填欄位齊);D1 的 `base_sha` 已是 develop tip,D3–D5 的 `base_sha` 是占位字串,merge 前一個後再填。`repo_identity` 格式是猜的,seal 拒收就照錯誤訊息改那一欄。
- 為什麼又交接:context-budget T2(165k)在讀完 rail 文件、尚未派工時觸發。前一個 session 也是同一位置倒下。原因是 read-order 要求整讀 front-door(1083 行)+ spec(962 行)+ hetero-dispatch,單這三份就超過 T1。**下一個 session 不得重蹈:read-order 見下,總量約 600 行。**

## 已決事項(不重議)
- ADR 與 spec 分家;`use_reply_verb` 與 §6 拒絕全在 `HANGAR_RELAY_ADDRESS_RULES` 後面,預設 off;不部署;out of scope = dotfiles `fleet`/`crew.zsh`、`@cookys/agent-call`、hangar `fleet-pulse`(寫進 `docs/BACKLOG.md`,不寫進程式)。
- 引擎路由(operator 指定,已 resolve 確認):foreman sonnet;implementer agy `gemini-3.8-flash` low;in-loop reviewer MiniMax-M3;qc panel gpt-5.6-sol / MiniMax-M3 / glm-5.3;`on_engine_unavailable=ask`。
- 工具鏈:裸 `pnpm` 不在非互動 shell 的 PATH,一律 `corepack pnpm`(10.32.1)。verify_cmd 已寫成這樣。
- deliverable 切分與順序照 deliverables.md;D1 ∥ D2 可平行(路徑互斥),其餘串行;每個 merge 進 `feat/reply-routing` 即一個 handoff 邊界。
- §13 錯誤表 `parent_unaddressable` 那格寫「route row is deleted」是 v6 殘句,與 §3.1/§5.1 的 tombstone 矛盾;D4 實作以 tombstone 為準並順手改 §13(已寫進 D4 節與 contract 的 allowed paths)。

## 下一步
1. fresh session 在 `~/projects/hangar-bridge`:`node ~/projects/autopilot/scripts/session-mode.js set --level l5 --repo-root ~/projects/hangar-bridge`。
2. 讀 read-order 的三份(不要多)。對 operator 說一次 runbook §0 的三條 capability_warnings。
3. `git branch feat/reply-routing develop && git checkout feat/reply-routing`。
4. 照 runbook §3 跑 D1(可同時起 D2):seal → foreman(sonnet,brief ≤ 300 行 = deliverables.md D1 節 + runbook §3.3)→ watcher + 死人開關 → 等通知 → qc 三席 → status task `can_merge` → merge → GC → decision ledger。
5. 每個 deliverable merge 後更新本檔「現況」並 commit(docs only);T1 一過就在下一個 merge 邊界交接。

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
