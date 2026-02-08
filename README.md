# 🤖 AI Role Division API

AIモデルに**役割分担**させるためのREST APIです。

```
コーディング → Claude
検索         → Perplexity
企画         → Gemini
執筆         → Claude
レビュー     → GPT
```

## 🚀 セットアップ

```bash
# 1. 依存パッケージのインストール
npm install

# 2. Prismaクライアント生成 & DB作成
npx prisma generate
npx prisma migrate dev --name init

# 3. デモデータ投入
npm run db:seed

# 4. サーバー起動
npm run dev
# => http://localhost:3000
```

## 📡 APIエンドポイント

### ヘルスチェック

```
GET /health
```

### プロバイダー (AIモデル)

| メソッド | パス                 | 説明     |
| -------- | -------------------- | -------- |
| `GET`    | `/api/providers`     | 一覧取得 |
| `GET`    | `/api/providers/:id` | 詳細取得 |
| `POST`   | `/api/providers`     | 新規作成 |
| `PUT`    | `/api/providers/:id` | 更新     |
| `DELETE` | `/api/providers/:id` | 削除     |

### 役割 (ロール)

| メソッド | パス             | 説明     |
| -------- | ---------------- | -------- |
| `GET`    | `/api/roles`     | 一覧取得 |
| `GET`    | `/api/roles/:id` | 詳細取得 |
| `POST`   | `/api/roles`     | 新規作成 |
| `PUT`    | `/api/roles/:id` | 更新     |
| `DELETE` | `/api/roles/:id` | 削除     |

### プロジェクト

| メソッド | パス                | 説明                     |
| -------- | ------------------- | ------------------------ |
| `GET`    | `/api/projects`     | 一覧取得                 |
| `GET`    | `/api/projects/:id` | 詳細取得（割り当て込み） |
| `POST`   | `/api/projects`     | 新規作成                 |
| `PUT`    | `/api/projects/:id` | 更新                     |
| `DELETE` | `/api/projects/:id` | 削除                     |

### 役割割り当て

| メソッド | パス                    | 説明                                |
| -------- | ----------------------- | ----------------------------------- |
| `GET`    | `/api/assignments`      | 一覧取得 (`?projectId=` で絞り込み) |
| `POST`   | `/api/assignments`      | 新規割り当て                        |
| `POST`   | `/api/assignments/bulk` | 一括割り当て                        |
| `PUT`    | `/api/assignments/:id`  | 割り当て変更                        |
| `DELETE` | `/api/assignments/:id`  | 割り当て削除                        |

### エージェント（自律実行）

| メソッド | パス             | 説明                            |
| -------- | ---------------- | ------------------------------- |
| `POST`   | `/api/agent/run` | **1回のリクエストで全自動実行** |

### タスク実行

| メソッド | パス                 | 説明                                     |
| -------- | -------------------- | ---------------------------------------- |
| `POST`   | `/api/tasks/execute` | タスクを実行（役割に応じたAIが自動選択） |
| `GET`    | `/api/tasks/logs`    | 実行ログ取得                             |

## 💡 使い方の例

### 🤖 エージェント自律実行（おすすめ）

1回リクエストするだけで、Leader AI（Gemini）がタスクを分解し、各専門AIに自動振り分け：

```bash
curl -X POST http://localhost:3000/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "demo-project-001",
    "input": "Reactでブログアプリを作って"
  }'
```

→ Leader(Gemini)が自動でタスク分解：

1. **search** → Perplexity（情報収集）
2. **planning** → Gemini（設計）
3. **coding** → Claude（実装）
4. **review** → GPT（レビュー）

### 🔄 役割ごとのAIを変更（overrides）

リクエスト時に `overrides` で特定の役割のAIを切り替え可能：

```bash
curl -X POST http://localhost:3000/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "demo-project-001",
    "input": "Pythonの基本を教えて",
    "overrides": {
      "coding": "gemini",
      "search": "gpt"
    }
  }'
```

→ coding を Claude → **Gemini** に、search を Perplexity → **GPT** に変更して実行

### 手動タスク実行（コーディング担当のAIに依頼）

```bash
curl -X POST http://localhost:3000/api/tasks/execute \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "demo-project-001",
    "roleSlug": "coding",
    "input": "FizzBuzzをTypeScriptで書いて"
  }'
```

→ `coding` の役割に割り当てられた **Claude** が自動的に選ばれます。

### 検索担当のAIに依頼

```bash
curl -X POST http://localhost:3000/api/tasks/execute \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "demo-project-001",
    "roleSlug": "search",
    "input": "2024年のAIトレンドを調べて"
  }'
```

→ `search` の役割に割り当てられた **Perplexity** が自動的に選ばれます。

### APIキー付きで実際に実行

```bash
curl -X POST http://localhost:3000/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "demo-project-001",
    "input": "Reactでブログアプリを作って",
    "apiKeys": {
      "gemini": "AIza...",
      "claude": "sk-ant-...",
      "perplexity": "pplx-...",
      "gpt": "sk-..."
    }
  }'
```

> **Note**: APIキーなしの場合は **dry-run モード** で動作し、実際のAPI呼び出しは行わずリクエスト内容を返します。

## 🏗️ アーキテクチャ

```
ユーザー: 「Reactでブログアプリを作って」
        │
        ▼
  ┌──────────────────────────────────────────┐
  │  Leader AI (Gemini)                      │
  │  タスクを分析 → サブタスクに分解         │
  └──────────┬───────────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────┐
  │  Orchestrator（自動振り分け）             │
  │                                          │
  │  1. search   → Perplexity（情報収集）    │
  │  2. planning → Gemini（設計）            │
  │  3. coding   → Claude（実装）            │
  │  4. review   → GPT（レビュー）           │
  │                                          │
  │  ※ 前のタスクの結果が次のタスクに渡る    │
  └──────────────────────────────────────────┘
        │
        ▼
  統合レスポンス（全タスク結果のまとめ）
```

## 🛠️ テクノロジースタック

- **Runtime**: Node.js + TypeScript
- **Framework**: Express
- **ORM**: Prisma (SQLite)
- **Validation**: Zod
- **対応AI**: Anthropic Claude, OpenAI GPT, Google Gemini, Perplexity
