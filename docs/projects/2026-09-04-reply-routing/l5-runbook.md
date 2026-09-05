# reply-routing /l5 runbook(depth-0 操作手冊,蒸餾版)

> 目的:讓下一個 depth-0 session **不必重讀** `skills/ceo-agent/references/level-front-door.md`
> (1083 行)、`skills/l5/references/hetero-impl-loop.md`、`references/hetero-dispatch.md`、
> `REPLY_ROUTING_SPEC.md` 全文就能派工。前兩個 session(2026-09-04、2026-09-05)都是在讀這些
> 文件時撞到 context-budget T2(150k)而交接,零實作。這份是它們的替代品;規則出處都標了,
> 有疑義才去翻原文的**那一節**。

## 0. 已解析的固定值(2026-09-05,`resolve-review-loop.sh` 於 repo 根目錄輸出)

| 欄位 | 值 |
|---|---|
| implementer | `gemini-3.8-flash` / effort `low` / runner `agy`(agy 1.1.26 在 `~/.local/bin`) |
| foreman | `sonnet`(`resolve-dispatch.sh --tree --role sub-orchestrator` → `{"model":"sonnet","table":"tree"}`) |
| in-loop reviewer | `MiniMax-M3` xhigh / runner `anthropic-compatible` / `--endpoint MINIMAX` |
| verification author | `glm-5.3` high / `anthropic-compatible` / `--endpoint GLM`(/l5 不用,/l6 才用) |
| qc_panel | `gpt-5.6-sol`(codex 0.152.1 OAuth)、`MiniMax-M3`、`glm-5.3`;aggregation `union-on-verified-critical`;`min_panel_size` 3 |
| on_engine_unavailable | `ask` → 引擎死掉就停下來問 operator,**不得**自動 `--solo` |
| independent_harness | `on` → depth-0 自建對抗 harness,不信 implementer 的綠 |
| loop_max_rounds / convergence | 5 / `SHIP-AS-IS` |
| review_risk(預設輸入) | `low`;但本案 diff > 150 行且碰安全面(`instructions.ts`、relay 住址規則),派審前用 `--diff-lines <n> --security-surface 1 --protected-path 1` 重算 → `high`,`required_review_families` 2、`l1_required` |
| endpoints | `node bin/autopilot.js endpoints doctor --json` → glm、minimax 皆 ok(2026-09-05) |
| capability_warnings(首次派工前要對 operator 說一次) | plan_review / hetero_review / consult_dispatch 三個 `auto` 席在本機無合格座位,回落 claude-native(opus/high、native、sonnet/high) |
| capability_state_source | `unknown`(不是 `none`,不需另報) |

工具鏈:**`pnpm` 不在非互動 shell 的 PATH**;一律用 `corepack pnpm`(10.32.1)。verify_cmd、
foreman brief、implementer prompt 全部寫 `corepack pnpm`。

## 1. 每個 session 開場(一次)

```bash
node ~/projects/autopilot/scripts/session-mode.js set --level l5 --repo-root ~/projects/hangar-bridge
```
必須在任何 TaskCreate / branch / worktree / Agent 之前。本 repo 沒有 Mission 設定(`.claude/` 無
mission 檔),admission 是 LEGACY/off 模式;campaign 的 `mission_grant_ref` 填 `null`,
`--mission-mode off`。

## 2. 分支與 base

- `feat/reply-routing` 從 `develop`(`df42993d6ceb0d3746addcdd1ef5272239ea5c69`)開;depth-0 自己
  `git branch feat/reply-routing develop && git checkout feat/reply-routing`(主 checkout 只有一個
  worktree,無他人在用)。
- `git merge-base --is-ancestor HEAD origin/develop` 在 df42993 為 exit 0 → D1 的 foreman worktree
  用預設 `worktree.baseRef=fresh` 即可。**D2 起**每個 deliverable 要疊在 `feat/reply-routing` 現行
  tip 上:hetero 引擎的 base 由 `--base <完整 40 碼 SHA>` 決定(它自己開 worktree,與 foreman 的
  native worktree 是兩套機制,`worktree.baseRef` 管不到它),所以 foreman 的 worktree 內容不重要,
  只要 `--cwd` 指向一個共用 `.git` 的 checkout 即可。
- `hetero/reply-routing-Dk` 是引擎產出的分支名;depth-0 在 qc 過後 `git merge --no-ff` 進
  `feat/reply-routing`(identity-preserving,reaper 才能證明 containment;**不要** cherry-pick)。

## 3. 每個 deliverable 的迴圈(D1→D5,見 deliverables.md)

### 3.1 凍結 campaign contract
```bash
P=docs/projects/2026-09-04-reply-routing
# 先把 campaigns/Dk.json 的 base_sha 改成 feat/reply-routing 現行 tip(git rev-parse HEAD)
node ~/projects/autopilot/scripts/implementation-campaign-check.js seal \
  --contract $P/campaigns/Dk.json --repo ~/projects/hangar-bridge --mission-mode off \
  --out /tmp/autopilot-campaigns/Dk.seal.json          # exit 0 = SEALED;3 = contract 不合法(讀它的錯誤訊息,只改該欄)
```
schema:`~/projects/autopilot/schemas/implementation-campaign-contract.schema.json`(必填欄位已全
部寫進草稿;`repo_identity` 的格式是我猜的 `git-common-dir:<path>`,seal 若拒收就照錯誤改)。
campaign_id 形如 `campaign-v1-<64hex>`,由 seal 產生,即 `root_run_id`。

### 3.2 預派 ledger、派 foreman、上兩個背景喚醒
```bash
RUN=reply-routing-Dk-$(date +%s)
LEDGER=${TMPDIR:-/tmp}/autopilot-dispatch-runs/$RUN.ledger.jsonl
bash ~/projects/autopilot/scripts/run-ledger.sh init --ledger "$LEDGER"
```
Foreman 用 `Agent(run_in_background:true, isolation:"worktree", subagent_type:"general-purpose",
model:"sonnet", prompt:<brief>)`;brief 第一行必須是 `Engine: sonnet`(`dispatch-model-guard` 會
擋沒帶或不符的)。brief ≤ 300 行,內容 = deliverables.md 該節 + 下面 3.3 的引擎命令 + foreman 職責。
派出後 depth-0 **同回合**起兩個背景 Bash:
```bash
node ~/projects/autopilot/scripts/watch-foreman.js --ledger "$LEDGER" --root "$RUN"   # run_in_background
sleep 5400; echo DEADLINE_HIT                                                            # run_in_background 死人開關
```
`QUIET`/`LEAF_STALL` 是觀察不是判決;`dead reason=owner_absent` 對 CC-native foreman 是正常形狀,
只有 `owner_absent_worktree_absent` 才算死。到期先看 `git log hetero/reply-routing-Dk`,有進度可
延長一次(記 decision ledger),沒進度 `TaskStop` 後升報。

### 3.3 foreman 職責(寫進 brief,逐條)
1. `run-ledger.sh stage-acquire --ledger $LEDGER --run-id $RUN --stage implement`;長階段每 5 分鐘
   `stage-heartbeat`;階段邊界 `stage-transition`,並在下一個 `stage-acquire` 前 `directive-poll` 一次。
2. 唯一的變更入口(一次,背景執行,結束回合等 task-notification;同回合配一個 `sleep …; echo WAKE`
   背景死人開關):
   ```bash
   AUTOPILOT_LEVEL=l5 AUTOPILOT_PARENT_RUN_ID=$RUN AUTOPILOT_ROOT_RUN_ID=$RUN AUTOPILOT_DISPATCH_DEPTH=1 \
   node ~/projects/autopilot/bin/autopilot.js engine implement-review \
     --campaign-contract <Dk.json> --campaign-seal <Dk.seal.json> \
     --campaign-disposition-policy acceptance-bound \
     --prompt-file <Dk.prompt.md> --branch hetero/reply-routing-Dk --base <完整 SHA> \
     --cwd <foreman worktree 或主 checkout> --max-rounds 5 --require-qualified-reviewer \
     --verify-cmd '<deliverables.md 該節的 verify_cmd>' > <out.json> 2> <err.log>
   ```
   已知未驗證點:`AUTOPILOT_LEVEL=l5` 要求「host-owned exact-roster provider-readiness trust root」;
   先跑 `node ~/projects/autopilot/bin/autopilot.js status readiness --json --probe`,失敗只讀那則
   錯誤。`--campaign-disposition-policy` 二選一(`deny-nonempty|acceptance-bound`),語意未讀;先用
   `acceptance-bound`,被拒再 `grep -n disposition ~/projects/autopilot/src/engine/campaign-dispatch-projection.js`。
3. 讀 `<out.json>` 的 status 欄與 JSON 摘要,**不得**把 agent_log 灌回 context。DONE 行固定格式:
   `DONE status=<committed|…> branch=<b> commit=<sha> base=<sha> verify=<pass|fail> out=<path>`。
4. Bash 上限 40(`foreman-guard` 會在第 41 次 deny);一刀一命:交出 DONE 行就結束回合,不等下一
   個指派。禁前景 `sleep`/輪詢/`Monitor`/讀 `/tasks/*.output`。

### 3.4 outcome → action(depth-0)
| status | 動作 |
|---|---|
| `committed` | 進 3.5 qc |
| `no_op` | 確認範圍真的空 → 否則換更尖的 prompt 重派一次 |
| `dirty` / `failure` / `question_suspected` | 升報 operator;worktree 保留待檢,依 3.7 收 |
| `precondition_failed` / engine_unavailable | `on_engine_unavailable=ask` → 停下問 operator,不自動 `--solo` |
| foreman 死於 DONE 前 | `run-ledger.sh resume --ledger $LEDGER --run-id $RUN --idempotency-key <k>` |

### 3.5 qc@depth-0(權威 gate)
1. diff:`git diff <base>..hetero/reply-routing-Dk > /tmp/qc/Dk.diff`;payload 只放 diff + 該
   deliverable 的 spec 節號與「要回答的問題」,**不放** implementer 自述。先
   `bash ~/projects/autopilot/scripts/check-blind-evidence.sh --payload <spec> --json`。
2. 三席,各自 `setsid nohup … > Dk.<seat>.json 2>&1; touch Dk.<seat>.done & disown`,再起一個
   `until [ -f Dk.<seat>.done ]; do sleep 30; done; echo SEAT_DONE` 背景 waiter(Bash 10 分鐘
   上限會砍前景;codex xhigh 審 30–55 KB 要 15–25 分鐘,MiniMax 給 25 分鐘):
   ```bash
   S=~/projects/autopilot/scripts/dispatch-review.sh
   bash $S --runner codex --model gpt-5.6-sol --effort xhigh --diff /tmp/qc/Dk.diff --spec <spec>
   bash $S --runner anthropic-compatible --model MiniMax-M3 --endpoint MINIMAX --effort xhigh --diff … --spec …
   bash $S --runner anthropic-compatible --model glm-5.3 --endpoint GLM --effort high --diff … --spec …
   ```
   (旗標名以 `dispatch-review.sh --help` 為準,只讀 USAGE 段。)glm 常因自己的 framing 文字被 parser
   拒收成 `no_verdict`;`no_verdict` 一律 fail-closed,重跑一次,再失敗就記 ledger 並以另兩席 + depth-0
   second-look 補足 `required_review_families`。
3. 合成:任一席 **verified** Critical ⇒ 擋;每個 finding depth-0 先自己重現再轉給修復;不採納要
   附證據記在 decision ledger。修復 = 同一 campaign 的 repair round(引擎 `--resume` 或新 prompt),
   不是新 contract。
4. `pkill -f` 的 pattern 若出現在自己的命令列會殺到自己(exit 144);用
   `ps -eo pid,args | grep <pat> | grep -v snapshot-zsh` 取 pid。

### 3.6 merge(depth-0 獨有)
```bash
node ~/projects/autopilot/bin/autopilot.js status task --root-run-id <campaign_id> --json > pre.json
node -e 'const v=JSON.parse(require("fs").readFileSync("pre.json","utf8"));if(v.can_merge!==true)process.exit(1)'
git checkout feat/reply-routing && git merge --no-ff hetero/reply-routing-Dk
node ~/projects/autopilot/bin/autopilot.js status task --root-run-id <campaign_id> --json > post.json
```
`status task` 需要 `${AUTOPILOT_TASK_STATUS_DIR:-/tmp/autopilot-task-status}/<root_run_id>.json`
存在(引擎/controller 會寫;沒有就讀它的錯誤訊息)。

### 3.7 GC(每個 deliverable 結束、merge 前後各一次)
```bash
autopilot_root=~/projects/autopilot; consumer_repo=~/projects/hangar-bridge
campaign_id=<campaign-v1-…>; root_run_id=$campaign_id; integration_target=feat/reply-routing
lifecycle_dir=$(mktemp -d /tmp/autopilot-lifecycle/root-$root_run_id.XXXXXX)
bash $autopilot_root/scripts/reap-dispatch-worktrees.sh reap --repo $consumer_repo --root-run-id $root_run_id --yes > $lifecycle_dir/worktrees.json
bash $autopilot_root/scripts/reap-dispatch-branches.sh reap --repo $consumer_repo --into $integration_target --inventory-file $lifecycle_dir/worktrees.json --yes > $lifecycle_dir/branches.json
node $autopilot_root/scripts/lifecycle-residue-receipt.js issue --repo $consumer_repo --root-run-id $root_run_id --worktree-result $lifecycle_dir/worktrees.json --branch-result $lifecycle_dir/branches.json --out $lifecycle_dir/residue-receipt.json
node $autopilot_root/scripts/lifecycle-residue-receipt.js check --repo $consumer_repo --root-run-id $root_run_id --receipt $lifecycle_dir/residue-receipt.json
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(v.zero_residue!==true)process.exit(1)' $lifecycle_dir/residue-receipt.json
```
`zero_residue` 必須是 `true`;`false` 是資源 blocker,不是完成。native foreman 的 worktree 在
`.claude/worktrees/agent-<id>`,被 kill 且有變更時要先保留 tip 再 `git worktree remove --force`。

### 3.8 decision ledger
每個 depth-0 決定(派工、延長、不採納 finding、merge)當回合寫:
```bash
node ~/projects/autopilot/scripts/decision-ledger.js append --ledger /tmp/autopilot-campaigns/decision-ledger.jsonl \
  --kind decision --json '{"decision_id":"d-N","round":R,"class":"tactical","rationale":"…","reversibility":"two-way"}'
```

## 4. 收尾
五個 deliverable 都 merge 進 `feat/reply-routing` 後:`corepack pnpm -r typecheck && corepack pnpm -r build
&& corepack pnpm -r test:ci` 在 `feat/reply-routing` 全綠;`git log develop..feat/reply-routing` 依 §15 分檔;
`docs/BACKLOG.md` 補 out-of-scope TODO(dotfiles `fleet`/`crew.zsh`、`@cookys/agent-call`、hangar
`fleet-pulse` 三欄、`~/.claude/CLAUDE.md` 兩列)。**不部署、不 push 到 develop**;push
`feat/reply-routing` 本身可以。最後 finish-flow 拿最新 `status task` 的 `can_close=true` 才
`session-mode.js clear`。

## 5. depth-0 context 紀律(這次交接的原因)
- 只讀:HANDOFF.md、本檔、deliverables.md、要派的那個 Dk.json。**不要**整讀 spec、front-door、
  hetero-dispatch;要查某節就 `sed -n` 該節。
- 每個 leaf 的輸出落檔,depth-0 只讀 JSON 摘要。
- 一個 deliverable 結束(merge 完)就是 handoff 邊界;T1(100k)一過,下一個邊界就寫 handoff 換 session。
- zsh:`echo =====` 會把 `=xxx` 當命令路徑展開而失敗,分隔線不要以 `=` 開頭。
