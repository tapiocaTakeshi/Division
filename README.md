# Division API

**AIエージェントオーケストレーション API**

1つのプロンプトを送るだけで、最適なAIモデルが自動で役割分担し、タスクを完遂します。

---

## 概要

Division APIは、複数のAIモデルを**役割ベース**で自動振り分けるオーケストレーションAPIです。

Leader AI がユーザーのリクエストを分析し、「検索」「設計」「コーディング」「レビュー」などのサブタスクに分解。各タスクを最適なAIモデルに割り当て、結果をチェーンして最終成果物を生成します。

```
ユーザー: 「クイズアプリを作って」
         ↓
    🧠 Leader AI (Gemini 2.5 Flash)
    タスクを分析・分解
         ↓
    ┌─────────────────────────────────────────────┐
    │  Step 1: 🔍 Search → Perplexity Sonar Pro   │
    │  Step 2: 📋 Planning → Gemini 2.5 Pro       │
    │  Step 3: 💻 Coding → Claude Sonnet 4.5      │
    │  Step 4: ✅ Review → GPT-4.1                │
    └─────────────────────────────────────────────┘
         ↓
    統合された成果物を返却
```

## エンドポイント

**Base URL**: `https://api.division.he-ro.jp`

### `POST /api/agent/run` — エージェント実行

AIにタスクを実行させます。

```json
{
  "projectId": "demo-project-001",
  "input": "クイズを投稿するアプリ「リドル」を作って",
  "overrides": {
    "coding": "claude-opus-4.6",
    "search": "grok-4.1-fast"
  }
}
```

**レスポンス:**

```json
{
  "sessionId": "860be374-a6a5-4682-b651-ae864188a491",
  "leaderProvider": "Gemini (Google)",
  "leaderModel": "gemini-2.5-flash",
  "status": "success",
  "totalDurationMs": 12450,
  "tasks": [
    {
      "role": "search",
      "provider": "Perplexity Sonar Pro",
      "model": "sonar-pro",
      "reason": "最新情報の収集",
      "output": "...",
      "status": "success",
      "durationMs": 3200
    }
  ]
}
```

### `POST /api/agent/stream` — マルチエージェントストリーミング

リアルタイムでマルチエージェントの実行状況をSSEストリームで受信できます。
依存関係のないタスクは**並列実行**されます。

```json
{
  "projectId": "demo-project-001",
  "input": "クイズアプリを作って",
  "format": "sse"
}
```

`format` は `"sse"`（デフォルト）または `"ndjson"` を指定可能です。

**イベント一覧:**

| イベント | 説明 |
| --- | --- |
| `session_start` | セッション開始（sessionId含む） |
| `leader_start` | Leader AIがタスク分解を開始 |
| `leader_chunk` | Leader AIからのストリーミングテキスト |
| `leader_done` | タスク分解完了（dependsOn含む依存関係情報） |
| `leader_error` | Leader AI失敗 |
| `wave_start` | 並列実行グループの開始（同時実行されるタスクのインデックス） |
| `task_start` | サブタスク実行開始（プロバイダー・入力情報含む） |
| `task_chunk` | サブタスクAIからのストリーミングテキスト |
| `task_done` | サブタスク完了（出力含む） |
| `task_error` | サブタスク失敗 |
| `wave_done` | 並列実行グループの完了 |
| `session_done` | 全タスク完了（集計結果含む） |
| `heartbeat` | 接続維持（15秒ごと） |

**SSEレスポンス例:**
```
event: session_start
data: {"type":"session_start","sessionId":"...","input":"...","leader":"Gemini (Google)"}

event: wave_start
data: {"type":"wave_start","wave":0,"taskIndices":[0,1]}

event: task_start
data: {"type":"task_start","index":0,"role":"search","provider":"Perplexity Sonar Pro"}

event: task_chunk
data: {"type":"task_chunk","index":0,"role":"search","text":"検索結果..."}

event: task_start
data: {"type":"task_start","index":1,"role":"planning","provider":"Gemini 2.5 Pro"}

event: task_chunk
data: {"type":"task_chunk","index":1,"role":"planning","text":"設計案..."}

event: task_done
data: {"type":"task_done","index":0,"role":"search","status":"success"}

event: task_done
data: {"type":"task_done","index":1,"role":"planning","status":"success"}

event: wave_done
data: {"type":"wave_done","wave":0,"taskIndices":[0,1]}

event: session_done
data: {"type":"session_done","status":"success","totalDurationMs":8200}
```

### `POST /api/generate` — 単一モデル生成

単一のAIモデルで直接テキスト生成（オーケストレーションなし）。

### `POST /api/generate/stream` — 単一モデルSSEストリーミング

単一のAIモデルでSSEストリーミング生成。

### `GET /api/models` — モデル一覧

利用可能な全AIモデルを取得します。

### `GET /health` — ヘルスチェック

### `POST /mcp` — MCP接続

IDE (Cursor, Antigravity, Claude Desktop) からMCPプロトコルで接続できます。

---

## 対応モデル（38モデル / 6プロバイダー）

| プロバイダー      | モデル                                                            |
| ----------------- | ----------------------------------------------------------------- |
| 🟣 **Anthropic**  | Claude Opus 4.6, Sonnet 4.5, Haiku 4.5, Sonnet 4, Opus 4, Haiku 3 |
| 🔵 **Google**     | Gemini 3 Pro/Flash, 2.5 Pro/Flash, 2.0 Flash                      |
| 🟢 **OpenAI**     | GPT-5.2, 5.1, 4.1/Mini/Nano, 4o/Mini, o3/Mini                     |
| 🟠 **Perplexity** | Deep Research, Reasoning Pro, Sonar Pro, Sonar                    |
| ⚫ **xAI**        | Grok 4.1 Fast, 4, 3, 3 Mini                                       |
| 🔴 **DeepSeek**   | V3.2, R1                                                          |

## 役割（ロール）

| ロール     | デフォルトAI         | 説明                     |
| ---------- | -------------------- | ------------------------ |
| `coding`   | Claude Sonnet 4.5    | コード生成・実装         |
| `search`   | Perplexity Sonar Pro | 情報検索・調査           |
| `planning` | Gemini 2.5 Pro       | 設計・アーキテクチャ     |
| `writing`  | Claude Sonnet 4.5    | ドキュメント・文章作成   |
| `review`   | GPT-4.1              | コードレビュー・品質確認 |
| `leader`   | Gemini 2.5 Flash     | タスク分解・統括         |

## overrides（モデル切り替え）

`overrides` パラメータで、特定の役割に使うAIを自由に切り替えできます。

```json
{
  "overrides": {
    "coding": "deepseek-r1",
    "search": "grok-4.1-fast",
    "review": "gpt-5.2",
    "planning": "gemini-3-pro"
  }
}
```

## MCP接続（IDE統合）

Cursor / Antigravity / Claude Desktop のMCP設定に追加するだけで使えます。

```json
{
  "mcpServers": {
    "division": {
      "url": "https://api.division.he-ro.jp/mcp"
    }
  }
}
```

### MCPツール

| ツール                 | 説明                                       |
| ---------------------- | ------------------------------------------ |
| `division_run`         | AIエージェントにタスクを実行させる         |
| `division_stream`      | ストリーミング付きでエージェントを実行する |
| `division_list_models` | 利用可能な全モデルを一覧表示               |
| `division_health`      | APIの稼働状態を確認                        |

---

## 技術スタック

- **Runtime**: Node.js + TypeScript
- **Framework**: Express
- **Database**: SQLite + Prisma ORM
- **Hosting**: Vercel (Serverless)
- **Protocol**: JSON-RPC 2.0 (MCP)
