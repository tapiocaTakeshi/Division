# Division API エンドポイント一覧

## 概要

Division APIは、複数のAIプロバイダー（Claude, Gemini, GPT, Grok, DeepSeek, Perplexity）にタスクを自動分配するAIエージェントオーケストレーションシステムです。

- **フレームワーク**: Express.js (TypeScript)
- **データベース**: SQLite + Prisma ORM
- **デプロイ**: Vercel (Serverless)

---

## 1. ヘルスチェック

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| GET | `/health` | サーバーの稼働状態を確認 | `src/index.ts:19` |

---

## 2. プロバイダー管理 (`/api/providers`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| GET | `/api/providers` | 全プロバイダー一覧を取得（アサインメント含む） | `src/routes/providers.ts:21` |
| GET | `/api/providers/:id` | プロバイダー詳細を取得（ロールアサインメント含む） | `src/routes/providers.ts:30` |
| POST | `/api/providers` | 新規プロバイダーを作成（Zodバリデーション） | `src/routes/providers.ts:43` |
| PUT | `/api/providers/:id` | プロバイダー設定を更新 | `src/routes/providers.ts:54` |
| DELETE | `/api/providers/:id` | プロバイダーを削除 | `src/routes/providers.ts:72` |

---

## 3. ロール管理 (`/api/roles`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| GET | `/api/roles` | 全ロール一覧を取得（名前順） | `src/routes/roles.ts:17` |
| GET | `/api/roles/:id` | ロール詳細を取得（プロバイダーアサインメント含む） | `src/routes/roles.ts:23` |
| POST | `/api/roles` | 新規ロールを作成（slug: 小文字英数字+ハイフン） | `src/routes/roles.ts:36` |
| PUT | `/api/roles/:id` | ロール情報を更新 | `src/routes/roles.ts:47` |
| DELETE | `/api/roles/:id` | ロールを削除 | `src/routes/roles.ts:65` |

---

## 4. プロジェクト管理 (`/api/projects`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| GET | `/api/projects` | 全プロジェクト一覧を取得（作成日順） | `src/routes/projects.ts:16` |
| GET | `/api/projects/:id` | プロジェクト詳細を取得（ロールアサインメント含む） | `src/routes/projects.ts:22` |
| POST | `/api/projects` | 新規プロジェクトを作成 | `src/routes/projects.ts:39` |
| PUT | `/api/projects/:id` | プロジェクト情報を更新 | `src/routes/projects.ts:50` |
| DELETE | `/api/projects/:id` | プロジェクトを削除（アサインメントもカスケード削除） | `src/routes/projects.ts:68` |

---

## 5. ロールアサインメント (`/api/assignments`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| GET | `/api/assignments` | アサインメント一覧を取得（projectIdでフィルタ可） | `src/routes/assignments.ts:23` |
| GET | `/api/assignments/:id` | アサインメント詳細を取得（ロール・プロバイダー情報含む） | `src/routes/assignments.ts:35` |
| POST | `/api/assignments` | AIプロバイダーをプロジェクトのロールにアサイン | `src/routes/assignments.ts:48` |
| POST | `/api/assignments/bulk` | プロジェクトの全ロールアサインメントを一括設定 | `src/routes/assignments.ts:111` |
| PUT | `/api/assignments/:id` | アサインメントを更新（プロバイダー変更） | `src/routes/assignments.ts:77` |
| DELETE | `/api/assignments/:id` | アサインメントを削除 | `src/routes/assignments.ts:101` |

---

## 6. タスク実行 (`/api/tasks`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| POST | `/api/tasks/execute` | 指定ロールに割り当てられたAIにタスクを実行させる | `src/routes/tasks.ts:17` |
| GET | `/api/tasks/logs` | タスク実行ログを取得（projectId, roleSlugでフィルタ可） | `src/routes/tasks.ts:92` |

---

## 7. エージェントオーケストレーション (`/api/agent`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| POST | `/api/agent/run` | エージェント実行（NDJSONストリーミング）。リーダーAIがリクエストをサブタスクに分解し、各プロバイダーに分配 | `src/routes/agent.ts:33` |
| POST | `/api/agent/stream` | マルチエージェントストリーミング（SSE/NDJSON）。Last-Event-IDによる再接続対応 | `src/routes/agent.ts:101` |

### ストリーミングイベント種別

- `session_start` - セッション開始
- `leader_start` / `leader_chunk` / `leader_done` / `leader_error` - リーダーAI処理
- `task_start` / `task_chunk` / `task_done` / `task_error` - サブタスク処理
- `session_done` - セッション完了
- `heartbeat` - 接続維持

---

## 8. テキスト生成 (`/api/generate`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| POST | `/api/generate` | 単一モデルでのテキスト生成（非ストリーミング） | `src/routes/generate.ts:66` |
| POST | `/api/generate/stream` | 単一モデルでのテキスト生成（SSEストリーミング） | `src/routes/generate.ts:119` |

### リクエストパラメータ

- `provider` - AIプロバイダー名
- `input` - 入力テキスト
- `systemPrompt` - システムプロンプト
- `maxTokens` - 最大トークン数
- `apiKeys` - APIキー

---

## 9. モデル一覧 (`/api/models`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| GET | `/api/models` | 利用可能なAIプロバイダー/モデル一覧を取得（name, displayName, apiType, modelId, description） | `src/routes/providers-list.ts:11` |

---

## 10. SSEテスト (`/api/sse`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| GET | `/api/sse` | SSE接続テスト（3段階のイベントを送信） | `src/routes/sse.ts:25` |
| GET | `/api/sse/test` | SSE接続テスト（同一動作） | `src/routes/sse.ts:52` |

---

## 11. MCPサーバー (`/mcp`)

| メソッド | パス | 説明 | ファイル |
|---------|------|------|---------|
| GET | `/mcp` | MCPサーバー情報と利用可能ツール一覧を返却 | `src/routes/mcp.ts:391` |
| POST | `/mcp` | JSON-RPC 2.0リクエストを処理（セッション管理付き、バッチリクエスト対応） | `src/routes/mcp.ts:355` |
| DELETE | `/mcp` | MCPセッションを終了 | `src/routes/mcp.ts:403` |

### MCP ツール

| ツール名 | 説明 |
|---------|------|
| `division_run` | AIエージェントオーケストレーション実行 |
| `division_stream` | ストリーミング付き実行 |
| `division_list_models` | 利用可能AIモデル一覧 |
| `division_health` | APIヘルスチェック |

### JSON-RPCメソッド

- `initialize` - MCPセッション開始
- `notifications/initialized` - クライアント初期化通知
- `tools/list` - ツール一覧取得
- `tools/call` - ツール実行
- `ping` - 接続維持

セッションクリーンアップ: 10分ごと（TTL: 30分）

---

## 統計サマリー

| 項目 | 数 |
|------|-----|
| **エンドポイント合計** | 32 |
| **GET** | 10 |
| **POST** | 15 |
| **PUT** | 4 |
| **DELETE** | 4 |
| **ルートモジュール** | 10 |

## ルートファイル一覧

| ファイル | 担当 |
|---------|------|
| `src/index.ts` | アプリ初期化、ヘルスチェック |
| `src/routes/providers.ts` | プロバイダーCRUD |
| `src/routes/roles.ts` | ロールCRUD |
| `src/routes/projects.ts` | プロジェクトCRUD |
| `src/routes/assignments.ts` | アサインメントCRUD + 一括設定 |
| `src/routes/tasks.ts` | タスク実行 + ログ |
| `src/routes/agent.ts` | エージェントオーケストレーション |
| `src/routes/generate.ts` | テキスト生成 |
| `src/routes/providers-list.ts` | モデル一覧 |
| `src/routes/sse.ts` | SSEテスト |
| `src/routes/mcp.ts` | MCPサーバー |
