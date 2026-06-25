# 同主機跨專案隔離 (Same-Box Cross-Project Isolation)

此文件說明如何在 `hangar-bridge` 中使用專案等級的 MCP 註冊與獨立的設定檔目錄，來達成同主機、跨專案的傳輸隔離。

## 適用情境 (When to Use)

預設情況下，同一台主機上的全域 `hangar-bridge` 設定會共享同一個身分識別。若兩個 Claude Code 會話共用同一個 handle，Relay 無法知道訊息應該進入哪個專案。

當您在同一台主機上開發多個不同專案，並希望發送給專案 A 的訊息/任務絕對不進入專案 B，請使用**專案等級的隔離機制**。

## 操作指南 (Walkthrough)

### 1. 初始化專案設定

在專案根目錄下執行：

```bash
hangar-bridge init-project --relay <relay-url> --peers-file /path/to/peers.json
```

`init-project` 預設會從 `git remote get-url origin` 自動推導專案名稱：

- `git@github.com:cookys/foo.git` -> `cookys-foo`
- `https://github.com/kevin/foo.git` -> `kevin-foo`
- 沒有 origin 或 URL 無法解析時 -> 專案根目錄 basename

推導出的 `<name>` 會經過路徑穿越驗證，並用於：

- 設定檔目錄：`$XDG_CONFIG_HOME/hangar-bridge/projects/<name>`
- 預設 MCP server name：`hangar-bridge-peers-<name>`
- 預設 handle 衍生來源：`<hostname>-<name>`（清理後符合 32 字元 handle 限制）

常用覆蓋參數：

- `--name <value>`：覆蓋自動推導的專案名稱。
- `--handle <value>`：覆蓋自動衍生的 Relay handle。
- `--server-name <value>`：覆蓋 `.mcp.json` 中的 MCP server key。
- `--peers-file <path>`：讀取 Relay `peers.json`，初始化前檢查 handle 是否已存在。
- `--config-dir <dir>`：覆蓋預設設定檔目錄。
- `--dir <project-root>`：要寫入 `.mcp.json` 的專案根目錄（預設為目前工作目錄）。
- `--force`：允許覆蓋既有專案設定檔目錄並輪替密鑰。

### 2. Collision gate

初始化會在寫入任何檔案前檢查碰撞：

1. 若專案設定檔目錄已存在且未傳入 `--force`，指令會失敗。
2. 若 `--peers-file` 可讀且裡面已存在相同 handle，指令會失敗。

錯誤訊息會指出碰撞的 handle，並建議使用不同的 `--name` 或 `--handle`，例如 `--name foo-laptop`。若沒有提供可讀的 `--peers-file`，指令只會印出醒目警告；operator 必須手動確認 Relay 上沒有同名 handle，避免兩個專案靜默共用身分。

### 3. 設定 Relay 端

執行完 `init-project` 後，終端機會輸出一行 JSON 設定格式，此設定必須被加入 Relay 的 `peers.json`：

```json
"your-derived-handle": { "secret_sha256_hex": "..." }
```

更新 Relay `peers.json` 後，重新啟動 `hangar-bridge-relay` 以套用變更。

### 4. 啟動 Claude Code

`init-project` 會在專案根目錄寫入 `.mcp.json`，並以專案專屬 server key 登記 peer-agent。啟動 Claude Code 時指定該 key：

```bash
claude --dangerously-load-development-channels server:hangar-bridge-peers-<name>
```

若使用 `--server-name <value>`，請改用：

```bash
claude --dangerously-load-development-channels server:<value>
```

### 5. 驗證

重啟 Relay 且在專案目錄下啟動 Claude Code 後，它會讀取專案專屬 `.mcp.json` 中的 `HANGAR_CONFIG_DIR`。

若要驗證專案身分已成功連線：

1. 在該專案的會話中觸發 presence 更新或寫入 summary。
2. 執行 `list_peers` 或檢查 Relay 的 `/v1/peers.online`，確認專案專屬 handle 已顯示為在線，而非全域主機名。

### 6. 重新安裝與密鑰輪替規範

若使用 `--force` 輪替專案密鑰，必須：

1. 複製命令輸出的最新 `peers.json` 項目。
2. 將 Relay 的 `peers.json` 內容更新為新雜湊值。
3. 重新啟動 Relay 伺服器。
