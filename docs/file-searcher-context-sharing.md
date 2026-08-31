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

## 実装

| 場所 | 役割 |
| --- | --- |
| `src/services/project-context.ts` | パース / マージ / ロール別選択 / レンダリング |
| `src/services/orchestrator.ts` | サーバ側 orchestration への組み込み（stream / non-stream 両方） |
| `src/routes/tasks.ts` | 単発実行でも file-searcher に出力契約を付ける |
| `tests/project-context.test.ts` | 単体テスト |
| Orchestra `electron-main/llmMessage/divisionProjectContext.ts` | ローカル実行フロー用の移植版 |

Orchestra 側の移植版は Division 側と同じレポート形式を読み書きする。
**片方を変更したらもう片方も合わせて更新すること。**

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
```
