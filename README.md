# Division API

**AIエージェントオーケストレーション API**

1つのプロンプトを送るだけで、最適なAIモデルが自動で役割分担し、タスクを完遂します。

---

## 概要

Division APIは、複数のAIモデルを**役割ベース**で自動振り分けるオーケストレーションAPIです。

Leader AI がユーザーのリクエストを分析し、**固定4段パイプライン**に沿ってサブタスクへ分解。T1(調査)→T2(設計)の結果を Coder/Writer が統合し、最後に Reviewer が最終版を生成します。

```
ユーザー: 「クイズアプリを作って」
         ↓
    🧠 Leader (タスクを分析・分解 + finalRole を決定)
         ↓
    T1 ┌──────────────────────────────────────────────┐
       │  💡 Ideaman     → Claude     ┐              │
       │  🔍 Search      → Perplexity ├─ 並列実行     │
       │  📂 File Search → GPT        │              │
       │  🔬 Deep Research → Perplexity ┘            │
       └──────────────────────────────────────────────┘
         ↓ Markdown
    T2 ┌──────────────────────────────────────────────┐
       │  🎨 Design     → Gemini      ┐              │
       │  🖼  Image      → GPT Image   ├─ 並列実行     │
       │  📐 Planning   → Gemini      ┘              │
       └──────────────────────────────────────────────┘
         ↓ Markdown
    T3  ✍️ Writer / 💻 Coder   (統合ステップ: Code or Text を生成)
         ↓
    T4  🔎 Reviewer            (レビュー・最終版を生成)
         ↓ result
    ユーザーに最終成果物を Markdown で返却
```

## エンドポイント

**Base URL**: `https://api.division.he-ro.jp`

### エージェント実行

#### `POST /api/agent/stream` — マルチエージェントストリーミング

リアルタイムでマルチエージェントの実行状況をSSEストリームで受信できます。
依存関係のないタスクは**並列実行**され、最後に合成ステップで統合されます。

```bash
curl -N -X POST https://api.division.he-ro.jp/api/agent/stream \
  -H "Authorization: Bearer div_..." \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "your-project-id",
    "input": "クイズアプリを作って",
    "format": "sse"
  }'
```

`format` は `"sse"`（デフォルト）または `"ndjson"` を指定可能です。

**イベント一覧:**

| イベント           | 説明                                                         |
| ------------------ | ------------------------------------------------------------ |
| `session_start`    | セッション開始（sessionId含む）                              |
| `leader_start`     | Leader AIがタスク分解を開始                                  |
| `leader_chunk`     | Leader AIからのストリーミングテキスト                        |
| `leader_done`      | タスク分解完了（dependsOn含む依存関係、finalRole情報）       |
| `leader_error`     | Leader AI失敗                                                |
| `wave_start`       | 並列実行グループの開始（同時実行されるタスクID）             |
| `task_start`       | サブタスク実行開始（プロバイダー・入力情報含む）             |
| `task_chunk`       | サブタスクAIからのストリーミングテキスト                     |
| `task_thinking_chunk` | サブタスクAIの思考プロセス（Anthropic等）                 |
| `task_done`        | サブタスク完了（出力含む）                                   |
| `task_error`       | サブタスク失敗                                               |
| `wave_done`        | 並列実行グループの完了                                       |
| `synthesis_start`  | T3 合成ステップ開始（Coder/Writerが全出力を統合）            |
| `synthesis_chunk`  | 合成AIからのストリーミングテキスト                           |
| `synthesis_done`   | 合成完了（T3: Code or Text）                                  |
| `review_start`     | T4 レビューステップ開始（Reviewerが最終版を生成）            |
| `review_chunk`     | レビューAIからのストリーミングテキスト                       |
| `review_done`      | レビュー完了（最終版Markdown出力 = ユーザーに届く result）   |
| `session_done`     | 全タスク完了（`synthesisOutput` と `finalOutput` を含む）    |
| `heartbeat`        | 接続維持（15秒ごと）                                         |

#### `POST /api/agent/run` — エージェント実行（非ストリーム）

NDJSONで結果を返します。

```bash
curl -X POST https://api.division.he-ro.jp/api/agent/run \
  -H "Authorization: Bearer div_..." \
  -H "Content-Type: application/json" \
  -d '{"projectId": "your-project-id", "input": "FizzBuzzを書いて"}'
```

### モデル管理

| エンドポイント                        | メソッド | 説明                                           |
| ------------------------------------- | -------- | ---------------------------------------------- |
| `/api/models`                         | GET      | DB上の全プロバイダー/モデル一覧                |
| `/api/models/available`               | GET      | プロバイダーAPIから取得した利用可能モデル一覧   |
| `/api/models/available?provider=openai`| GET     | 特定プロバイダーのモデルのみ                    |
| `/api/models/provider/:providerId`    | GET      | プロバイダー別モデルリスト（キャッシュ付き）   |
| `/api/models/sync`                    | POST     | プロバイダーAPIからモデルをDBに同期             |

モデルリストは **インメモリキャッシュ (TTL: 1時間)** で高速に返却されます。
また、**Vercel Cron Job** により毎日 UTC 04:00 に自動同期されます。

### その他

| エンドポイント       | メソッド | 説明                                       |
| -------------------- | -------- | ------------------------------------------ |
| `/api/generate`      | POST     | 単一AIモデルで直接テキスト生成             |
| `/api/generate/stream` | POST   | 単一AIモデルでSSEストリーミング生成        |
| `/api/providers`     | GET      | プロバイダーCRUD                           |
| `/api/roles`         | GET      | ロールCRUD                                 |
| `/api/assignments`   | GET      | ロール割当CRUD                             |
| `/api/projects`      | GET      | プロジェクトCRUD（認証ユーザーのみ）       |
| `/health`            | GET      | ヘルスチェック                             |
| `/mcp`               | POST     | MCP接続                                   |

---

## 対応モデル（145+ / 6プロバイダー）

プロバイダーAPIからリアルタイムで取得。モデル数は自動同期により常に最新です。

| プロバイダー      | 主要モデル                                                        |
| ----------------- | ----------------------------------------------------------------- |
| 🟢 **OpenAI**     | GPT-4.1, GPT-4.1 Mini/Nano, GPT-4o, o3/Mini, GPT Image 1         |
| 🟣 **Anthropic**  | Claude Opus 4, Sonnet 4.5, Haiku 4.5                              |
| 🔵 **Google**     | Gemini 2.5 Pro/Flash, Gemini 2.0 Flash                            |
| 🟠 **Perplexity** | Sonar Deep Research, Sonar Reasoning Pro, Sonar Pro                |
| ⚫ **xAI**        | Grok 4, Grok 3/Mini                                               |
| 🔴 **DeepSeek**   | DeepSeek Chat (V3), DeepSeek Reasoner (R1)                        |

## 役割（ロール）

| ロール          | デフォルトAI              | 説明                                         |
| --------------- | ------------------------- | -------------------------------------------- |
| `leader`        | GPT-4.1                   | タスク分解・統括・finalRole決定               |
| `coding`        | Claude                    | コード生成・実装・デバッグ                   |
| `search`        | Perplexity Sonar Pro      | ウェブ検索・情報収集                         |
| `file-search`   | GPT-4.1                   | ファイル検索・コード解析・既存コード理解     |
| `planning`      | Gemini                    | 企画・設計・戦略立案                         |
| `writing`       | OpenAI                    | 文章作成・ドキュメント                       |
| `review`        | Gemini                    | レビュー・品質確認                           |
| `deep-research` | Perplexity Deep Research  | 徹底調査・包括的分析                         |
| `image`         | GPT Image 1               | 画像生成・ビジュアルコンテンツ               |
| `ideaman`       | Claude                    | アイデア発想・ブレインストーミング           |
| `design`        | Gemini                    | UI/UX設計・ワイヤーフレーム・デザインシステム |

### パイプライン段階

| 段階 | ロール例                                                   | 役割                                             |
| ---- | ---------------------------------------------------------- | ------------------------------------------------ |
| T1   | `ideaman`, `search`, `file-search`, `deep-research`       | 調査・発想（並列）                               |
| T2   | `design`, `image`, `planning`                              | 設計・ビジュアル（並列 / T1の成果を受けて動作） |
| T3   | `coding` (=coder) または `writing` (=writer)              | Leaderが指定した finalRole で T1+T2 を統合       |
| T4   | `review`                                                   | T3成果物をレビューし最終版(result)を生成         |

T1・T2のみ Leader が `tasks[]` に列挙します。T3(合成) と T4(レビュー) は自動で付与されるため、Leaderが明示する必要はありません。

## overrides（モデル切り替え）

`overrides` パラメータで、特定の役割に使うAIを自由に切り替えできます。

```json
{
  "overrides": {
    "coding": "deepseek-r1",
    "search": "grok-3",
    "review": "gpt-4.1",
    "planning": "gemini-2.5-pro"
  }
}
```

## 認証

Authorization ヘッダーに Division API キーを含めます。

```
Authorization: Bearer div_...
```

`div_` プレフィックスと `ak_` プレフィックスの両方のAPIキーに対応しています。
認証済みリクエストではサーバー側の環境変数から各プロバイダーのAPIキーが自動解決されます。

## MCP接続（IDE統合）

Cursor / Antigravity / Claude Desktop のMCP設定に追加するだけで使えます。

```json
{
  "mcpServers": {
    "division": {
      "url": "https://api.division.he-ro.jp/mcp?key=div_..."
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

## フロントエンド (Conductor UI)

Division Conductor はマルチエージェントオーケストレーションのWebフロントエンドです。

- Google認証（Supabase Auth）
- リアルタイムSSEストリーミング表示
- Wave ベースの並列実行ビジュアライゼーション
- 合成ステップの Markdown レンダリング
- 指揮者モード（エージェント全体俯瞰）
- パイプラインビルダー / テンプレート

## 技術スタック

- **Runtime**: Node.js + TypeScript
- **Framework**: Express
- **Database**: PostgreSQL (Supabase) + Prisma ORM
- **Frontend**: React + Vite + Zustand + Tailwind CSS
- **Hosting**: Vercel (Serverless + Cron Jobs)
- **Protocol**: JSON-RPC 2.0 (MCP), SSE (Server-Sent Events)
- **Auth**: Supabase Auth (Google OAuth)
