# FileSearcher のコンテキスト共有

## 何を解決したか

以前は file-searcher の成果物が 2 通りの扱いしかされていなかった。

1. Leader が `dependsOn` を張ったロールにだけ、**レポート全文** がそのまま渡る
2. `dependsOn` を張られなかったロールには **何も渡らない**

1 はトークンが跳ね上がる。100 ファイル分の本文を coder / reviewer / tester …
全員に配れば同じ内容を何度も課金することになるし、各ロールは大量の情報に埋もれて
「本当に必要なファイルはどれか」を見失う。Orchestra 側のローカル実行フローでは
レポートを 8,000 文字で機械的に切り詰めていたため、真ん中にあるファイル一覧ごと
消えてしまうことすらあった。

2 は逆に、Leader が依存を書き忘れただけで reviewer が既存実装を知らないまま
レビューする、という事故になる。

## 方針

**基本的には全ロールに渡す。ただし全ロールに無条件で全文を渡さない。**

file-searcher の出力を構造化コンテキストに変換し、3 段階に分けて配布する。

```
                  User Request
                       │
                       ▼
                    Planner
                       │
                       ▼
                  FileSearcher
                       │
              Project Context (構造化)
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
      Coder        Reviewer        Tester
        │              │              │
        └──────────────┼──────────────┘
                       ▼
                     Result
```

### Level 1 — 共有コンテキスト（全ロールに無条件）

サマリ / ファイル一覧 / 依存関係 / 主要シンボル。パスと関係性だけなので安価。

```json
{
  "summary": "...",
  "relevant_files": [{ "path": "src/auth/Auth.ts", "reason": "認証処理の中心" }],
  "dependencies": ["src/pages/Login.tsx -> src/auth/AuthProvider.tsx"],
  "symbols": ["Auth.login", "AuthProvider"]
}
```

### Level 2 — ロール別の関連ファイル（本文つき）

同じ調査結果から、ロールごとに必要なファイルだけを本文つきで渡す。

| ロール | 優先して渡すもの | 本文予算 |
| --- | --- | --- |
| coder | `src/` `app/` `lib/` `components/` `pages/` `api/` | 60,000 字 |
| reviewer | 実装コード（テストは副次） | 40,000 字 |
| tester | テスト / spec / e2e | 40,000 字 |
| security-reviewer | auth / token / session / env / middleware | 40,000 字 |
| designer | component / style / css / tsx / html | 30,000 字 |
| writer, documenter | README / docs / md | 20,000 字 |
| planner, leader, ideaman, searcher, researcher | 本文なし（Level 1 のみ） | 0 |
| 上記以外 | 関連度上位のファイル | 16,000 字 |

### Level 3 — 必要になったら実ファイルを読む

Level 1 には「ここに本文が無いファイルはツールで読める」と明記してある。
各ロールは自分の `read_file` / `search_files` で追加取得する。

## FileSearcher は Context Manager

file-searcher は 1 度きりの検索役ではない。

- 実行の中に file-searcher タスクが複数あってもよい
- 2 回目以降の結果は既存コンテキストを **上書きせずマージ** する
  （ファイル一覧・依存関係・シンボル・本文が積み上がる）
- 非 file-searcher タスクは、原則すべての file-searcher タスクの完了を待ってから
  開始する。Leader が `dependsOn` を書き忘れても「まず調査 → 全ロールが参照」が成立する。
  ただし当の file-searcher 自身が依存しているタスク（例: 先行する planner）は待たないので、
  循環待ちにはならない。

## 誰に何を渡すかは Leader が決め、API がルールで制約する

配分の判断は Leader AI に任せてよい。ただし完全に自由にすると不安定になるので、
二重構造にする。

```
        Leader AI
           │
     「これを渡したい」
           │
           ▼
    ┌──────────────┐
    │ Policy Layer │
    └──────┬───────┘
           │
       許可 / 制限
           │
           ▼
          Role
```

### Leader が決めること

各タスクに任意で `context` を書ける。

```json
{
  "tasks": [
    { "role": "file-searcher", "input": "認証関連ファイルを探す", "dependsOn": [] },
    { "role": "coder", "input": "Googleログインを実装", "dependsOn": [0],
      "context": ["src/auth/Auth.ts", "src/pages/Login.tsx"] },
    { "role": "reviewer", "input": "認証実装をレビュー", "dependsOn": [1],
      "context": ["src/auth/Auth.ts", "src/pages/Login.tsx", "src/auth/Auth.test.ts"] }
  ]
}
```

省略した場合はロール別の自動選択にフォールバックする。

### FileSearcher の結果は Leader に戻す

最初のプランを立てる時点では、Leader はまだファイル名を知らない。そこで
file-searcher が終わった直後に、共有コンテキスト（Level 1）を Leader へ戻し、
**配分だけ**をもう一度決めさせる。

```
User → Leader →「FileSearcher に調査させよう」→ FileSearcher → 検索結果
     → Leader →「この情報なら Coder には A,B,C を渡そう」→ Coder
```

1 実行につき 1 回。応答が壊れていても致命ではなく、自動選択に戻るだけ。

### Policy Layer が決めること

Leader の判断では動かせないもの。`src/services/context-policy.ts` が
Leader の指名・ロールの Pull 要求・自動選択のすべてを同じゲートに通す。

| 項目 | 挙動 |
| --- | --- |
| 秘密情報 | `.env` / `*.pem` / `id_rsa` / `service-account*.json` などは本文を配らない（パスと理由だけ伝える）。`.env.example` は対象外 |
| 秘密の値 | 普通のソースに紛れた API キー・トークン・秘密鍵は行単位でマスクし、本文自体は配る |
| ファイルサイズ | 1 ファイル 12,000 字で打ち切り |
| コンテキスト上限 | ロール別の本文予算（coder 60k / reviewer 40k / …）と 40 ファイル |
| ロール権限 | 本文を受け取らないロール（planner / searcher 等）、ロール別の拒否パス（designer にマイグレーション SQL を渡さない等） |
| 循環防止 | Pull 型の要求は 1 タスク 2 回・1 実行 6 回まで。同じ要求の繰り返しは検出して止める |

弾いたファイルは黙って消さず、理由つきで伝える。黙って消すとロールは
「存在しない」と誤解してゼロから書き直しにいく。

## Pull 型 — ロールから要求する

Leader が全部決めるだけでなく、ロール側からも要求できる。

```
Coder →「Auth.ts が必要」→ Policy Layer → FileSearcher の成果 → Coder
```

各ロールのコンテキスト末尾に要求フォーマットが付く。

```json context-request
{ "paths": ["src/auth/Auth.ts"], "reason": "実装に必要" }
```

要求が通ると、追加ファイルを添えて同じタスクをもう一度だけ実行する。再実行は
記憶の無い新しい呼び出しなので、前回渡した分も含めて全部渡し直す。

## 役割分担

| 誰 | 何を |
| --- | --- |
| Leader AI | 司令官。タスク分解・ロール選択・コンテキスト配分 |
| 各 Role | 専門家。自分の担当を遂行し、足りなければ要求する |
| Division API | 通信・オーケストレーション基盤 + Policy Layer |
| Orchestra Main Process | 現場の実行部隊。実ファイルの読み書き |

## 実装

| 場所 | 役割 |
| --- | --- |
| `src/services/project-context.ts` | パース / マージ / ロール別選択 / レンダリング |
| `src/services/context-policy.ts` | Policy Layer（秘密情報 / サイズ / 権限 / 上限 / 循環防止）と Pull 要求の読み取り |
| `src/services/orchestrator.ts` | サーバ側 orchestration への組み込み（stream / non-stream 両方）、Leader への配分ステップ、Pull 型の再実行 |
| `src/routes/tasks.ts` | 単発実行でも file-searcher に出力契約を付ける |
| `src/routes/task-create.ts` | Leader が書いた `context` を作成レスポンスに載せる |
| `tests/project-context.test.ts` | 単体テスト 15 件 |
| `tests/context-policy.test.ts` | 単体テスト 20 件 |
| Orchestra `electron-main/llmMessage/divisionProjectContext.ts` | ローカル実行フロー用の移植版 |
| Orchestra `electron-main/llmMessage/divisionContextPolicy.ts` | Policy Layer の移植版 |

Orchestra 側の移植版は Division 側と同じレポート形式・同じルールを使う。
**片方を変更したらもう片方も合わせて更新すること。**

`task-create` が返す `context` は Task テーブルには保存していない。実行側が
受け取って即座に使うためのもので、実際に何が渡ったかはポリシー適用後の
実行側の記録が正となる。

### 出力契約

file-searcher のタスク入力には `FILE_SEARCHER_OUTPUT_CONTRACT` が自動で付与され、
レポート末尾に ` ```json division-context ` ブロックを出すよう指示される。
モデルがこれを守らなかった場合も、Markdown 側から

- `### \`path/to/file\`` + コードフェンス → ファイル本文
- ディレクトリツリーや本文中のパス表記 → ファイル一覧
- `import` / `require` 文 → 依存エッジ
- `export function|class|const|...` → シンボル

をヒューリスティックに復元するので、契約は必須ではない。

## テスト

```bash
npx ts-node --transpileOnly tests/project-context.test.ts
npx ts-node --transpileOnly tests/context-policy.test.ts
```
