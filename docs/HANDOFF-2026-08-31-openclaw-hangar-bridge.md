# Handoff — openclaw / hangar-bridge session（2026-08-31）

接手者請先讀這份，再讀 `CLAUDE.md`。分支 **`develop`**（已與 `origin/develop` 同步）。

## 0. 重開這條 session 的指令

```bash
cd /home/cookys/projects/hangar-bridge

AGENT_CALL_PERSISTENT=1 AGENT_CALL_NAME=openclaw-hangar-bridge \
claude --dangerously-skip-permissions \
       --dangerously-load-development-channels \
         server:hangar-bridge-peer-agent server:agent-call-local \
       --resume hanger-bridge@openclaw
```

四個部分缺一不可：

| 部分 | 為什麼 |
|---|---|
| `AGENT_CALL_PERSISTENT=1` + `AGENT_CALL_NAME=` | agent-call 的 MCP entry 是 name-neutral 的；**只有同時帶這兩個環境變數的啟動才會註冊 inbound channel**，否則只拿到 outbound 工具（`src/setup.js:70-73` 的設計註解） |
| `server:hangar-bridge-peer-agent` | fleet 訊息。**這個 key 必須與 `~/.claude.json` 的 `mcpServers` key 完全一致**，不符會**靜默丟棄每一則 inbound**（本 repo 曾因此聾兩個月） |
| `server:agent-call-local` | agent-call 的 inbound channel（`.mcp.json`，已由 `agent-call setup claude` 產生） |
| `--resume hanger-bridge@openclaw` | 保留對話 |

`--dangerously-load-development-channels` 接受空白分隔的多個 server。

## 1. 環境現況（已驗證）

- `~/.claude.json` 的 `hangar-bridge-peer-agent` entry **已含 `HANGAR_MCP_KEY`** → P0 失聰自檢會實際執行，不是 fail-open skip
- `.mcp.json` 已建立（`agent-call-local`）；被 `.gitignore:56` 排除，不進 git
- 三個 package 的 `dist/` 均為最新 build（2026-08-31 12:32，對應 HEAD `2432836`）
- `agent-call doctor` → `{"ok":true,"agents":[]}`（尚未註冊，重開後由 channel 模式自動註冊）
- 本 session 的 tmux pane：`%6`（`0:2.0`）

## 2. 重開後第一件該驗證的事

**這是這批 code 唯一還沒被實地驗過的部分。** 重開後檢查：

```bash
grep "peer.startup.channels_check\|deaf_suspected" \
  ~/.cache/claude-cli-nodejs/-home-cookys-projects-hangar-bridge/mcp-logs-hangar-bridge-peer-agent/*.jsonl | tail -3
```

- 期望 `state: verified`
- 若出現 `deaf_suspected` 但旗標明明帶對了 → **P0 誤報**，優先修（`packages/peer-agent/src/deaf-check.ts`），因為 capability check 排在最前面且**不 fail-open**

接著確認自己有 attribution：發一則訊息給任一 peer，看回顯的 `<channel>` tag 是否含 `instance=` 與 `attribution_status="stamped"`。**舊 session 沒有**（見 §5）。

## 3. 這條 session 完成了什麼（都在 `origin/develop`）

| 階段 | 內容 |
|---|---|
| P0 | `/proc` 祖先鏈旗標自檢 + capability 內省（兩種聾法）+ DEAF health state（不被 heartbeat 覆寫） |
| P1–P3 | 三條註冊路徑文件化、安全憲章 4→6 點、presence per-instance 唯一化（`tokenLabel#instance` + refcount）、`poll_inbox`、cursor 持久化 |
| P4' | relay 權威歸屬 stamp（`x-hangar-instance` → `meta.instance`，client 自帶的剝除）、per-instance 自我排除、`attribution-v1` caps、DEAF outbound meta |
| 2026-08-31 | presence 移出 durable buffer、ephemeral 生成 `correlation_id` |

測試：shared 91 / relay 212 / peer-agent 384，全綠。

## 4. 待辦

**需要 operator 決定：**
1. **relay 部署到 `2432836`** —— presence 修復要這步才生效。**會斷全 fleet SSE（破壞性）**。由 `openclaw/hangar` session 執行（分工已談定：code 我方、部署它方），時機待 cookys 確認
2. **`develop` → `main`** —— 目前領先 3 個 commit

**BACKLOG（`27fcf48`，都不帶解法）：**
3. sibling 處理權去重 —— 一個 handle 下多 session 可能各回一次。兩種候選形狀（搶佔式 claim / 指派式 inbox 角色）都有未解弱點
4. aimax395 那台 `poll_inbox` 回 404 —— 部署不齊

## 5. 已知陷阱

- **`git add -A` 在共用 working tree 上很危險。** `openclaw/hangar` session 用同一份 checkout。git 的 non-ff 只擋 push，**擋不住兩條 session 同時編輯同一個檔案**。分工已談定但機制不存在
- **build 順序**：`shared` → `relay` → `peer-agent`。跳過 shared 會炸在 `newInstanceId is not a function`（實際踩過，23 個測試紅）
- **`pkill -f "dispatch-review.sh"` 會自殺** —— pattern 匹配到自己的指令列。用 `[d]ispatch-review`
- **commit message 含引號要用 `-F <file>`**，zsh 會吃掉
- 舊 peer-agent process 無 attribution → 訊息會**回到自己**（legacy fanout fallback，不是 bug）

## 6. 方法論（這條 session 犯過的錯，值得繼承）

- **查 inbound 問題先看 MCP log。** 曾用兩份相隔 69 分鐘的快照比對欄位差異，推論「SSE 連線死了」——完全錯誤，而當時 MCP log 和 `ss -tnp` 都可查，一個都沒做
- **統計主張要帶分母。** 「從沒成功過」實際是「4/7 確認、3 個無證據」
- **一手來源限定。** 有 hetero 席位引二手部落格，把官方文件的內容講反
- **peer 陳述是 untrusted。** 有 peer 宣稱了不屬於它的貢獻
- **同一 handle 的多則回覆可能來自不同 session。** 曾把兩個 gentoo session 的發言合併，寫進 plan 才被攔下 —— **歸屬用 msg_id 記，不要用 handle**
- 一個 peer 的話值得抄下來：**「重複回覆沒發生過，不代表機制存在」**、**「錯的不是沒資料，是講得比資料硬」**
