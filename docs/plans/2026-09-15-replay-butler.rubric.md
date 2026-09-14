# Rubric — Replay butler(plan `2026-09-15-replay-butler.md`)

Reviewer contract:每條以 PASS / FAIL 判定並附證據(plan 節號、或 `packages/**` 的 file:line)。
**禁止 argument-from-silence**:凡是關於現碼行為的斷言,必須實際讀檔(或執行)驗證,不得從
plan 文字推定;找不到證據就寫「未驗證」而不是「應該」。Blocker = 任一 FAIL 會讓實作出錯或
讓既有 client 壞掉;非 blocker 的改善寫成 Suggestion。

- R1: [problem is real] §0 對現況的描述與源碼一致:`packages/relay/src/routes/stream.ts` 的
  backlog drain 以 `BACKLOG_PAGE`(1000)分頁、迴圈到 `page.length < BACKLOG_PAGE`,無筆數上限、
  無年齡截止;`packages/peer-agent/src/index.ts` 的 `InboundDispatcher.emit` 對 claude-channel
  是每封一個 `server.notification`。若現碼已有任何 cap / 合併機制而 plan 漏看,FAIL。

- R2: [count on the relay] §2.1 選 relay-side(A)而非 peer-agent-side(B)的三條理由各自成立:
  (1) poll 路徑的可投遞判定(`messages.ts` `ownsNamespace`)與 stream 路徑(`deliverable`)口徑
  不同;(2) poll 是 presentation path,會 `insertGrants`;(3) 需兩次往返。任一理由與源碼不符 FAIL;
  若 reviewer 能指出 A 有 plan 未提的致命缺陷(例如 dry-run 與正式 drain 之間 live 訊息插入造成
  計數/游標不一致)且 plan 無防護,FAIL 並具體說明。

- R3: [backward compatibility] §2.2 的相容論證成立:`replay_max` 缺席 ⇒ relay 行為與今日完全相同;
  舊 peer-agent 的 SSE parser 對未知 `backlog` event 忽略而非 throw(需在 `packages/peer-agent/src/stream.ts`
  `readStream` 實際確認未知 event 的處理);舊 relay 對未知 query param 忽略。缺任一驗證 FAIL。

- R4: [cursor & delivered_at invariants] §2.3:略過的列不 stamp `delivered_at`、不 `insertGrants`;
  relay 連線游標跳到 `newest` 後 live fanout 正常;cold start(無 since)同樣受門檻約束。reviewer 須
  對照 `stream.ts` 現有 `writeAndMark` / `markDelivered` / `insertGrants` 的位置確認 plan 的「不需改」
  是真的,並檢查:被略過的列之後透過 `poll_inbox` 讀到時,poll 路徑會 grant —— 語意是否真的一致。

- R5: [cursor advance vs hold] §2.4 採「推進 cursor + 本機 pendingBacklog 記憶 + presence 尾綴」而非
  「停住」:論證(停住需記住已報批次、多一個漂移點)成立,且「忘了拉」的提醒需求已被 presence
  可見性覆蓋。若 reviewer 認為推進會造成**不可恢復的遺漏**(訊息永遠讀不到),必須指出具體路徑
  才算 FAIL;「可能忘記」不是 FAIL。

- R6: [poll-only parity] §2.5 `pending_after` 讓無 SSE 的 harness(ChatGPT courier)得到等價管家;
  欄位語意(next_cursor 之後、同 poll 口徑、上限 10 000)清楚,且舊 client 忽略新欄位。

- R7: [no kind split, no purge] §1 非目標的三個「不做」各有理由且不與 §2 矛盾:不做 TTL/purge、
  不按 kind 分流、不動 mailbox。若 reviewer 認為 task_dispatch 被摘要會破壞既有 dispatch 契約
  (`dispatchTracker` / task dedup / correlation),需引 file:line 說明,否則 PASS。

- R8: [tests are sufficient] §4 T1–T12 覆蓋:相容(T1、T11)、門檻兩側(T2、T3)、略過列不變性(T3)、
  live 續投(T4)、cold start(T5)、口徑一致(T6)、poll 總量(T7)、peer-agent 路徑(T8–T10)、
  積壓記憶(T12)。缺口(例如:`replay_max` 非法值 400;`pending` 上限 10 000 的截斷;switchboard
  摘要投遞)列為 Suggestion 或 Major,由 reviewer 判定是否 blocker。

- R9: [rollout order] §5 relay 先、peer-agent 後的順序是相容性的必然;走 `install-relay.sh` 而非手動
  build+restart 有明確理由(build_revision 漂移)。驗收步驟可執行。

- R10: [open risks are honest] §6 R-a–R-e 列的風險真實存在且沒有被 §2 偷偷當成已解決;reviewer 對
  每條給一句判斷(可忽略 / 需在實作前定案 / 需改 plan)。特別是 R-c(摘要被當訊息回覆)與 R-d
  (switchboard 廣播摘要過吵)。
