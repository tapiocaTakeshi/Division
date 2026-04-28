/**
 * Coder ロール専用のガード処理。
 *
 * Coder（Anthropic Opus 4.6 など）はツール呼び出し型エージェントとして学習されているため、
 * tools を渡す / 「list_directory のような前置き探索を期待する文脈」を与えると、
 * 実コードではなく {"tool":"list_directory",...} のような JSON ツールコールを返してしまう。
 *
 * 本モジュールは orchestrator・/api/tasks/execute など複数経路から共通で使うガードを提供する。
 */

/**
 * Coder への入力に強制ガードを差し込む。System prompt が無視されたときの保険として、
 * ユーザーメッセージ側にも「前置き禁止・コードブロック必須・ツール禁止」を明記する。
 *
 * 既にガードが含まれている場合（多重ラップを防ぐ）はそのまま返す。
 */
export function wrapCoderInput(input: string): string {
  if (!input) return input;
  if (input.includes("## 出力ルール（最優先・無視不可）")) {
    return input;
  }
  const guardrails = `## 出力ルール（最優先・無視不可）
- このオーケストレーション環境では **bash / file_read / file_write / text_editor / list_directory / search 等のツールは一切利用できません**。「Let me look at...」「まず○○を調査します」「以下を確認します」のような調査・分析の前置きを書かず、与えられた情報だけで今すぐ最終成果物を出してください。
- **\`{"tool":"...","args":{...}}\` のような JSON ツールコールを返してはいけません**。返した場合はシステム上エラー扱いとなります。
- 応答の **最初の見出しは必ず \`### 1. 実装プラン\`** で始めてください。
- 応答には **必ず 1 つ以上の三連バッククォートで囲ったコードブロック** を含めてください。コードブロックが無い応答はシステム上エラー扱いとなり、同じ誤りを繰り返すとタスクが中止されます。
- ファイル本体は \`\`\`<lang>:<filepath> 形式（例: \`\`\`tsx:src/components/Foo.tsx）で **完全な内容** を出力してください。省略・「...」・「以下省略」は禁止です。
- 上流エージェント（file-searcher / Layer 2 / Leader Todos）の成果物に既に必要な情報が揃っています。追加の調査宣言は不要です。

## 既存コードの扱い（最優先）
- 入力に **「ローカルワークスペーススナップショット」** や **「file-searcher」のレポート** が含まれていれば、それが **このプロジェクトの現在の真実** です。
- ユーザーの依頼は基本的に「**既存サイト/アプリの修正・追加**」です。**ゼロから新規プロジェクトを作り直してはいけません**。
- 既存ファイルパス・既存コンポーネント名・既存 className / id・既存ディレクトリ構造をそのまま維持し、変更が必要な箇所だけを差分で更新してください。
- 上流エージェント（designer / planner など）の Markdown が「ミニマル」「モダン」等のテーマや新規構造を提案していても、**スナップショットに既存実装がある場合はそちらを優先**し、そのテーマは既存コードへの **修正方針として** 取り込んでください。
- スナップショットに該当ファイルが存在する場合は、その **完全な現行コードに最小限の修正を加えた完全版** を \`\`\`<lang>:<filepath> ブロックで出力してください。新規ファイルが必要なときだけ新規パスを使ってください。

---

`;
  return `${guardrails}${input}`;
}

/**
 * Coder の応答にコードブロックが含まれているかを判定する。
 * 含まれていなければ「単なる前置き応答 / ツールコール」とみなし、フィードバックループで再試行する。
 */
export function coderOutputHasCode(output: string): boolean {
  if (!output) return false;
  const trimmed = output.trim();
  if (!trimmed) return false;

  // Pure JSON tool-call response (e.g. {"tool":"list_directory","args":{"path":"."}})
  // は「コードあり」と判定してはいけない。
  if (/^```json\s*\n\s*\{\s*"tool"\s*:/i.test(trimmed)) return false;
  if (/^\s*\{\s*"tool"\s*:/i.test(trimmed) && trimmed.length < 300) return false;

  const fenceCount = (trimmed.match(/```/g) ?? []).length;
  if (fenceCount < 2) return false;

  // ファイル指定 (```ext:path) または bash / 何らかの言語ブロックがあるか
  const hasFileBlock = /```[A-Za-z0-9_+\-.]*:[^\s`]+/.test(trimmed);
  const hasNonJsonBlock = /```(?!json\s*\n\s*\{\s*"tool")/i.test(trimmed);
  return hasFileBlock || hasNonJsonBlock;
}

/**
 * Coder ロールに該当するかを判定する（alias 含む）。
 */
export function isCoderRoleSlug(slug: string | undefined | null): boolean {
  if (!slug) return false;
  const s = String(slug).trim().toLowerCase();
  return s === "coder" || s === "coding";
}
