# Division MCP Server

MCPサーバーでCursor、Antigravity、Claude DesktopからDivision APIを直接使えます。

## セットアップ

### 1. ビルド

```bash
cd mcp-server
npm install
npm run build
```

### 2. IDE設定

#### Cursor / Antigravity

`~/.cursor/mcp.json` または対応するMCP設定ファイルに追加：

```json
{
  "mcpServers": {
    "division": {
      "command": "node",
      "args": [
        "/Users/YOUR_USERNAME/Program/Division/mcp-server/dist/index.js"
      ],
      "env": {
        "DIVISION_API_URL": "https://api.division.he-ro.jp"
      }
    }
  }
}
```

#### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "division": {
      "command": "node",
      "args": [
        "/Users/YOUR_USERNAME/Program/Division/mcp-server/dist/index.js"
      ],
      "env": {
        "DIVISION_API_URL": "https://api.division.he-ro.jp"
      }
    }
  }
}
```

## 使えるツール

| ツール                  | 説明                               |
| ----------------------- | ---------------------------------- |
| `division_run`          | AIエージェントにタスクを実行させる |
| `division_list_models`  | 利用可能な全AIモデルを一覧表示     |
| `division_list_agents`  | プロジェクトのエージェント一覧     |
| `division_set_agent`    | ロールにAIプロバイダーを割り当て   |
| `division_health`       | APIの稼働状態を確認                |

## 使用例

IDEのAIアシスタントに：

> "division_runで「Reactブログアプリの設計」をお願い"

> "division_list_modelsで使えるモデルを見せて"

> "division_runで coding を gemini-3-pro に override して実行して"

## 既存プロジェクトの修正（workspacePath）

`division_run` に `workspacePath`（プロジェクトの絶対パス）を渡すと、このサーバーが
ローカルで実行されていることを利用してその場でファイルを読み込み、内容を
`localWorkspaceContext` として API に送信します。Division の API 自体はユーザーの
ディスクを直接読まないため、`workspacePath` を渡さないと coder / file-searcher は
既存ファイルの中身を一切参照できません（「元のファイルを読み込めていない」状態になります）。

> "division_runで workspacePath /Users/me/my-app の Header.tsx にダークモード切り替えを追加して"

`.git` / `node_modules` / ビルド成果物 / `.env*` / バイナリファイルは自動的に除外されます。
