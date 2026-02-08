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

| ツール                 | 説明                               |
| ---------------------- | ---------------------------------- |
| `division_run`         | AIエージェントにタスクを実行させる |
| `division_list_models` | 利用可能な全AIモデルを一覧表示     |
| `division_health`      | APIの稼働状態を確認                |

## 使用例

IDEのAIアシスタントに：

> "division_runで「Reactブログアプリの設計」をお願い"

> "division_list_modelsで使えるモデルを見せて"

> "division_runで coding を gemini-3-pro に override して実行して"
