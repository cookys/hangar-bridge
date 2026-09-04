## 目標
以 `/l5` 實作 `REPLY_ROUTING_SPEC.md` v7 的 rollout step 1 + step 2 程式碼(relay + peer-agent + shared + switchboard),做到 merge-ready 的 `feat/reply-routing` 分支,不部署。

## 現況
- 分支 `develop`,HEAD `a031ced` — chore(autopilot): roster + model routing。工作樹乾淨,無 stash。
- DONE:hangar `decisions/_global/0015` **accepted**(hangar `d341583`);本 repo `REPLY_ROUTING_SPEC.md` v7(`a88ac15`,五輪 panel 收在上限,所有 Critical 已折入,殘餘見其 §17);`.claude/review-loop-config.md` + `.claude/model-routing-config.md`(`a031ced`)。
- IN-FLIGHT:什麼都還沒實作。前一個 session 在 `/l5` 的 prerequisites 做完後因 context 超過 rail 的 T2 交接;它設的 session-mode L5 marker 綁舊 session id,新 session 要自己再 `set`。
- `docs/HANDOFF.md` 是 2026-07-21 另一件事(closeout → llm-playground)的舊 handoff,未動。

## 已決事項(不重議)
- ADR 與 spec 分家:hangar 留決定,本 repo 留機制;兩邊不互相覆蓋,不一致就兩邊都改。
- 一個 pane 的唯一回程是 `agent-call` 登記(harness 不會拉信);沒登記就在第一次寄信時 lazy attach;operator 信箱只給 pane 外的寄件人 — operator 親自定的模型。
- 引擎路由(operator 指定):foreman = sonnet(`.claude/model-routing-config.md` `tree:sub-orchestrator`);implementer = agy `gemini-3.8-flash` effort low;qc panel = gpt-5.6-sol / MiniMax-M3 / glm-5.3(`.claude/review-loop-config.md`)。glm-5.2 在 z.ai 已被 alias 到 5.3,config 明寫 5.3。
- spec 不再送第六輪 panel:finding 已到實作粒度,改為 per-PR panel review。
- Out of scope 本輪:`dotfiles/bin/fleet`、`dotfiles/zsh/crew.zsh`、`@cookys/agent-call`、hangar `fleet-pulse` gate 欄位(其他 repo;寫進 handoff 的 TODO,不寫進程式碼)。
- `use_reply_verb` 與 §6 的拒絕全部放在 `HANGAR_RELAY_ADDRESS_RULES` flag 後面,預設 off。
- 不部署;停在 merge-ready 分支。

## 下一步
1. 在 `~/projects/hangar-bridge` 開 fresh session,先 `node ~/projects/autopilot/scripts/session-mode.js set --level l5 --repo-root ~/projects/hangar-bridge`,再讀 `~/projects/autopilot/skills/l5/references/hetero-impl-loop.md` 與 `skills/ceo-agent/references/level-front-door.md`(前一 session 讀到 §1.b 為止;§2 failure recovery、§3 qc@depth-0、§4 merge-back、Phase L、run-summary 尚未讀)。
2. 執行 `/l5`,goal 原文:
   > Implement hangar-bridge REPLY_ROUTING_SPEC.md v7 (branch off develop as feat/reply-routing; decision = hangar decisions/_global/0015 accepted). Scope: the §15 file-by-file change list, rollout step 1 + step 2 code only (relay route/grant/limiter/idem tables + migration/backfill, POST /v1/replies, GET /v1/inbox, POST /v1/grants/finalize, HANGAR_RELAY_ADDRESS_RULES flag default off; peer-agent reply_to_peer + send_to_peer changes + instructions text + audience report; shared envelope/channel changes; switchboard persisted instance + return selector + finalise-before-paste). Out of scope: dotfiles fleet/crew changes, @cookys/agent-call changes, fleet-pulse gate. TDD per the spec's numbered sections; admission = the repo's existing local gate sequence (pnpm -r typecheck / build / test:ci; hosted CI is off on purpose). Do NOT deploy; stop at a merge-ready branch.
3. 依 rail:campaign contract → `engine implement-review --campaign-contract`,foreman 派 sonnet(resolve-dispatch 已覆寫),每次背景 leaf 配對 dead-man timer;qc@depth-0 用 spec §15 的逐檔清單切 per-PR 大小的 diff 給 panel。

## 驗證方式
```
cd ~/projects/hangar-bridge && pnpm -r typecheck && pnpm -r build && pnpm -r test:ci
```
全綠,且 `git log develop..feat/reply-routing` 顯示依 spec §15 分檔的 commit;`node ~/projects/autopilot/bin/autopilot.js status task --root-run-id <campaign-root> --json` 的 `can_merge === true`。hosted CI 刻意關閉,不以它為準。

## Read-order
1. /home/cookys/projects/hangar-bridge/REPLY_ROUTING_SPEC.md — 全部;§3 資料模型、§5 reply 動詞、§8 住址模型、§13 錯誤碼、§15 逐檔清單是實作骨架。
2. /home/cookys/projects/hangar/decisions/_global/0015-fleet-reply-addresses-a-session.md — 決定與理由(短),spec 與它不一致時兩邊都改。
3. /home/cookys/projects/hangar-bridge/SUBJECT_ROUTING_SPEC.md — 現有 subject/ACL 語意,本 spec 明言不改它。
4. /home/cookys/projects/hangar-bridge/packages/relay/src/routes/messages.ts — 送信 chokepoint;stamping、ephemeral directed chat、self-target 註解都在這;「never positive routing」那段註解要重寫。
5. /home/cookys/projects/hangar-bridge/.claude/review-loop-config.md — roster 唯一來源。
6. /home/cookys/projects/hangar/log/2026-09.md § 2026-09-04 — 事件與 ADR/spec 十輪 panel 的完整紀錄。

## 陷阱
- codex gpt-5.6-sol xhigh 審 30–55 KB diff 要 15–25 分鐘;Bash tool 上限 10 分鐘會砍掉它。用 `setsid nohup … & disown` 加 done-marker,另起 `until [ -f done ]` 的背景 waiter。
- `pkill -f '<pattern>'` 的 pattern 若出現在自己的 zsh -c 指令行裡會殺掉自己(exit 144)。用 `ps -eo pid,args | grep … | grep -v snapshot-zsh` 取 pid 再 kill。
- glm-5.2/5.3 經 `dispatch-review.sh` 有 3/5 輪因自身輸出的 framing 文字被 parser 拒收(no_verdict);MiniMax-M3 xhigh 在 44 KB diff 上 15 分鐘會傳輸逾時,給 25 分鐘。
- `bin/fleet.sh run` 到 tcsh 主機(fr、pico)要包 `sh -c '…'`,否則 "Illegal variable name"。
- 用 python 逐句錨點改長文件會因換行位置不同反覆 assert 失敗;改用以 heading 為界的整節 regex 替換。
- agy headless 對 build/test 任務不可靠(memory:`feedback_agy_headless_dispatch_unreliable`);implementer 派 agy 是 operator 明定,verify 必須靠 git artifacts 與 `--verify-cmd`(pnpm gates),不信 agy 自述。
- cuda 上 `agent-call` 登記表曾有三個指向 `zsh` pane 的過期項(已清)。spec §8.1 的 harness 白名單就是為此;實作 switchboard 的 finalise/paste 時要以現行 `ac_taken` 檢查為底。
