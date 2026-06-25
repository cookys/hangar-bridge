# 同主機跨專案隔離 (Same-Box Cross-Project Isolation)

此文件說明如何在 `hangar-bridge` 中使用專案等級的 MCP 註冊與獨立的設定檔目錄，來達成同主機、跨專案的傳輸隔離。

## 適用情境 (When to Use)

預設情況下，同一台主機上的所有 `hangar-bridge` 會話 (Session) 都共享全域的身分識別（由該主機的 hostname 衍生）。在這種全域設定下，所有發往該主機的訊息或任務都會被配送到該主機上所有的作用中會話，而不會區分開發者正在處理哪一個專案。

當您在同一台主機上開發多個不同專案，並希望：
1. 發送給專案 A 的訊息/任務絕對不應進入專案 B 的會話環境中。
2. 每個專案都有獨立且唯一的識別碼（如：`<hostname>-<project-name>`）。

您應使用**專案等級的隔離機制**。

## 操作指南 (Walkthrough)

### 1. 初始化專案設定

在您的專案根目錄下，執行 `init-project` 命令：

```bash
hangar-bridge init-project <project-name> --relay <relay-url>
```

此指令會自動執行以下流程：
- 驗證 `<project-name>` 防止路徑穿越。
- 衍生出唯一的專案識別 Handle，格式通常為 `<hostname>-<project-name>`（並進行清理以符合 32 字元的 `HANDLE_REGEX` 限制）。
- 在 `$XDG_CONFIG_HOME/hangar-bridge/projects/<project-name>` 中建立專屬的設定檔目錄。
- 產生專案專用的載體密鑰 (Bearer Secret)。
- 在您指定的專案根目錄下寫入專案專屬的 `.mcp.json`。
- 設定嚴格的安全權限（目錄 `chmod 700`，設定檔 `chmod 600`）。

#### 可用參數說明
- `--relay <url>`：Relay 伺服器的 URL（若未指定，則預設讀取 `$HANGAR_RELAY`）。
- `--handle <value>`：覆蓋自動衍生的專案 Handle，手動指定身分識別。
- `--config-dir <abs>`：覆蓋預設的設定檔目錄位置。
- `--dir <project-root>`：要寫入 `.mcp.json` 的專案根目錄（預設為目前工作目錄）。
- `--force`：若該專案已存在密鑰，強制覆蓋並重新輪替密鑰。
- `--mcp-server-name <value>`：在 `.mcp.json` 中登記的伺服器名稱（預設為 `hangar-bridge-peers`）。

### 2. 設定 Relay 端

執行完 `init-project` 後，終端機會輸出一行 JSON 設定格式，此設定必須被加入到 Relay 的 `peers.json` 中：

```json
"your-derived-handle": { "secret_sha256_hex": "..." }
```

1. 打開 Relay 伺服器上的 `peers.json` 檔案。
2. 將上述輸出的整行內容加入該檔案中。
3. 重新啟動 `hangar-bridge-relay` 伺服器以套用變更。

### 3. 驗證

重啟 Relay 且在專案目錄下啟動 Claude Code 後，它將自動讀取專案專屬的 `.mcp.json` 中所帶有的 `HANGAR_CONFIG_DIR` 環境變數。

若要驗證專案身分已成功連線：
1. 在該專案的會話中觸發 presence 更新或寫入 summary。
2. 執行 `list_peers` 或檢查 Relay 的 `/v1/peers.online`，確認專案專屬的 Handle（如 `myhost-myproj`）已顯示為在線，而非原本的主機名。

### 4. 重新安裝與密鑰輪替規範

若您使用 `--force` 輪替專案的密鑰，您必須：
1. 複製命令輸出的最新 `peers.json` 項目。
2. 將 Relay 的 `peers.json` 內容更新為新雜湊值。
3. 重新啟動 Relay 伺服器。
