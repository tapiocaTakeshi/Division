/**
 * Orchestrator Service
 *
 * Autonomous agent orchestration:
 * 1. Leader AI analyzes the user's request and decomposes it into sub-tasks
 * 2. Each sub-task is dispatched to the assigned AI provider
 * 3. Results from previous tasks are passed as context to subsequent tasks
 * 4. All results are aggregated into a unified response
 */

import { prisma } from "../db";
import { executeTask, executeTaskStream } from "./ai-executor";
import type { ChatMessage } from "./ai-executor";
import { logger } from "../utils/logger";
import { recordUsage, estimateTokens } from "./credits";
import { resolveProvider } from "./provider-resolver";
import {
  wrapCoderInput as sharedWrapCoderInput,
  coderOutputHasCode as sharedCoderOutputHasCode,
} from "./coder-guard";

// --- Role Alias Mapping ---
const ROLE_ALIASES: Record<string, string> = {
  "deep-research": "researcher",
  "planning": "planner",
  "coding": "coder",
  "design": "designer",
  "search": "searcher",
  "file-search": "file-searcher",
  "research": "researcher",
  "review": "reviewer",
  "writing": "writer",
  "image": "imager",
};

// --- Role-Specific Max Tokens ---
// 各ロールに割り当てられているモデルの output 上限に合わせて最大化する。
//  - Anthropic Opus 4.6  : 32,000
//  - Google  Gemini 2.5 Pro: 65,536
//  - OpenAI  GPT-5.x      : 131,072
//  - Perplexity sonar-pro : 8,192
const ROLE_MAX_TOKENS: Record<string, number> = {
  // Gemini 2.5 Pro (HTML / Markdown / 画像メタ)
  designer: 65536,
  imager: 65536,
  planner: 65536,
  planning: 65536,
  "design": 65536,

  // Anthropic Opus 4.6 (コード・レビュー・ファイル調査の Markdown)
  coder: 32000,
  coding: 32000,
  reviewer: 32000,
  "review": 32000,
  "file-searcher": 32000,
  "file-search": 32000,

  // OpenAI GPT-5.x (Leader / Writer / Ideaman の Markdown)
  writer: 131072,
  writing: 131072,
  ideaman: 131072,
  leader: 131072,

  // Perplexity sonar-pro (Web 検索系)
  searcher: 8192,
  search: 8192,
  researcher: 8192,
  research: 8192,
  "deep-research": 8192,
};

// --- Synthesis Max Tokens (used when coder/writer is the final synthesizer) ---
// 統合は最終成果物なのでモデルの上限まで使い切る。
const ROLE_SYNTHESIS_MAX_TOKENS: Record<string, number> = {
  coder: 32000,         // Opus 4.6
  writer: 131072,       // GPT-5.x
  designer: 65536,      // Gemini 2.5 Pro
};

// Role 別の system prompt は Supabase の Role.systemPrompt を必ず使用する（フォールバック無し）。
// Coder ガードは coder-guard.ts に切り出し済み。
const wrapCoderInput = sharedWrapCoderInput;
const coderOutputHasCode = sharedCoderOutputHasCode;

function normalizeRoleSlug(slug: string): string {
  const raw = String(slug ?? "").trim();
  if (!raw) return "";
  const canon = raw.toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  return ROLE_ALIASES[canon] ?? canon;
}

/**
 * `RoleAssignment.config` は JSON 文字列 `{"model":"..."}` を想定しているが、
 * 実データには古い形式（モデル ID をそのまま保存したプレーン文字列: `"gpt-5.4"` 等）
 * が混在している。JSON.parse がそのまま落ちると Leader が常に失敗するため、
 * 安全に吸収する。
 */
function parseAssignmentConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to legacy handling */
    }
  }
  // Legacy data: assignment.config stored only the model id as a plain string.
  return { model: text };
}

/**
 * file-searcher は ai-executor 内でスナップショットを結合するためここでは付与しない。
 * それ以外（coder / writer / designer など）は Leader のサブタスク文だけでは本文を参照できず、
 * 元コードを完全に無視した「ゼロから書き直し」になりやすい。常に同じスナップショットを直接付与する。
 *
 * 以前は coder / computer_use のときも ai-executor が結合する想定でスキップしていたが、
 * 実際の executeTask / executeTaskStream は file-searcher 専用処理しか持っておらず
 * coder にスナップショットが渡らないバグになっていたため、coder にも付与する。
 */
function attachLocalWorkspaceToSubtaskInput(
  roleSlug: string,
  _mode: string | undefined,
  enrichedInput: string,
  bundle: string | undefined
): string {
  const b = (bundle || "").trim();
  if (!b) return enrichedInput;
  if (roleSlug === "file-searcher") return enrichedInput;
  return `# ローカルワークスペーススナップショット（クライアントが提供。API はユーザーの PC を直接読みません）

> **重要**: このスナップショットがあなたのプロジェクトの「現在の真実」です。新規にゼロから作り直さず、必要な箇所だけを差分で更新してください。既存ファイルパス・既存スタイル・既存コンポーネント名を必ず維持してください。

${b}

---

## このタスクでの指示

${enrichedInput}`;
}

// --- Types ---

export interface SubTask {
  role: string;
  mode: string;
  input: string;
  reason: string;
  /** Zero-based indices of tasks that must complete before this one starts */
  dependsOn?: number[];
}

export interface SubTaskResult extends SubTask {
  provider: string;
  model: string;
  output: string;
  status: "success" | "error";
  errorMsg?: string;
  durationMs: number;
  thinking?: string;
  citations?: string[];
  previewUrl?: string;
}

export interface OrchestratorRequest {
  projectId: string;
  input: string;
  apiKeys?: Record<string, string>;
  /** Override provider for specific roles */
  overrides?: Record<string, string>;
  /** Chat history for context (previous user/assistant messages) */
  chatHistory?: ChatMessage[];
  /** When true, server-side env var provider keys are used */
  authenticated?: boolean;
  /** Clerk user ID for credit tracking */
  userId?: string;
  /** Absolute path to user's workspace for file-search / coder tools */
  workspacePath?: string;
  /**
   * クライアント（IDE/CLI）がローカルで収集したワークスペース本文。指定時は API はディスクを読まない。
   */
  localWorkspaceContext?: string;
}

/** Leader への追記: 実行モード（本番は IDE スナップショット前提） */
function augmentLeaderInput(req: OrchestratorRequest): string {
  let s = req.input;
  if (req.localWorkspaceContext?.trim()) {
    s +=
      "\n\n【実行モード】IDE/CLI 連携: リクエストに `localWorkspaceContext`（ローカルで収集したワークスペーススナップショット）が付きます。API サーバーはユーザーの PC のパスを直接読みません。file-searcher はこのスナップショットを根拠に詳細な Markdown レポートを書いてください。";
  } else if (req.workspacePath) {
    s += `\n\n【実行モード】workspacePath=${req.workspacePath} が渡されます。API プロセスがそのマシン上でパスにアクセスできるときだけサーバー側ファイルツールが使えます（Vercel 等の本番では通常不可）。本番では localWorkspaceContext の利用を推奨します。`;
  }
  return s;
}

export interface OrchestratorResult {
  sessionId: string;
  input: string;
  leaderProvider: string;
  leaderModel: string;
  tasks: SubTaskResult[];
  mindmap: string;
  finalOutput?: string;
  finalCode?: string;
  totalDurationMs: number;
  status: "success" | "partial" | "error";
}

// --- Leader Prompt ---

const LEADER_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下のフローに基づいてタスクを分解してください。

## パイプライン構造（必ずこの順序で多層化する）

【Layer 1 — 調査・発想・初回スキャン】並列実行（dependsOn: []）
- ideaman: 創造的ブレインストーミング・アイデア出し・革新的コンセプト提案（Claude担当）
- searcher: ウェブ検索・情報収集（Perplexity担当）
- researcher: 調査・分析・レポート（Perplexity Deep Research担当）
- file-searcher（**初回スキャン**）: プロジェクト内の **すべてのフォルダ・ファイル** を最初から読み込み、構造・既存実装・変更候補・注意点を Markdown レポートにまとめる（GPT担当）

【Layer 2 — 設計・デザイン】Layer 1 の Markdown 出力に直接依存
- designer: UI/UXデザイン・HTML/CSS生成・ランディングページ・プロトタイプ（Gemini担当。完全に自己完結したHTMLを生成）
- imager: 画像生成・ビジュアルコンテンツ・イラスト（GPT Image担当）
- planner: 企画・設計・アーキテクチャ・戦略立案（Gemini担当）

【Leader Todos】Layer 2 → Layer 3 のハンドオフで Leader が自動挿入（tasksには含めない）
- Leader は file-searcher（初回） / designer / imager / planner の Markdown を受け取り、2回目の File Search に渡す具体的な Todos Markdown を自動生成する。

【Layer 3 — File Search（再調査）】Layer 2 に依存
- file-searcher（**集中再調査**）: Layer 2 の設計・画像・計画と Leader Todos を元に、変更対象ファイル・既存実装の差分・注意点を集中的に調査し、Coder/Writer がそのまま実装できる詳細な Markdown レポートを作成する（GPT担当）

【Layer 4 — 実装・執筆】Layer 3 の集中再調査に依存
- coder: コード生成・実装・デバッグ（Claude担当）
- writer: 文章作成・ドキュメント（Claude担当）

【Leader Review Brief】Layer 4 → Layer 5 のハンドオフで Leader が自動挿入（tasksには含めない）
- Leader は coder / writer の出力を受け、Reviewer が短時間で評価できる Review Brief を生成する。OK なら Reviewer に渡し、Not OK なら Coder/Writer に差し戻す。

【Layer 5 — レビュー】Layer 4に依存
- reviewer: 品質確認・レビュー・改善提案（GPT担当）※ dependsOn には必ず「レビュー対象の coder または writer」のタスク index を含める

【最終統合】reviewer 完了後に自動実行（tasksに含めない）

【オーケストラの自動動作】初回の DAG 完了後、reviewer が Not OK の場合は reviewer → file-searcher（**集中再調査・Layer 3** が指摘を踏まえ再実行）→ coder/writer（修正・改善）→ Leader Review Brief（指摘要約）→ reviewer（再レビュー）のループを reviewer が OK を出すまで（最大20周。環境変数 REVIEWER_CODER_MAX_ROUNDS で変更可、0で無効、上限50）実行します。Brief Gate が Not OK の場合は Coder/Writer のみ再実行します。タスク本数の増減は不要です。

## 利用可能なロール一覧
ideaman, searcher, researcher, file-searcher, designer, imager, planner, coder, writer, reviewer

## ルール
1. 各タスクには0始まりのインデックスが付与されます（0, 1, 2...）
2. dependsOn で依存先のインデックスを指定。空=並列実行
3. **【必須】file-searcher を 2 タスク含めること**:
   - 1 つ目（**初回スキャン**）: Layer 1 に置く。dependsOn: [] で ideaman/searcher/researcher と並列実行する。input には「プロジェクト内のすべてのフォルダ・ファイルを読み込んで構造を把握する」ことを必ず含める。
   - 2 つ目（**集中再調査**）: Layer 3 に置く。dependsOn には Layer 2（designer/imager/planner）の index を含める。input には「Layer 2 の設計を踏まえて、変更対象ファイルと差分を集中的に調査する」ことを必ず含める。
4. **【必須】Layer 1 には ideaman, searcher, researcher, file-searcher（初回）を必ず1タスクずつ含め、すべて dependsOn: [] で並列実行すること。Layer 2 には designer, imager, planner を必ず1タスクずつ含め、Layer 1 のすべての index に依存させること。Leader Todos / Leader Review Brief はオーケストラが自動生成するため tasks には含めないこと。**
5. 各タスクのinputはそのロールのAIに直接渡す具体的な指示にすること。
6. 必ず以下のJSON形式のみで回答。挨拶や説明文は【絶対に】出力しない
7. タスクは最低5個以上。複雑な場合は8〜15個に細分化
8. 1タスクに複数作業を詰め込まず細かく分割
9. 同じロールでも異なる観点なら別タスクに分ける
10. 各タスクに "mode" を指定:
    - "chat": テキスト生成タスク（デフォルト。searcher, researcher, file-searcher 等もこれ）
    - "computer_use": コード実行・テストが必要なタスク（coder ロール用）
    - "function_calling": 使用しない（廃止）
    ※ searcher / researcher ロールは Perplexity が Web 検索するため mode="chat" にすること
11. "finalRole" を必ず指定:
    - "coder": コードが主な成果物の場合
    - "writer": ドキュメント・文章が主な成果物の場合

\`\`\`json
{
  "tasks": [
    { "role": "ideaman", "mode": "chat", "input": "ユーザーのリクエストに対する革新的なアプローチを複数提案", "reason": "多角的な視点を得るため", "dependsOn": [] },
    { "role": "searcher", "mode": "chat", "input": "技術的な実現可能性と最新のベストプラクティスを検索", "reason": "正確な前提知識を得るため", "dependsOn": [] },
    { "role": "researcher", "mode": "chat", "input": "関連する技術トレンドと事例を調査", "reason": "深い理解を得るため", "dependsOn": [] },
    { "role": "file-searcher", "mode": "chat", "input": "プロジェクト内のすべてのフォルダ・ファイルを読み込み、構造・既存実装・変更候補・注意点を Markdown レポートにまとめる（初回スキャン）", "reason": "サーチ／リサーチと同じタイミングで既存コードベース全体を把握するため", "dependsOn": [] },
    { "role": "designer", "mode": "chat", "input": "Layer 1 の調査・既存コードを元にUIデザインとプロトタイプHTMLを作成", "reason": "ビジュアルイメージを具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "imager", "mode": "chat", "input": "Layer 1 の調査・デザイン方針を元に必要な画像/ビジュアル案を作成", "reason": "視覚要素を具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "planner", "mode": "chat", "input": "Layer 1 の調査・既存コードを元に要件定義と設計を作成", "reason": "実装の方向性を決めるため", "dependsOn": [0, 1, 2, 3] },
    { "role": "file-searcher", "mode": "chat", "input": "Layer 2 の設計・画像・計画と Leader Todos を元に、変更対象ファイル・既存実装の差分・注意点を集中的に調査して Coder/Writer 向け Markdown レポートを作成する（集中再調査）", "reason": "設計後に変更対象を絞り込んで実装の指示書を作るため", "dependsOn": [4, 5, 6] },
    { "role": "coder", "mode": "computer_use", "input": "Layer 3 の集中再調査の指示に沿って実装", "reason": "動作するコードを生成するため", "dependsOn": [7] },
    { "role": "reviewer", "mode": "chat", "input": "実装結果の品質確認と改善提案。OK/Not OK を明示する", "reason": "品質保証のため", "dependsOn": [8] }
  ],
  "finalRole": "coder"
}
\`\`\``;

// --- Synthesis Prompt ---

const SYNTHESIS_SYSTEM_PROMPT = `あなたは優秀な統合担当AIです。
複数の専門AIエージェントが並列で作業した結果が以下に提供されます。
これらの全出力を統合し、ユーザーの元のリクエストに対する**最終的な成果物**を生成してください。

ルール:
1. 必ず Markdown 形式で出力してください
2. 各エージェントの出力から重要な情報を抽出し、矛盾があれば最も正確な情報を採用してください
3. コードが含まれる場合はコードブロック内に正しい言語タグを付けてください
4. 見出し・リスト・表などを適切に使い、読みやすく構造化してください
5. 冗長な重複は排除し、簡潔で実用的な成果物にまとめてください
6. ユーザーのリクエストに直接答える形で出力してください`;

const LEADER_TODOS_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。
ユーザーのリクエストと（あれば）上流エージェントのMarkdownを統合し、File Search エージェントに渡すための実行可能な Todos Markdown を作成してください。

ルール:
1. 出力は Markdown のみ。
2. 最初に "## Todos" 見出しを置く。
3. **File Search はサーチ／リサーチと同じタイミングで実行されるため、まずプロジェクト内のすべてのフォルダ・ファイルを読み込んで全体構造を把握すること** をTodosの先頭に必ず明記する。
4. その後で、ユーザーのリクエストに関連する重点ファイル、検索キーワード、確認観点、実装/執筆前の注意点を具体化する。
5. Coder/Writer が後続で迷わないよう、優先順位と完了条件を明示する。
6. ツール呼び出しやJSONは出力しない。`;

const LEADER_REVIEW_BRIEF_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。
Coder または Writer の成果物を Leader として品質ゲートで評価し、Reviewer に渡せる状態か判断したうえで、Reviewer 向けの Review Brief をテキストで作成してください。

ルール:
1. 出力は厳密に次の3行以上のテキスト形式:
   1行目: "VERDICT: OK" または "VERDICT: Not OK" のいずれか。
   2行目以降: "FEEDBACK:" セクション（Not OKの場合は File Search に何を再調査させるか具体的に。OKの場合は "(なし)" でよい）。
   その後: "BRIEF:" セクション。Reviewer に渡す Review Brief を書く。
2. BRIEF には「ユーザー要求の要点」「実装/執筆の概要」「変更ファイルや主要セクション」「Reviewer に確認してほしい観点」を順に書く。
3. 成果物がユーザー要求を満たしていない、致命的な欠落・誤り・矛盾がある、テスト/検証が不十分な場合は VERDICT を "Not OK" にする。
4. コードや本文の全文転載はしない。重要な抜粋のみ。
5. BRIEF 全体は概ね 100〜400 行に収める。
6. ツール呼び出しやJSONは出力しない。`;

const LEADER_PROGRESS_CHECK_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。
Brief Gate ループの進捗を確認し、次の反復に進むべきか、何にフォーカスすべきかを判断してください。

ルール:
1. 出力は次の3行以上のテキスト形式:
   1行目: "DECISION: CONTINUE" または "DECISION: ABORT" のいずれか。
   2行目以降: "FOCUS:" セクション。次の反復で File Search / Coder / Writer に重点的に対応してほしいポイントを箇条書きで書く。
   その後: "REASON:" セクション。判断の理由を簡潔に書く。
2. 同じ問題が3回以上繰り返されている、改善が見られない、根本的な要件不一致がある場合は ABORT を選ぶ。
3. それ以外は CONTINUE を選び、具体的な FOCUS を提示する。
4. ツール呼び出しやJSONは出力しない。`;

function isFileSearcherTask(task: SubTask): boolean {
  return normalizeRoleSlug(task.role) === "file-searcher";
}

/**
 * Layer 3 の「集中再調査」file-searcher か判定する。
 * Layer 1 の「初回スキャン」file-searcher（dependsOn が空）は Leader Todos を要らないので除外する。
 * オーケストレータの再投入（reviewer feedback ループ）でも override 経由で再実行されるが、
 * その場合は dependsOn は元のまま（Layer 2 deps）が残るので focused と判定される。
 */
function isFocusedFileSearcherTask(task: SubTask): boolean {
  if (!isFileSearcherTask(task)) return false;
  const deps = task.dependsOn || [];
  return deps.length > 0;
}

function isReviewerTask(task: SubTask): boolean {
  return normalizeRoleSlug(task.role) === "reviewer";
}

function hasImplementationDependency(task: SubTask, allTasks: SubTask[]): boolean {
  const deps = task.dependsOn || [];
  return deps.some((d) => {
    const upstream = allTasks[d];
    if (!upstream) return false;
    return isImplementationTask(upstream);
  });
}

function buildDependencyMarkdown(
  task: SubTask,
  taskOutputs: string[],
  taskRoleNames: string[],
  taskProviderNames: string[]
): string {
  const deps = task.dependsOn || [];
  const contextParts: string[] = [];
  for (const depIdx of deps) {
    if (taskOutputs[depIdx]) {
      contextParts.push(`### ${taskRoleNames[depIdx]} (${taskProviderNames[depIdx]}):\n${taskOutputs[depIdx]}`);
    }
  }
  return contextParts.join("\n\n");
}

// --- Reviewer ↔ Coder フィードバックループ（初回 DAG 完了後）---

function getReviewerCoderMaxRounds(): number {
  const raw = process.env.REVIEWER_CODER_MAX_ROUNDS;
  if (raw === undefined || raw === "") return 20;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(50, n);
}

/**
 * 最後の reviewer と、その review 対象にできる coder を解決（reviewer.dependsOn を優先）。
 */
function isImplementationTask(t: SubTask): boolean {
  const role = normalizeRoleSlug(t.role);
  return role === "coder" || role === "writer" || t.mode === "computer_use";
}

function reviewerLooksOk(reviewText: string): boolean {
  const text = reviewText.toLowerCase();
  if (/\bnot\s+ok\b/.test(text) || /not\s+okay/.test(text) || /ng\b/.test(text)) return false;
  if (text.includes("不合格") || text.includes("要修正") || text.includes("未対応")) return false;
  return /\bok\b/.test(text) || text.includes("合格") || text.includes("問題なし") || text.includes("承認");
}

/**
 * file-searcher が 2 タスク構成（Layer 1 の初回スキャン + Layer 3 の集中再調査）に
 * なるよう正規化する。具体的には:
 *  - "primary"  file-searcher: Layer 1（dependsOn 空）。プロジェクト全体を最初に読む。
 *  - "focused"  file-searcher: Layer 3（dependsOn = Layer 2）。設計を踏まえて再調査。
 *
 * Leader が出してきたタスクの dependsOn を見て、Layer 2（designer/imager/planner）に
 * 依存している file-searcher を "focused"、そうでないものを "primary" に分類する。
 * どちらかが欠けていれば自動で挿入する。
 */
function normalizeDiagramFlow(tasks: SubTask[]): SubTask[] {
  const layer1RoleSet = new Set(["ideaman", "searcher", "researcher"]);
  const layer2RoleSet = new Set(["designer", "imager", "planner"]);

  let primaryFsOldIdx = -1;
  let focusedFsOldIdx = -1;
  for (let i = 0; i < tasks.length; i++) {
    if (normalizeRoleSlug(tasks[i].role) !== "file-searcher") continue;
    const deps = tasks[i].dependsOn || [];
    const hasLayer2Dep = deps.some((d) => {
      const u = tasks[d];
      return u && layer2RoleSet.has(normalizeRoleSlug(u.role));
    });
    if (hasLayer2Dep) {
      if (focusedFsOldIdx < 0) focusedFsOldIdx = i;
    } else {
      if (primaryFsOldIdx < 0) primaryFsOldIdx = i;
    }
  }

  const base: SubTask[] = tasks.map((t) => ({ ...t }));

  if (primaryFsOldIdx < 0) {
    base.push({
      role: "file-searcher",
      mode: "chat",
      input:
        "プロジェクト内のすべてのフォルダ・ファイルを最初から読み込んで構造を把握し、ユーザーのリクエストに関連する既存実装・変更候補・注意点を Markdown レポートにまとめる。",
      reason: "Layer 1: サーチ／リサーチと同じタイミングで既存コードベース全体を把握するため",
      dependsOn: [],
    });
    primaryFsOldIdx = base.length - 1;
  }

  if (focusedFsOldIdx < 0) {
    base.push({
      role: "file-searcher",
      mode: "chat",
      input:
        "Layer 2 の設計・画像・計画と Leader Todos を元に、変更対象ファイル・既存実装の差分・注意点を集中的に調査し、Coder/Writer がそのまま実装できる詳細な Markdown レポートを作成する。",
      reason: "Layer 3: 設計後の集中再調査（Coder/Writer の直前指示）",
      dependsOn: [],
    });
    focusedFsOldIdx = base.length - 1;
  }

  const groupOf = (task: SubTask, oldIndex: number): number => {
    if (oldIndex === primaryFsOldIdx) return 0;
    if (oldIndex === focusedFsOldIdx) return 2;
    const role = normalizeRoleSlug(task.role);
    if (layer1RoleSet.has(role)) return 0;
    if (layer2RoleSet.has(role)) return 1;
    if (isImplementationTask(task)) return 3;
    if (role === "reviewer") return 4;
    return 1;
  };

  const orderedWithMeta = base
    .map((task, oldIndex) => ({
      task,
      oldIndex,
      group: groupOf(task, oldIndex),
      isPrimary: oldIndex === primaryFsOldIdx,
      isFocused: oldIndex === focusedFsOldIdx,
    }))
    .sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      return a.oldIndex - b.oldIndex;
    });

  const ordered = orderedWithMeta.map(({ task }) => ({ ...task }));

  const newPrimaryFsIdx = orderedWithMeta.findIndex((m) => m.isPrimary);
  const newFocusedFsIdx = orderedWithMeta.findIndex((m) => m.isFocused);

  const indicesByGroup = (group: number) =>
    orderedWithMeta.map((m, i) => (m.group === group ? i : -1)).filter((i) => i >= 0);

  const layer1Indices = indicesByGroup(0);
  const layer2Indices = indicesByGroup(1);
  const implementerIndices = indicesByGroup(3);
  const reviewerIndices = indicesByGroup(4);

  const dedupSorted = (arr: number[]) =>
    Array.from(new Set(arr)).sort((a, b) => a - b);

  for (let i = 0; i < ordered.length; i++) {
    if (i === newFocusedFsIdx) {
      // Layer 3: focused file-searcher は Layer 2 の設計に依存
      ordered[i].dependsOn = layer2Indices.length ? [...layer2Indices] : [...layer1Indices];
    } else if (layer1Indices.includes(i)) {
      // Layer 1: primary file-searcher を含む全員が並列実行
      ordered[i].dependsOn = [];
    } else if (layer2Indices.includes(i)) {
      // Layer 2: Layer 1 全体（primary file-searcher を含む）に依存
      ordered[i].dependsOn = layer1Indices.length ? [...layer1Indices] : [];
    } else if (implementerIndices.includes(i)) {
      // Layer 4: Coder/Writer は focused file-searcher にのみ依存
      // （focused は既に Layer 2 の設計・primary の全体スキャンを取り込んだ Markdown を返す）
      const deps =
        newFocusedFsIdx >= 0
          ? [newFocusedFsIdx]
          : layer2Indices.length
          ? [...layer2Indices]
          : [...layer1Indices];
      ordered[i].dependsOn = dedupSorted(deps);
    } else if (reviewerIndices.includes(i)) {
      ordered[i].dependsOn = implementerIndices.length
        ? [...implementerIndices]
        : newFocusedFsIdx >= 0
        ? [newFocusedFsIdx]
        : layer2Indices.length
        ? [...layer2Indices]
        : [...layer1Indices];
    }
  }

  return ordered;
}

function findReviewerImplementationFlow(
  subTasks: SubTask[],
  getResult: (i: number) => { status: string; output?: string } | null | undefined,
  taskOutputs: string[]
): { reviewerIdx: number; implementationIdx: number; fileSearcherIdx: number | null } | null {
  if (getReviewerCoderMaxRounds() < 1) return null;
  const reviewerIndices: number[] = [];
  for (let i = 0; i < subTasks.length; i++) {
    if (normalizeRoleSlug(subTasks[i].role) === "reviewer") reviewerIndices.push(i);
  }
  if (reviewerIndices.length === 0) return null;
  const reviewerIdx = Math.max(...reviewerIndices);
  if (getResult(reviewerIdx)?.status !== "success" || !String(taskOutputs[reviewerIdx] ?? "").trim()) {
    return null;
  }
  const revDeps = subTasks[reviewerIdx].dependsOn || [];
  let implementationIdx = -1;
  for (const d of revDeps) {
    if (d < 0 || d >= subTasks.length) continue;
    const t = subTasks[d];
    if (isImplementationTask(t)) {
      implementationIdx = d;
      break;
    }
  }
  if (implementationIdx < 0) {
    for (let j = reviewerIdx - 1; j >= 0; j--) {
      const t = subTasks[j];
      if (isImplementationTask(t)) {
        implementationIdx = j;
        break;
      }
    }
  }
  if (implementationIdx < 0) return null;
  if (getResult(implementationIdx)?.status !== "success") return null;

  let fileSearcherIdx: number | null = null;
  const implDeps = subTasks[implementationIdx].dependsOn || [];
  for (const d of implDeps) {
    if (d >= 0 && d < subTasks.length && normalizeRoleSlug(subTasks[d].role) === "file-searcher") {
      fileSearcherIdx = d;
      break;
    }
  }
  if (fileSearcherIdx === null) {
    for (let j = implementationIdx - 1; j >= 0; j--) {
      if (normalizeRoleSlug(subTasks[j].role) === "file-searcher") {
        fileSearcherIdx = j;
        break;
      }
    }
  }
  return { reviewerIdx, implementationIdx, fileSearcherIdx };
}

// --- API Key Resolution ---

/** Maps apiType to the env var name and common aliases users might pass */
const API_KEY_ALIASES: Record<string, string[]> = {
  anthropic: ["anthropic", "claude", "ANTHROPIC_API_KEY"],
  google: ["google", "gemini", "GOOGLE_API_KEY"],
  openai: ["openai", "gpt", "OPENAI_API_KEY"],
  perplexity: ["perplexity", "PERPLEXITY_API_KEY"],
  xai: ["xai", "grok", "XAI_API_KEY"],
  deepseek: ["deepseek", "DEEPSEEK_API_KEY"],
};

// --- Core Functions ---

/**
 * Extract JSON from a potentially markdown-wrapped response
 */
function extractJson(text: string): string {
  // Try to extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)(\n?```|$)/);
  if (codeBlockMatch && codeBlockMatch[1].trim().startsWith("{")) {
    return codeBlockMatch[1].trim();
  }
  
  // Try to find raw JSON object
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    return text.substring(firstBrace, lastBrace + 1);
  }
  
  return text;
}

interface LeaderParsedResponse {
  tasks: SubTask[];
  finalRole: "coder" | "writer";
}

/**
 * Parse the Leader's response into sub-tasks and a finalRole for synthesis.
 */
function parseLeaderResponse(output: string): LeaderParsedResponse {
  try {
    const jsonStr = extractJson(output);
    const parsed = JSON.parse(jsonStr);

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error("Leader response missing 'tasks' array");
    }

    const tasks = parsed.tasks.map((t: Record<string, unknown>) => ({
      role: normalizeRoleSlug(String(t.role || "")),
      mode: String(t.mode || "chat"),
      input: String(t.input || ""),
      reason: String(t.reason || ""),
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((v: unknown) => typeof v === "number") as number[] : undefined,
    }));

    const finalRole = parsed.finalRole === "coder" ? "coder" : "writer";

    return { tasks: normalizeDiagramFlow(tasks), finalRole };
  } catch (err) {
    throw new Error(
      `Failed to parse Leader response: ${err instanceof Error ? err.message : String(err)}\nRaw output: ${output}`
    );
  }
}

/** Maps apiType to the corresponding environment variable name */
const ENV_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/**
 * Resolve the API key for a given provider using its apiType.
 * When authenticated (valid Clerk token): env vars first, then user-supplied keys.
 * When NOT authenticated: user-supplied keys only (env vars are not exposed).
 */
function resolveApiKey(
  providerName: string,
  apiType: string,
  apiKeys?: Record<string, string>,
  authenticated?: boolean
): string | undefined {
  // 1. Check environment variables only when authenticated via Clerk
  if (authenticated) {
    const envVar = ENV_KEY_MAP[apiType];
    const raw = envVar ? process.env[envVar] : undefined;
    const fromEnv = raw?.trim();
    if (fromEnv) {
      return fromEnv;
    }
  }

  // 2. Fall back to user-supplied apiKeys from request
  if (apiKeys) {
    // Direct match by provider name
    const byName = apiKeys[providerName]?.trim();
    if (byName) return byName;

    // Look up by apiType aliases
    const aliases = API_KEY_ALIASES[apiType] || [];
    for (const alias of aliases) {
      const v = apiKeys[alias]?.trim();
      if (v) return v;
    }
  }

  return undefined;
}

async function createLeaderTodosMarkdown(params: {
  req: OrchestratorRequest;
  leaderProvider: {
    name: string;
    displayName: string;
    apiBaseUrl: string;
    apiType: string;
    apiEndpoint?: string;
    modelId: string;
    toolMap?: unknown;
  };
  leaderApiKey?: string;
  fileSearchInput: string;
  upstreamMarkdown: string;
}): Promise<string> {
  const input = `## ユーザーの元のリクエスト
${augmentLeaderInput(params.req)}

## 上流エージェントのMarkdown
${params.upstreamMarkdown || "(上流Markdownなし)"}

## File Search への元の指示
${params.fileSearchInput}

上記を統合し、File Search に渡す Todos Markdown を作成してください。`;

  const result = await executeTask({
    provider: { ...params.leaderProvider, toolMap: undefined },
    config: { apiKey: params.leaderApiKey, maxTokens: 65536 },
    input,
    role: { slug: "leader", name: "Leader" },
    systemPrompt: LEADER_TODOS_SYSTEM_PROMPT,
    chatHistory: params.req.chatHistory,
  });

  if (result.status !== "success" || !result.output.trim()) {
    logger.warn(`[Agent] Leader Todos generation failed: ${result.errorMsg || "empty output"}`);
    return `## Todos

- File Search は上流Markdownと元の指示をもとに、関連ファイル、検索キーワード、変更対象、注意点を調査する。
- 情報が不足している場合は、不足内容をMarkdownに明記する。`;
  }

  return result.output;
}

type LeaderProgressCheckResult = {
  decision: "CONTINUE" | "ABORT";
  focus: string;
  reason: string;
};

function parseLeaderProgressCheck(raw: string): LeaderProgressCheckResult {
  const text = raw || "";
  const decisionMatch = text.match(/DECISION\s*:\s*(CONTINUE|ABORT)/i);
  const focusMatch = text.match(/FOCUS\s*:\s*([\s\S]*?)(?=\n\s*REASON\s*:|$)/i);
  const reasonMatch = text.match(/REASON\s*:\s*([\s\S]*)$/i);
  const decision: "CONTINUE" | "ABORT" =
    decisionMatch && /abort/i.test(decisionMatch[1]) ? "ABORT" : "CONTINUE";
  const focus = focusMatch ? focusMatch[1].trim() : "";
  const reason = reasonMatch ? reasonMatch[1].trim() : "";
  return { decision, focus, reason };
}

async function createLeaderProgressCheck(params: {
  req: OrchestratorRequest;
  leaderProvider: {
    name: string;
    displayName: string;
    apiBaseUrl: string;
    apiType: string;
    apiEndpoint?: string;
    modelId: string;
    toolMap?: unknown;
  };
  leaderApiKey?: string;
  round: number;
  maxRounds: number;
  briefGateHistory: string[];
  latestImplementation: string;
}): Promise<LeaderProgressCheckResult> {
  const historyText = params.briefGateHistory.length === 0
    ? "(履歴なし)"
    : params.briefGateHistory
        .map((entry, idx) => `### Round ${idx + 1}\n${entry}`)
        .join("\n\n");

  const input = `## ユーザーの元のリクエスト
${augmentLeaderInput(params.req)}

## 現在のループ状況
- 反復: ${params.round} / ${params.maxRounds}

## Brief Gate のフィードバック履歴（最新が最後）
${historyText}

## 直前の Coder/Writer 成果物
${params.latestImplementation || "(成果物なし)"}

上記を確認し、ループを続行するか中止するかを判断してください。`;

  const result = await executeTask({
    provider: { ...params.leaderProvider, toolMap: undefined },
    config: { apiKey: params.leaderApiKey, maxTokens: 16384 },
    input,
    role: { slug: "leader", name: "Leader" },
    systemPrompt: LEADER_PROGRESS_CHECK_SYSTEM_PROMPT,
    chatHistory: params.req.chatHistory,
  });

  if (result.status !== "success" || !result.output.trim()) {
    logger.warn(`[Agent] Leader Progress Check failed: ${result.errorMsg || "empty output"}`);
    return { decision: "CONTINUE", focus: "", reason: "Progress check failed; defaulting to continue" };
  }

  return parseLeaderProgressCheck(result.output);
}

type LeaderReviewBriefResult = {
  verdict: "OK" | "Not OK";
  feedback: string;
  brief: string;
};

function parseLeaderReviewBrief(raw: string): LeaderReviewBriefResult {
  const text = raw || "";
  const verdictMatch = text.match(/VERDICT\s*:\s*(Not\s+OK|OK)/i);
  const feedbackMatch = text.match(/FEEDBACK\s*:\s*([\s\S]*?)(?=\n\s*BRIEF\s*:|$)/i);
  const briefMatch = text.match(/BRIEF\s*:\s*([\s\S]*)$/i);

  let verdict: "OK" | "Not OK" = "OK";
  if (verdictMatch) {
    verdict = /not\s+ok/i.test(verdictMatch[1]) ? "Not OK" : "OK";
  }

  const feedback = feedbackMatch ? feedbackMatch[1].trim() : "";
  const brief = briefMatch ? briefMatch[1].trim() : text.trim();
  return { verdict, feedback, brief };
}

async function createLeaderReviewBriefText(params: {
  req: OrchestratorRequest;
  leaderProvider: {
    name: string;
    displayName: string;
    apiBaseUrl: string;
    apiType: string;
    apiEndpoint?: string;
    modelId: string;
    toolMap?: unknown;
  };
  leaderApiKey?: string;
  reviewerInput: string;
  implementationOutputs: string;
}): Promise<LeaderReviewBriefResult> {
  const input = `## ユーザーの元のリクエスト
${augmentLeaderInput(params.req)}

## Coder/Writer の成果物
${params.implementationOutputs || "(実装/執筆出力なし)"}

## Reviewer への元の指示
${params.reviewerInput}

上記を品質ゲートとして評価し、VERDICT / FEEDBACK / BRIEF の形式で出力してください。`;

  const result = await executeTask({
    provider: { ...params.leaderProvider, toolMap: undefined },
    config: { apiKey: params.leaderApiKey, maxTokens: 65536 },
    input,
    role: { slug: "leader", name: "Leader" },
    systemPrompt: LEADER_REVIEW_BRIEF_SYSTEM_PROMPT,
    chatHistory: params.req.chatHistory,
  });

  if (result.status !== "success" || !result.output.trim()) {
    logger.warn(`[Agent] Leader Review Brief generation failed: ${result.errorMsg || "empty output"}`);
    return {
      verdict: "OK",
      feedback: "",
      brief: `# Review Brief\n\n- ユーザー要求の要点: 元のリクエストに従って実装/執筆が行われた。\n- 実装/執筆の概要: 上流出力を参照のこと。\n- Reviewer に確認してほしい観点: 元の指示との整合性、品質、欠落の有無。`,
    };
  }

  return parseLeaderReviewBrief(result.output);
}

/**
 * Generate a Mermaid mindmap string from a list of tasks
 */
function buildMermaidMindmap(
  sessionId: string,
  leaderProvider: string,
  tasks: Array<{ role: string; provider?: string; dependsOn?: number[] }>
): string {
  const lines: string[] = [];
  lines.push(`\`\`\`mermaid`);
  lines.push(`mindmap`);
  lines.push(`  root(("Session ${sessionId.split("-")[0]}"))`);
  lines.push(`    Leader["Leader: ${leaderProvider}"]`);

  const childrenMap = new Map<number, number[]>();
  const roots: number[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (!task.dependsOn || task.dependsOn.length === 0) {
      roots.push(i);
    } else {
      const parent = task.dependsOn[0];
      if (!childrenMap.has(parent)) {
        childrenMap.set(parent, []);
      }
      childrenMap.get(parent)!.push(i);
    }
  }

  function printNode(index: number, depth: number) {
    const task = tasks[index];
    const indent = "  ".repeat(depth + 2);
    const nodeId = `task${index}`;
    const label = task.provider ? `${task.role}<br/>${task.provider}` : task.role;
    lines.push(`${indent}${nodeId}["Step ${index + 1}: ${label}"]`);

    const children = childrenMap.get(index) || [];
    for (const child of children) {
      printNode(child, depth + 1);
    }
  }

  for (const root of roots) {
    printNode(root, 0);
  }

  lines.push(`\`\`\`\n`);
  return lines.join("\n");
}

/**
 * Main orchestrator: run the full agent pipeline
 *
 * @param onLog  Optional callback invoked with real-time log messages
 *               during orchestration. Useful for streaming progress to clients.
 */
export async function runAgent(
  req: OrchestratorRequest,
  onLog?: (message: string) => void
): Promise<OrchestratorResult> {
  const log = (msg: string) => {
    console.log(msg);
    onLog?.(msg);
  };
  const startTime = Date.now();
  const sessionId = crypto.randomUUID();

  // 1. Find the Leader assignment
  const leaderRole = await prisma.role.findUnique({
    where: { slug: "leader" },
  });
  if (!leaderRole) {
    throw new Error('Role "leader" not found. Please run db:seed.');
  }

  let leaderAssignment = await prisma.roleAssignment.findFirst({
    where: { projectId: req.projectId, roleId: leaderRole.id },
    include: { provider: true },
    orderBy: { priority: "desc" },
  });
  if (!leaderAssignment) {
    leaderAssignment = await prisma.roleAssignment.findFirst({
      where: { roleId: leaderRole.id },
      include: { provider: true },
      orderBy: { priority: "desc" },
    });
  }
  if (!leaderAssignment) {
    throw new Error(
      'No AI provider assigned to "leader" role in this project.'
    );
  }

  // Resolve model: config.model overrides provider.modelId
  const leaderConfig = parseAssignmentConfig(leaderAssignment.config);
  const leaderModelId = (leaderConfig.model as string) || leaderAssignment.provider.modelId;
  const leaderProvider = { ...leaderAssignment.provider, modelId: leaderModelId };

  const leaderApiKey = resolveApiKey(
    leaderAssignment.provider.name,
    leaderAssignment.provider.apiType,
    req.apiKeys,
    req.authenticated
  );

  // 2. Ask Leader to decompose the task
  log(`[Agent] Session ${sessionId}`);
  log(`[Agent] Input: ${req.input}`);
  log(`[Agent] Leader: ${leaderProvider.displayName} (${leaderModelId})`);
  logger.info(`[Agent] Starting session`, { sessionId, projectId: req.projectId });

  const leaderResult = await executeTask({
    provider: leaderProvider,
    config: { apiKey: leaderApiKey },
    input: augmentLeaderInput(req),
    role: { slug: "leader", name: "Leader" },
    systemPrompt: leaderRole.systemPrompt ?? LEADER_SYSTEM_PROMPT,
    chatHistory: req.chatHistory,
  });

  if (leaderResult.status === "error") {
    return {
      sessionId,
      input: req.input,
      leaderProvider: leaderProvider.displayName,
      leaderModel: leaderModelId,
      tasks: [],
      mindmap: "",
      totalDurationMs: Date.now() - startTime,
      status: "error",
    };
  }

  // 3. Parse Leader's task breakdown
  let subTasks: SubTask[];
  let finalRole: "coder" | "writer" = "writer";
  try {
    const leaderParsed = parseLeaderResponse(leaderResult.output);
    subTasks = leaderParsed.tasks;
    finalRole = leaderParsed.finalRole;
  } catch (parseErr) {
    return {
      sessionId,
      input: req.input,
      leaderProvider: leaderProvider.displayName,
      leaderModel: leaderModelId,
      tasks: [
        {
          role: "leader",
          mode: "chat",
          input: req.input,
          reason: "Task decomposition failed",
          provider: leaderProvider.displayName,
          model: leaderModelId,
          output: leaderResult.output,
          status: "error",
          errorMsg:
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          durationMs: leaderResult.durationMs,
        },
      ],
      mindmap: "",
      totalDurationMs: Date.now() - startTime,
      status: "error",
    };
  }

  log(`[Agent] Leader decomposed into ${subTasks.length} tasks (finalRole: ${finalRole}):`);
  logger.info(`[Agent] Leader decomposed into ${subTasks.length} tasks`);
  subTasks.forEach((t, i) =>
    log(`  ${i + 1}. [${t.role}] ${t.input.substring(0, 60)}...`)
  );

  // 4. Execute sub-tasks with dependency-aware parallel execution
  const results: SubTaskResult[] = new Array(subTasks.length);
  const taskOutputs: string[] = new Array(subTasks.length).fill("");
  const taskRoleNames: string[] = new Array(subTasks.length).fill("");
  const taskProviderNames: string[] = new Array(subTasks.length).fill("");
  const completed = new Set<number>();

  async function executeSubTaskNonStream(
    i: number,
    opts?: { inputOverride?: string }
  ): Promise<void> {
    const task = subTasks[i];
    task.role = normalizeRoleSlug(task.role);

    // Find role
    const role = await prisma.role.findUnique({
      where: { slug: task.role },
    });
    if (!role) {
      log(`[Agent] Error: Role not found: ${task.role}`);
      results[i] = {
        ...task,
        provider: "unknown",
        model: "unknown",
        output: "",
        status: "error",
        errorMsg: `Role not found: ${task.role}`,
        durationMs: 0,
      };
      return;
    }
    taskRoleNames[i] = role.name;

    // Find assignment (check overrides first, then DB)
    let provider: {
      id: string;
      name: string;
      displayName: string;
      apiBaseUrl: string;
      apiType: string;
      apiEndpoint: string;
      modelId: string;
      isEnabled: boolean;
      toolMap?: unknown;
    } | null = null;

    const overrideProviderName = req.overrides?.[task.role];
    if (overrideProviderName) {
      const overrideProvider = await resolveProvider(overrideProviderName);
      if (overrideProvider) {
        provider = overrideProvider;
      }
    }

    if (!provider) {
      let assignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: role.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (!assignment) {
        assignment = await prisma.roleAssignment.findFirst({
          where: { roleId: role.id },
          include: { provider: true },
          orderBy: { priority: "desc" },
        });
      }
      if (assignment) {
        const taskConfig = parseAssignmentConfig(assignment.config);
        const taskModelId = (taskConfig.model as string) || assignment.provider.modelId;
        provider = { ...assignment.provider, modelId: taskModelId };
      }
    }

    if (!provider) {
      log(`[Agent] Error: No provider assigned to role "${task.role}"`);
      results[i] = {
        ...task,
        provider: "unassigned",
        model: "unassigned",
        output: "",
        status: "error",
        errorMsg: `No provider assigned to role "${task.role}"`,
        durationMs: 0,
      };
      return;
    }
    taskProviderNames[i] = provider.displayName;

    let enrichedInput: string;
    let upstreamMarkdownForTodos = "";
    if (opts?.inputOverride !== undefined) {
      enrichedInput = opts.inputOverride;
      upstreamMarkdownForTodos = opts.inputOverride;
    } else {
      // Build input with context from dependency tasks
      enrichedInput = task.input;
      upstreamMarkdownForTodos = buildDependencyMarkdown(task, taskOutputs, taskRoleNames, taskProviderNames);
      if (upstreamMarkdownForTodos) {
        enrichedInput = `## これまでの他のエージェントの作業結果:\n${upstreamMarkdownForTodos}\n\n## あなたへの指示:\n${task.input}`;
      }
    }

    if (isFocusedFileSearcherTask(task)) {
      log(`[Agent] Leader Todos: 集中再調査用のTodosを生成（Layer 3 file-searcher）`);
      const leaderTodos = await createLeaderTodosMarkdown({
        req,
        leaderProvider,
        leaderApiKey,
        fileSearchInput: enrichedInput,
        upstreamMarkdown: upstreamMarkdownForTodos,
      });
      enrichedInput = `## Leader Todos\n\n${leaderTodos}\n\n---\n\n## File Search の入力Markdown\n\n${enrichedInput}`;
    } else if (isFileSearcherTask(task)) {
      log(`[Agent] Layer 1 file-searcher: 初回スキャンなので Leader Todos はスキップ`);
    } else if (
      isReviewerTask(task) &&
      hasImplementationDependency(task, subTasks) &&
      opts?.inputOverride === undefined
    ) {
      log(`[Agent] Leader Brief Gate: Coder/Writer の成果物を判定`);
      const briefResult = await createLeaderReviewBriefText({
        req,
        leaderProvider,
        leaderApiKey,
        reviewerInput: task.input,
        implementationOutputs: upstreamMarkdownForTodos,
      });
      if (briefResult.verdict === "Not OK") {
        log(`[Agent] Brief Gate Not OK → Reviewer をスキップし File Search への再調査要求を出力`);
        const synthOutput = `VERDICT: Not OK (Brief Gate)\n\n## Brief Gate からのフィードバック\n\n${briefResult.feedback || "(フィードバック未提供)"}\n\n## 参考: 暫定 Brief\n\n${briefResult.brief}`;
        results[i] = {
          ...task,
          provider: `${leaderProvider.displayName} (Brief Gate)`,
          model: leaderProvider.modelId,
          output: synthOutput,
          status: "success",
          durationMs: 0,
        };
        taskOutputs[i] = synthOutput;
        return;
      }
      enrichedInput = `## Leader Review Brief\n\n${briefResult.brief}\n\n---\n\n## Reviewer への元の指示\n\n${task.input}`;
    }

    enrichedInput = attachLocalWorkspaceToSubtaskInput(
      task.role,
      task.mode,
      enrichedInput,
      req.localWorkspaceContext
    );

    const apiKey = resolveApiKey(provider.name, provider.apiType, req.apiKeys, req.authenticated);

    log(`[Agent] Executing: [${task.role}] → ${provider.displayName}`);
    logger.info(
      `[Agent] Executing: [${task.role}] → ${provider.displayName}`
    );

    const isCoderRole = task.role === "coder" || task.mode === "computer_use";
    const roleSystemPrompt = role.systemPrompt ?? undefined;
    const roleMaxTokens = ROLE_MAX_TOKENS[task.role];
    const effectiveProvider = isCoderRole
      ? { ...provider, toolMap: undefined }
      : provider;
    const finalInput = isCoderRole ? wrapCoderInput(enrichedInput) : enrichedInput;

    const result = await executeTask({
      provider: effectiveProvider,
      config: { apiKey, ...(roleMaxTokens ? { maxTokens: roleMaxTokens } : {}) },
      input: finalInput,
      role: { slug: role.slug, name: role.name },
      mode: task.mode,
      workspacePath: req.workspacePath,
      localWorkspaceContext: req.localWorkspaceContext,
      ...(roleSystemPrompt ? { systemPrompt: roleSystemPrompt } : {}),
    });

    if (
      isCoderRole &&
      result.status === "success" &&
      !coderOutputHasCode(result.output)
    ) {
      const guardMsg = `Coder output had no code block (length=${result.output?.length ?? 0}); marking as failure to avoid feedback loop`;
      log(`[Agent] ${guardMsg}`);
      logger.warn(`[Agent] ${guardMsg}`, { role: task.role, provider: provider.name });
      result.status = "error";
      result.errorMsg =
        "Coder did not produce a code block. The response only contained an analytical preamble. Output must include at least one fenced code block.";
    }

    if (result.status === "success") {
      log(`[Agent] Done: [${task.role}] → ${provider.displayName} (${result.durationMs}ms)`);
    } else {
      log(`[Agent] Failed: [${task.role}] → ${provider.displayName}: ${result.errorMsg || "unknown error"}`);
    }

    results[i] = {
      ...task,
      provider: provider.displayName,
      model: provider.modelId,
      output: result.output,
      status: result.status,
      errorMsg: result.errorMsg,
      durationMs: result.durationMs,
      thinking: result.thinking,
      citations: result.citations,
    };
    taskOutputs[i] = result.output;

    // Record usage & cost (webhook fires async)
    if (result.status === "success") {
      const inputTokens = Math.ceil(enrichedInput.length / 3);
      const outputTokens = Math.ceil((result.output || "").length / 3);
      try {
        const usage = await recordUsage({
          userId: req.userId,
          projectId: req.projectId,
          sessionId,
          providerId: provider.id,
          modelId: provider.modelId,
          role: task.role,
          inputTokens,
          outputTokens,
        });
        log(`[Agent] Cost: [${task.role}] $${usage.cost.totalCostUsd.toFixed(6)}`);
      } catch (usageErr) {
        log(`[Agent] Usage error: ${usageErr instanceof Error ? usageErr.message : String(usageErr)}`);
      }
    }

    // Log to DB
    const taskLog = await prisma.taskLog.create({
      data: {
        projectId: req.projectId,
        roleId: role.id,
        providerId: provider.id,
        input: enrichedInput,
        output: result.output || null,
        status: result.status,
        errorMsg: result.errorMsg || null,
        durationMs: result.durationMs,
      },
    });

    // Attach preview URL for designer role
    if (task.role === "designer" && result.status === "success" && result.output) {
      const baseUrl = process.env.DIVISION_API_URL || "https://api.division.he-ro.jp";
      results[i].previewUrl = `${baseUrl}/api/preview/${taskLog.id}`;
    }
  }

  // Dependency-aware parallel scheduler
  const remaining = new Set(subTasks.map((_, idx) => idx));

  while (remaining.size > 0) {
    const ready: number[] = [];
    for (const idx of remaining) {
      const deps = subTasks[idx].dependsOn || [];
      if (deps.every((d) => completed.has(d))) {
        ready.push(idx);
      }
    }

    if (ready.length === 0) {
      for (const idx of remaining) {
        ready.push(idx);
      }
    }

    for (const idx of ready) {
      remaining.delete(idx);
    }

    await Promise.all(ready.map((idx) => executeSubTaskNonStream(idx)));

    for (const idx of ready) {
      completed.add(idx);
    }
  }

  // 4b. 2段階ゲート フィードバックループ
  //   Brief Gate Not OK → 進捗確認 Leader → File Search 再調査（Todos 再生成なし）
  //   Reviewer Gate Not OK → File Search 再調査（Todos 再生成あり）
  const maxReviewRounds = getReviewerCoderMaxRounds();
  if (maxReviewRounds > 0) {
    const pair = findReviewerImplementationFlow(subTasks, (i) => results[i], taskOutputs);
    if (pair) {
      const { reviewerIdx, implementationIdx, fileSearcherIdx } = pair;
      const briefGateHistory: string[] = [];
      let progressFocus = "";
      for (let round = 1; round <= maxReviewRounds; round++) {
        const reviewerOutput = String(taskOutputs[reviewerIdx] ?? "");
        if (!reviewerOutput.trim()) break;

        const briefGateFailed = /^VERDICT:\s*Not\s+OK\s*\(Brief Gate\)/i.test(reviewerOutput);

        if (briefGateFailed) {
          briefGateHistory.push(reviewerOutput);
          // 進捗確認 Leader: 同じ問題の繰り返しなどを検出
          if (briefGateHistory.length >= 2) {
            log(`[Agent] Round ${round}/${maxReviewRounds}: Brief Gate ループの進捗確認 Leader を実行`);
            const progress = await createLeaderProgressCheck({
              req,
              leaderProvider,
              leaderApiKey,
              round,
              maxRounds: maxReviewRounds,
              briefGateHistory,
              latestImplementation: String(taskOutputs[implementationIdx] ?? ""),
            });
            if (progress.decision === "ABORT") {
              log(`[Agent] Progress Check ABORT → ループ終了。理由: ${progress.reason}`);
              break;
            }
            progressFocus = progress.focus;
            log(`[Agent] Progress Check CONTINUE。FOCUS: ${progressFocus.substring(0, 200)}`);
          }
          log(`[Agent] Round ${round}/${maxReviewRounds}: Brief Gate Not OK → File Search に再調査要求（Todos 再生成なし）`);
          if (fileSearcherIdx !== null) {
            const focusBlock = progressFocus ? `\n\n## 進捗確認 Leader からの FOCUS\n\n${progressFocus}\n` : "";
            // Layer 2 (designer / imager / planner) の最新 Markdown を再投入。
            // Leader Todos の再生成は upstreamMarkdownForTodos = override をそのまま使うので、
            // ここに含めれば Layer 2 も読み直される。
            const layer2Markdown = buildDependencyMarkdown(
              subTasks[fileSearcherIdx],
              taskOutputs,
              taskRoleNames,
              taskProviderNames
            );
            const layer2Block = layer2Markdown
              ? `\n\n## Layer 2 の最新成果物（designer / imager / planner Markdown）\n\n${layer2Markdown}`
              : "";
            const fileSearchOverride = `## Brief Gate からの再調査要求\n\n${reviewerOutput}${focusBlock}${layer2Block}\n\n---\n\n## 直前の成果物（Coder/Writer）\n\n${taskOutputs[implementationIdx]}\n\n---\n\n## 元の File Search 指示（Todos は変更不要、不足情報のみ補完）\n\n${subTasks[fileSearcherIdx].input}`;
            await executeSubTaskNonStream(fileSearcherIdx, { inputOverride: fileSearchOverride });
            if (results[fileSearcherIdx]?.status !== "success") break;
          }
        } else if (!reviewerLooksOk(reviewerOutput)) {
          briefGateHistory.length = 0;
          progressFocus = "";
          log(`[Agent] Round ${round}/${maxReviewRounds}: Reviewer Not OK → File Search に再調査要求（Todos 再生成あり）`);
          if (fileSearcherIdx !== null) {
            // Reviewer Not OK で Todos を再生成する際、Layer 2（designer / imager / planner）の
            // 最新 Markdown を必ず再読込させる。これがないと Leader Todos が設計を見ずに作られる。
            const layer2Markdown = buildDependencyMarkdown(
              subTasks[fileSearcherIdx],
              taskOutputs,
              taskRoleNames,
              taskProviderNames
            );
            const layer2Block = layer2Markdown
              ? `\n\n## Layer 2 の最新成果物（designer / imager / planner Markdown — Todos 再生成時にこれを必ず取り込むこと）\n\n${layer2Markdown}`
              : "";
            const fileSearchOverride = `## Reviewer からの指摘（Todos を再生成して再調査してください）\n\n${reviewerOutput}${layer2Block}\n\n---\n\n## 直前の成果物（Coder/Writer）\n\n${taskOutputs[implementationIdx]}\n\n---\n\n## 元の File Search 指示\n\n${subTasks[fileSearcherIdx].input}`;
            await executeSubTaskNonStream(fileSearcherIdx, { inputOverride: fileSearchOverride });
            if (results[fileSearcherIdx]?.status !== "success") break;
          }
        } else {
          log(`[Agent] Round ${round}/${maxReviewRounds}: Reviewer OK → ループ終了`);
          break;
        }

        const latestFileSearch = fileSearcherIdx !== null ? taskOutputs[fileSearcherIdx] : "";
        const focusBlock = briefGateFailed && progressFocus ? `\n\n## 進捗確認 Leader からの FOCUS\n\n${progressFocus}\n` : "";
        const implementationOverride = `## ${briefGateFailed ? "Brief Gate" : "Reviewer"} からの指摘（修正・改善してください）\n\n${reviewerOutput}${focusBlock}\n\n---\n\n## 再調査された File Search Markdown\n\n${latestFileSearch}\n\n---\n\n## 直前のあなたの成果\n\n${taskOutputs[implementationIdx]}\n\n---\n\n## 元のタスク指示\n\n${subTasks[implementationIdx].input}`;
        await executeSubTaskNonStream(implementationIdx, { inputOverride: implementationOverride });
        if (results[implementationIdx]?.status !== "success") break;

        // Brief Gate を再評価
        const upstreamMarkdownForGate = buildDependencyMarkdown(
          subTasks[reviewerIdx],
          taskOutputs,
          taskRoleNames,
          taskProviderNames
        );
        const briefResult = await createLeaderReviewBriefText({
          req,
          leaderProvider,
          leaderApiKey,
          reviewerInput: subTasks[reviewerIdx].input,
          implementationOutputs: upstreamMarkdownForGate,
        });

        if (briefResult.verdict === "Not OK") {
          const synthOutput = `VERDICT: Not OK (Brief Gate)\n\n## Brief Gate からのフィードバック\n\n${briefResult.feedback || "(フィードバック未提供)"}\n\n## 参考: 暫定 Brief\n\n${briefResult.brief}`;
          results[reviewerIdx] = {
            ...subTasks[reviewerIdx],
            provider: `${leaderProvider.displayName} (Brief Gate)`,
            model: leaderProvider.modelId,
            output: synthOutput,
            status: "success",
            durationMs: 0,
          };
          taskOutputs[reviewerIdx] = synthOutput;
        } else {
          const reviewerOverride = `## Leader Review Brief\n\n${briefResult.brief}\n\n---\n\n## 再レビュー対象: 指摘に対応して更新した成果\n\n${taskOutputs[implementationIdx]}\n\n---\n\n## 参照した File Search Markdown\n\n${latestFileSearch}\n\n---\n\n## あなたのレビュー観点（元の指示）\n\n${subTasks[reviewerIdx].input}`;
          await executeSubTaskNonStream(reviewerIdx, { inputOverride: reviewerOverride });
        }
      }
    }
  }

  // 5. Synthesis step — collect all outputs and pass to Coder/Writer
  const filledResults = results.filter(Boolean);
  const successfulOutputs = filledResults
    .filter((r) => r.status === "success" && r.output)
    .map((r) => `### ${r.role} (${r.provider}):\n${r.output}`);

  let finalOutput: string | undefined;
  let finalCode: string | undefined;

  if (successfulOutputs.length > 0) {
    const synthesisRoleSlug = normalizeRoleSlug(finalRole);
    const synthesisRole = await prisma.role.findUnique({ where: { slug: synthesisRoleSlug } });

    let synthesisProvider: typeof leaderProvider | null = null;
    if (synthesisRole) {
      let synthesisAssignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: synthesisRole.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (!synthesisAssignment) {
        synthesisAssignment = await prisma.roleAssignment.findFirst({
          where: { roleId: synthesisRole.id },
          include: { provider: true },
          orderBy: { priority: "desc" },
        });
      }
      if (synthesisAssignment) {
        const synthConfig = parseAssignmentConfig(synthesisAssignment.config);
        const synthModelId = (synthConfig.model as string) || synthesisAssignment.provider.modelId;
        synthesisProvider = { ...synthesisAssignment.provider, modelId: synthModelId };
      }
    }

    if (!synthesisProvider) {
      synthesisProvider = leaderProvider;
      logger.warn(`[Synthesis] No provider for "${synthesisRoleSlug}", falling back to leader: ${leaderProvider.displayName}`);
    }

    const synthesisApiKey = resolveApiKey(synthesisProvider.name, synthesisProvider.apiType, req.apiKeys, req.authenticated);
    const synthesisInput = `## ユーザーの元のリクエスト:\n${augmentLeaderInput(req)}\n\n## 各エージェントの作業結果:\n${successfulOutputs.join("\n\n")}`;

    log(`[Agent] Synthesis step: ${finalRole} → ${synthesisProvider.displayName}`);
    const synthesisMaxTokens = ROLE_SYNTHESIS_MAX_TOKENS[synthesisRoleSlug];
    const synthesisResult = await executeTask({
      provider: synthesisProvider,
      config: { apiKey: synthesisApiKey, ...(synthesisMaxTokens ? { maxTokens: synthesisMaxTokens } : {}) },
      input: synthesisInput,
      role: { slug: synthesisRoleSlug, name: synthesisRole?.name || finalRole },
      systemPrompt: synthesisRole?.systemPrompt ?? SYNTHESIS_SYSTEM_PROMPT,
    });

    if (synthesisResult.status === "success") {
      finalOutput = synthesisResult.output;
      if (finalRole === "coder") finalCode = synthesisResult.output;
    } else {
      finalOutput = successfulOutputs.join("\n\n---\n\n");
    }
  }

  // 6. Determine overall status
  const allSuccess = filledResults.every((r) => r.status === "success");
  const allError = filledResults.every((r) => r.status === "error");
  const status = allSuccess ? "success" : allError ? "error" : "partial";

  const totalDurationMs = Date.now() - startTime;
  log(`[Agent] Session complete: ${status} (${totalDurationMs}ms, ${filledResults.length} tasks)`);
  logger.info(
    `[Agent] Session complete: ${status} (${totalDurationMs}ms, ${filledResults.length} tasks)`,
    { sessionId, status, totalDurationMs }
  );

  const mindmap = buildMermaidMindmap(sessionId, leaderProvider.displayName, filledResults);

  return {
    sessionId,
    input: req.input,
    leaderProvider: leaderProvider.displayName,
    leaderModel: leaderModelId,
    tasks: filledResults,
    mindmap,
    finalOutput,
    finalCode,
    totalDurationMs,
    status,
  };
}

// --- Stream Event Types ---

export interface StreamEventSessionStart {
  type: "session_start";
  id: string;
  sessionId: string;
  input: string;
  leader: string;
}
export interface StreamEventLeaderStart {
  type: "leader_start";
  id: string;
  provider: string;
  model: string;
}
export interface StreamEventLeaderChunk {
  type: "leader_chunk";
  id: string;
  text: string;
}
export interface StreamEventLeaderDone {
  type: "leader_done";
  id: string;
  output: string;
  taskCount: number;
  tasks: Array<{ id: string; role: string; title: string; reason: string; dependsOn?: string[] }>;
  mindmap: string;
  rawOutput: string;
}
export interface StreamEventLeaderError {
  type: "leader_error";
  id: string;
  error: string;
}
export interface StreamEventTaskStart {
  type: "task_start";
  id: string;
  taskId: string;
  index: number;
  total: number;
  role: string;
  provider: string;
  model: string;
  input: string;
  mode: string;
}
export interface StreamEventTaskChunk {
  type: "task_chunk";
  id: string;
  taskId: string;
  index: number;
  role: string;
  text: string;
}
export interface StreamEventTaskThinkingChunk {
  type: "task_thinking_chunk";
  id: string;
  taskId: string;
  index: number;
  role: string;
  text: string;
}
export interface StreamEventTaskDone {
  type: "task_done";
  id: string;
  taskId: string;
  index: number;
  role: string;
  provider: string;
  model: string;
  output: string;
  status: string;
  durationMs: number;
  thinking?: string;
  citations?: string[];
  previewUrl?: string;
}
export interface StreamEventTaskError {
  type: "task_error";
  id: string;
  taskId: string;
  index: number;
  role: string;
  error: string;
}
export interface StreamEventSessionDone {
  type: "session_done";
  id: string;
  sessionId: string;
  status: string;
  totalDurationMs: number;
  taskCount: number;
  finalOutput?: string;
  results: Array<{
    role: string;
    provider: string;
    model: string;
    output: string;
    status: string;
    durationMs: number;
    thinking?: string;
    citations?: string[];
    previewUrl?: string;
  }>;
}
export interface StreamEventHeartbeat {
  type: "heartbeat";
  id: string;
  timestamp: number;
}
export interface StreamEventWaveStart {
  type: "wave_start";
  id: string;
  waveIndex: number;
  wave: number;
  taskIds: string[];
  taskIndices: number[];
}
export interface StreamEventWaveDone {
  type: "wave_done";
  id: string;
  waveIndex: number;
  wave: number;
  taskIds: string[];
  taskIndices: number[];
}
export interface StreamEventSynthesisStart {
  type: "synthesis_start";
  id: string;
  role: string;
  provider: string;
  model: string;
}
export interface StreamEventSynthesisChunk {
  type: "synthesis_chunk";
  id: string;
  text: string;
}
export interface StreamEventSynthesisDone {
  type: "synthesis_done";
  id: string;
  output: string;
  durationMs: number;
  role: string;
  provider: string;
  model: string;
}

export type StreamEvent =
  | StreamEventSessionStart
  | StreamEventLeaderStart
  | StreamEventLeaderChunk
  | StreamEventLeaderDone
  | StreamEventLeaderError
  | StreamEventTaskStart
  | StreamEventTaskChunk
  | StreamEventTaskThinkingChunk
  | StreamEventTaskDone
  | StreamEventTaskError
  | StreamEventSessionDone
  | StreamEventHeartbeat
  | StreamEventWaveStart
  | StreamEventWaveDone
  | StreamEventSynthesisStart
  | StreamEventSynthesisChunk
  | StreamEventSynthesisDone;

/**
 * Streaming orchestrator: run the full agent pipeline, emitting SSE events via the callback.
 *
 * Enhanced event stream includes:
 *   - Unique event IDs for reliable reconnection (Last-Event-ID)
 *   - Task output included in task_done events
 *   - Full aggregated results in session_done event
 *   - Heartbeat support via returned interval handle
 */
export async function runAgentStream(
  req: OrchestratorRequest,
  emit: (event: StreamEvent) => void
): Promise<void> {
  const startTime = Date.now();
  const sessionId = crypto.randomUUID();
  let eventSeq = 0;
  const nextId = () => `${sessionId}-${eventSeq++}`;

  // Heartbeat: emit every 15s to keep the connection alive on proxies/load-balancers
  const heartbeatInterval = setInterval(() => {
    emit({ type: "heartbeat", id: nextId(), timestamp: Date.now() });
  }, 15_000);

  try {
    await runAgentStreamCore(req, emit, sessionId, nextId, startTime);
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Internal streaming implementation.
 */
async function runAgentStreamCore(
  req: OrchestratorRequest,
  emit: (event: StreamEvent) => void,
  sessionId: string,
  nextId: () => string,
  startTime: number
): Promise<void> {
  // 1. Find the Leader assignment
  const leaderRole = await prisma.role.findUnique({
    where: { slug: "leader" },
  });
  if (!leaderRole) {
    emit({ type: "leader_error", id: nextId(), error: 'Role "leader" not found. Please run db:seed.' });
    return;
  }

  let leaderAssignment = await prisma.roleAssignment.findFirst({
    where: { projectId: req.projectId, roleId: leaderRole.id },
    include: { provider: true },
    orderBy: { priority: "desc" },
  });
  if (!leaderAssignment) {
    leaderAssignment = await prisma.roleAssignment.findFirst({
      where: { roleId: leaderRole.id },
      include: { provider: true },
      orderBy: { priority: "desc" },
    });
  }
  if (!leaderAssignment) {
    emit({ type: "leader_error", id: nextId(), error: 'No AI provider assigned to "leader" role in this project.' });
    return;
  }

  // Resolve model: config.model overrides provider.modelId
  const leaderConfig = parseAssignmentConfig(leaderAssignment.config);
  const leaderModelId = (leaderConfig.model as string) || leaderAssignment.provider.modelId;
  const leaderProvider = { ...leaderAssignment.provider, modelId: leaderModelId };

  const leaderApiKey = resolveApiKey(
    leaderAssignment.provider.name,
    leaderAssignment.provider.apiType,
    req.apiKeys,
    req.authenticated
  );

  // 2. Emit session start
  emit({
    type: "session_start",
    id: nextId(),
    sessionId,
    input: req.input,
    leader: leaderProvider.displayName,
  });

  emit({
    type: "leader_start",
    id: nextId(),
    provider: leaderProvider.displayName,
    model: leaderModelId,
  });

  // 3. Ask Leader to decompose (streaming)
  const leaderResult = await executeTaskStream(
    {
      provider: leaderProvider,
      config: { apiKey: leaderApiKey },
      input: augmentLeaderInput(req),
      role: { slug: "leader", name: "Leader" },
      systemPrompt: leaderRole.systemPrompt ?? LEADER_SYSTEM_PROMPT,
      chatHistory: req.chatHistory,
    },
    (text) => emit({ type: "leader_chunk", id: nextId(), text })
  );

  if (leaderResult.status === "error") {
    emit({ type: "leader_error", id: nextId(), error: leaderResult.errorMsg || "Leader execution failed" });
    emit({
      type: "session_done",
      id: nextId(),
      sessionId,
      status: "error",
      totalDurationMs: Date.now() - startTime,
      taskCount: 0,
      results: [],
    });
    return;
  }

  // 4. Parse Leader's task breakdown
  let subTasks: SubTask[];
  let finalRole: "coder" | "writer" = "writer";
  try {
    const leaderParsed = parseLeaderResponse(leaderResult.output);
    subTasks = leaderParsed.tasks;
    finalRole = leaderParsed.finalRole;
  } catch (parseErr) {
    emit({
      type: "leader_error",
      id: nextId(),
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
    emit({
      type: "session_done",
      id: nextId(),
      sessionId,
      status: "error",
      totalDurationMs: Date.now() - startTime,
      taskCount: 0,
      results: [],
    });
    return;
  }

  // Generate stable string IDs for each task so the frontend can track them
  const taskIdOf = (idx: number) => `task-${idx}`;

  const leaderOutputTasks = subTasks.map((t, idx) => ({
    id: taskIdOf(idx),
    role: t.role,
    title: t.input,
    reason: t.reason,
    dependsOn: (t.dependsOn || []).map((d) => taskIdOf(d)),
  }));

  const mindmap = buildMermaidMindmap(
    sessionId,
    leaderProvider.displayName,
    subTasks
  );

  emit({
    type: "leader_done",
    id: nextId(),
    output: leaderResult.output,
    taskCount: subTasks.length,
    tasks: leaderOutputTasks,
    mindmap,
    rawOutput: leaderResult.output,
  });

  // 5. Execute sub-tasks with dependency-aware parallel execution
  //    Tasks with no dependencies (or dependsOn: []) run concurrently.
  //    Tasks that depend on others wait until all their dependencies complete.
  const taskResults: Array<{
    role: string;
    provider: string;
    model: string;
    output: string;
    status: string;
    durationMs: number;
    thinking?: string;
    citations?: string[];
    previewUrl?: string;
  }> = new Array(subTasks.length);

  // Track completion state per task
  const taskOutputs: string[] = new Array(subTasks.length).fill("");
  const taskRoleNames: string[] = new Array(subTasks.length).fill("");
  const taskProviderNames: string[] = new Array(subTasks.length).fill("");
  const completed = new Set<number>();

  /** Execute a single sub-task at the given index */
  async function executeSubTask(
    i: number,
    opts?: { inputOverride?: string }
  ): Promise<void> {
    const task = subTasks[i];
    task.role = normalizeRoleSlug(task.role);

    // Find role
    const role = await prisma.role.findUnique({
      where: { slug: task.role },
    });
    if (!role) {
      emit({ type: "task_error", id: nextId(), taskId: taskIdOf(i), index: i, role: task.role, error: `Role not found: ${task.role}` });
      taskResults[i] = {
        role: task.role,
        provider: "unknown",
        model: "unknown",
        output: "",
        status: "error",
        durationMs: 0,
      };
      return;
    }
    taskRoleNames[i] = role.name;

    // Find provider (check overrides first, then DB)
    let provider: {
      id: string;
      name: string;
      displayName: string;
      apiBaseUrl: string;
      apiType: string;
      apiEndpoint: string;
      modelId: string;
      isEnabled: boolean;
      toolMap?: unknown;
    } | null = null;

    const overrideProviderName = req.overrides?.[task.role];
    if (overrideProviderName) {
      const overrideProvider = await resolveProvider(overrideProviderName);
      if (overrideProvider) {
        provider = overrideProvider;
      }
    }

    if (!provider) {
      // Try project-specific assignment first
      let assignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: role.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      // Fallback: any assignment for this role
      if (!assignment) {
        assignment = await prisma.roleAssignment.findFirst({
          where: { roleId: role.id },
          include: { provider: true },
          orderBy: { priority: "desc" },
        });
      }
      if (assignment) {
        const taskConfig = parseAssignmentConfig(assignment.config);
        const taskModelId = (taskConfig.model as string) || assignment.provider.modelId;
        provider = { ...assignment.provider, modelId: taskModelId };
      }
    }

    if (!provider) {
      emit({
        type: "task_error",
        id: nextId(),
        taskId: taskIdOf(i),
        index: i,
        role: task.role,
        error: `No provider assigned to role "${task.role}"`,
      });
      taskResults[i] = {
        role: task.role,
        provider: "unassigned",
        model: "unassigned",
        output: "",
        status: "error",
        durationMs: 0,
      };
      return;
    }
    taskProviderNames[i] = provider.displayName;

    let enrichedInput: string;
    let upstreamMarkdownForTodos = "";
    if (opts?.inputOverride !== undefined) {
      enrichedInput = opts.inputOverride;
      upstreamMarkdownForTodos = opts.inputOverride;
    } else {
      // Build enriched input with context from dependency tasks
      enrichedInput = task.input;
      upstreamMarkdownForTodos = buildDependencyMarkdown(task, taskOutputs, taskRoleNames, taskProviderNames);
      if (upstreamMarkdownForTodos) {
        enrichedInput = `## これまでの他のエージェントの作業結果:\n${upstreamMarkdownForTodos}\n\n## あなたへの指示:\n${task.input}`;
      }
    }

    if (isFocusedFileSearcherTask(task)) {
      const leaderTodos = await createLeaderTodosMarkdown({
        req,
        leaderProvider,
        leaderApiKey,
        fileSearchInput: enrichedInput,
        upstreamMarkdown: upstreamMarkdownForTodos,
      });
      enrichedInput = `## Leader Todos\n\n${leaderTodos}\n\n---\n\n## File Search の入力Markdown\n\n${enrichedInput}`;
    } else if (
      isReviewerTask(task) &&
      hasImplementationDependency(task, subTasks) &&
      opts?.inputOverride === undefined
    ) {
      const briefResult = await createLeaderReviewBriefText({
        req,
        leaderProvider,
        leaderApiKey,
        reviewerInput: task.input,
        implementationOutputs: upstreamMarkdownForTodos,
      });
      if (briefResult.verdict === "Not OK") {
        const synthOutput = `VERDICT: Not OK (Brief Gate)\n\n## Brief Gate からのフィードバック\n\n${briefResult.feedback || "(フィードバック未提供)"}\n\n## 参考: 暫定 Brief\n\n${briefResult.brief}`;
        emit({
          type: "task_start",
          id: nextId(),
          taskId: taskIdOf(i),
          index: i,
          total: subTasks.length,
          role: task.role,
          provider: `${leaderProvider.displayName} (Brief Gate)`,
          model: leaderProvider.modelId,
          input: opts?.inputOverride ?? task.input,
          mode: task.mode,
        });
        emit({
          type: "task_done",
          id: nextId(),
          taskId: taskIdOf(i),
          index: i,
          role: task.role,
          provider: `${leaderProvider.displayName} (Brief Gate)`,
          model: leaderProvider.modelId,
          output: synthOutput,
          status: "success",
          durationMs: 0,
        });
        taskResults[i] = {
          role: task.role,
          provider: `${leaderProvider.displayName} (Brief Gate)`,
          model: leaderProvider.modelId,
          output: synthOutput,
          status: "success",
          durationMs: 0,
        };
        taskOutputs[i] = synthOutput;
        return;
      }
      enrichedInput = `## Leader Review Brief\n\n${briefResult.brief}\n\n---\n\n## Reviewer への元の指示\n\n${task.input}`;
    }

    enrichedInput = attachLocalWorkspaceToSubtaskInput(
      task.role,
      task.mode,
      enrichedInput,
      req.localWorkspaceContext
    );

    const apiKey = resolveApiKey(provider.name, provider.apiType, req.apiKeys, req.authenticated);

    emit({
      type: "task_start",
      id: nextId(),
      taskId: taskIdOf(i),
      index: i,
      total: subTasks.length,
      role: task.role,
      provider: provider.displayName,
      model: provider.modelId,
      input: opts?.inputOverride ?? task.input,
      mode: task.mode,
    });

    const isCoderRole = task.role === "coder" || task.mode === "computer_use";
    const roleSystemPrompt = role.systemPrompt ?? undefined;
    const roleMaxTokens = ROLE_MAX_TOKENS[task.role];
    const effectiveProvider = isCoderRole
      ? { ...provider, toolMap: undefined }
      : provider;
    const finalInput = isCoderRole ? wrapCoderInput(enrichedInput) : enrichedInput;

    const result = await executeTaskStream(
      {
        provider: effectiveProvider,
        config: { apiKey, ...(roleMaxTokens ? { maxTokens: roleMaxTokens } : {}) },
        input: finalInput,
        role: { slug: role.slug, name: role.name },
        mode: task.mode,
        workspacePath: req.workspacePath,
        localWorkspaceContext: req.localWorkspaceContext,
        ...(roleSystemPrompt ? { systemPrompt: roleSystemPrompt } : {}),
      },
      (text) => emit({ type: "task_chunk", id: nextId(), taskId: taskIdOf(i), index: i, role: task.role, text }),
      (text) => emit({ type: "task_thinking_chunk", id: nextId(), taskId: taskIdOf(i), index: i, role: task.role, text })
    );

    if (
      isCoderRole &&
      result.status === "success" &&
      !coderOutputHasCode(result.output)
    ) {
      const guardMsg = `Coder output had no code block (length=${result.output?.length ?? 0}); marking as failure to avoid feedback loop`;
      logger.warn(`[Agent] ${guardMsg}`, { role: task.role, provider: provider.name });
      result.status = "error";
      result.errorMsg =
        "Coder did not produce a code block. The response only contained an analytical preamble. Output must include at least one fenced code block.";
    }

    // Log to DB
    const taskLog = await prisma.taskLog.create({
      data: {
        projectId: req.projectId,
        roleId: role.id,
        providerId: provider.id,
        input: enrichedInput,
        output: result.output || null,
        status: result.status,
        errorMsg: result.errorMsg || null,
        durationMs: result.durationMs,
      },
    });

    // Build preview URL for design role
    let previewUrl: string | undefined;
    if (task.role === "designer" && result.status === "success" && result.output) {
      const baseUrl = process.env.DIVISION_API_URL || "https://api.division.he-ro.jp";
      previewUrl = `${baseUrl}/api/preview/${taskLog.id}`;
    }

    if (result.status === "success") {
      emit({
        type: "task_done",
        id: nextId(),
        taskId: taskIdOf(i),
        index: i,
        role: task.role,
        provider: provider.displayName,
        model: provider.modelId,
        output: result.output,
        status: "success",
        durationMs: result.durationMs,
        thinking: result.thinking,
        citations: result.citations,
        previewUrl,
      });
    } else {
      emit({
        type: "task_error",
        id: nextId(),
        taskId: taskIdOf(i),
        index: i,
        role: task.role,
        error: result.errorMsg || "Execution failed",
      });
    }

    taskResults[i] = {
      role: task.role,
      provider: provider.displayName,
      model: provider.modelId,
      output: result.output,
      status: result.status,
      durationMs: result.durationMs,
      thinking: result.thinking,
      citations: result.citations,
      previewUrl,
    };
    taskOutputs[i] = result.output;

    // Record usage & cost (wait for webhook so serverless does not drop it)
    if (result.status === "success") {
      const inputTokens = Math.ceil(enrichedInput.length / 3);
      const outputTokens = Math.ceil((result.output || "").length / 3);
      try {
        await recordUsage({
          userId: req.userId,
          projectId: req.projectId,
          sessionId,
          providerId: provider.id,
          modelId: provider.modelId,
          role: task.role,
          inputTokens,
          outputTokens,
        });
      } catch (usageErr) {
        logger.warn(
          `[AgentStream] Usage error for ${task.role}: ${usageErr instanceof Error ? usageErr.message : String(usageErr)}`
        );
      }
    }
  }

  // --- Dependency-aware parallel scheduler ---
  // Build waves: each wave contains tasks whose dependencies are all in prior waves.

  const remaining = new Set(subTasks.map((_, idx) => idx));
  let waveNum = 0;

  while (remaining.size > 0) {
    // Find tasks whose dependencies are all satisfied
    const ready: number[] = [];
    for (const idx of remaining) {
      const deps = subTasks[idx].dependsOn || [];
      if (deps.every((d) => completed.has(d))) {
        ready.push(idx);
      }
    }

    if (ready.length === 0) {
      // Circular dependency or invalid dependsOn — force execute all remaining
      for (const idx of remaining) {
        ready.push(idx);
      }
    }

    // Remove ready tasks from remaining
    for (const idx of ready) {
      remaining.delete(idx);
    }

    // Emit wave start (indicates which tasks are running in parallel)
    emit({ type: "wave_start", id: nextId(), waveIndex: waveNum, wave: waveNum, taskIds: ready.map(taskIdOf), taskIndices: ready });

    // Execute this wave concurrently
    await Promise.all(ready.map((idx) => executeSubTask(idx)));

    // Mark as completed
    for (const idx of ready) {
      completed.add(idx);
    }

    emit({ type: "wave_done", id: nextId(), waveIndex: waveNum, wave: waveNum, taskIds: ready.map(taskIdOf), taskIndices: ready });
    waveNum++;
  }

  // 5b. 2段階ゲート フィードバックループ
  //   Brief Gate Not OK → 進捗確認 Leader → File Search 再調査（Todos 再生成なし）
  //   Reviewer Gate Not OK → File Search 再調査（Todos 再生成あり）
  const maxReviewRoundsStream = getReviewerCoderMaxRounds();
  if (maxReviewRoundsStream > 0) {
    const pairS = findReviewerImplementationFlow(subTasks, (i) => taskResults[i], taskOutputs);
    if (pairS) {
      const { reviewerIdx, implementationIdx, fileSearcherIdx } = pairS;
      const briefGateHistoryS: string[] = [];
      let progressFocusS = "";
      for (let round = 1; round <= maxReviewRoundsStream; round++) {
        const reviewerOutput = String(taskOutputs[reviewerIdx] ?? "");
        if (!reviewerOutput.trim()) break;

        const briefGateFailed = /^VERDICT:\s*Not\s+OK\s*\(Brief Gate\)/i.test(reviewerOutput);

        if (briefGateFailed) {
          briefGateHistoryS.push(reviewerOutput);
          if (briefGateHistoryS.length >= 2) {
            logger.info(
              `[Agent] Round ${round}/${maxReviewRoundsStream}: Brief Gate ループの進捗確認 Leader を実行`
            );
            const progressS = await createLeaderProgressCheck({
              req,
              leaderProvider,
              leaderApiKey,
              round,
              maxRounds: maxReviewRoundsStream,
              briefGateHistory: briefGateHistoryS,
              latestImplementation: String(taskOutputs[implementationIdx] ?? ""),
            });
            if (progressS.decision === "ABORT") {
              logger.info(`[Agent] Progress Check ABORT → ループ終了。理由: ${progressS.reason}`);
              break;
            }
            progressFocusS = progressS.focus;
            logger.info(`[Agent] Progress Check CONTINUE。FOCUS: ${progressFocusS.substring(0, 200)}`);
          }
          logger.info(
            `[Agent] Round ${round}/${maxReviewRoundsStream}: Brief Gate Not OK → File Search 再調査（Todos 再生成なし）`
          );
          if (fileSearcherIdx !== null) {
            const focusBlockS = progressFocusS ? `\n\n## 進捗確認 Leader からの FOCUS\n\n${progressFocusS}\n` : "";
            // Layer 2 (designer / imager / planner) の最新 Markdown を再投入。
            const layer2MarkdownS = buildDependencyMarkdown(
              subTasks[fileSearcherIdx],
              taskOutputs,
              taskRoleNames,
              taskProviderNames
            );
            const layer2BlockS = layer2MarkdownS
              ? `\n\n## Layer 2 の最新成果物（designer / imager / planner Markdown）\n\n${layer2MarkdownS}`
              : "";
            const fileSearchOverrideS = `## Brief Gate からの再調査要求\n\n${reviewerOutput}${focusBlockS}${layer2BlockS}\n\n---\n\n## 直前の成果物（Coder/Writer）\n\n${taskOutputs[implementationIdx]}\n\n---\n\n## 元の File Search 指示（Todos は変更不要、不足情報のみ補完）\n\n${subTasks[fileSearcherIdx].input}`;
            await executeSubTask(fileSearcherIdx, { inputOverride: fileSearchOverrideS });
            if (taskResults[fileSearcherIdx]?.status !== "success") break;
          }
        } else if (!reviewerLooksOk(reviewerOutput)) {
          briefGateHistoryS.length = 0;
          progressFocusS = "";
          logger.info(
            `[Agent] Round ${round}/${maxReviewRoundsStream}: Reviewer Not OK → File Search 再調査（Todos 再生成あり）`
          );
          if (fileSearcherIdx !== null) {
            // Reviewer Not OK で Todos を再生成する際、Layer 2（designer / imager / planner）の
            // 最新 Markdown を必ず再読込させる。
            const layer2MarkdownS = buildDependencyMarkdown(
              subTasks[fileSearcherIdx],
              taskOutputs,
              taskRoleNames,
              taskProviderNames
            );
            const layer2BlockS = layer2MarkdownS
              ? `\n\n## Layer 2 の最新成果物（designer / imager / planner Markdown — Todos 再生成時にこれを必ず取り込むこと）\n\n${layer2MarkdownS}`
              : "";
            const fileSearchOverrideS = `## Reviewer からの指摘（Todos を再生成して再調査してください）\n\n${reviewerOutput}${layer2BlockS}\n\n---\n\n## 直前の成果物（Coder/Writer）\n\n${taskOutputs[implementationIdx]}\n\n---\n\n## 元の File Search 指示\n\n${subTasks[fileSearcherIdx].input}`;
            await executeSubTask(fileSearcherIdx, { inputOverride: fileSearchOverrideS });
            if (taskResults[fileSearcherIdx]?.status !== "success") break;
          }
        } else {
          logger.info(`[Agent] Round ${round}/${maxReviewRoundsStream}: Reviewer OK → ループ終了`);
          break;
        }

        const latestFileSearchS = fileSearcherIdx !== null ? taskOutputs[fileSearcherIdx] : "";
        const focusBlockImplS = briefGateFailed && progressFocusS ? `\n\n## 進捗確認 Leader からの FOCUS\n\n${progressFocusS}\n` : "";
        const implementationOverrideS = `## ${briefGateFailed ? "Brief Gate" : "Reviewer"} からの指摘（修正・改善してください）\n\n${reviewerOutput}${focusBlockImplS}\n\n---\n\n## 再調査された File Search Markdown\n\n${latestFileSearchS}\n\n---\n\n## 直前のあなたの成果\n\n${taskOutputs[implementationIdx]}\n\n---\n\n## 元のタスク指示\n\n${subTasks[implementationIdx].input}`;
        await executeSubTask(implementationIdx, { inputOverride: implementationOverrideS });
        if (taskResults[implementationIdx]?.status !== "success") break;

        const upstreamMarkdownForGateS = buildDependencyMarkdown(
          subTasks[reviewerIdx],
          taskOutputs,
          taskRoleNames,
          taskProviderNames
        );
        const briefResultS = await createLeaderReviewBriefText({
          req,
          leaderProvider,
          leaderApiKey,
          reviewerInput: subTasks[reviewerIdx].input,
          implementationOutputs: upstreamMarkdownForGateS,
        });

        if (briefResultS.verdict === "Not OK") {
          const synthOutput = `VERDICT: Not OK (Brief Gate)\n\n## Brief Gate からのフィードバック\n\n${briefResultS.feedback || "(フィードバック未提供)"}\n\n## 参考: 暫定 Brief\n\n${briefResultS.brief}`;
          taskResults[reviewerIdx] = {
            role: subTasks[reviewerIdx].role,
            provider: `${leaderProvider.displayName} (Brief Gate)`,
            model: leaderProvider.modelId,
            output: synthOutput,
            status: "success",
            durationMs: 0,
          };
          taskOutputs[reviewerIdx] = synthOutput;
        } else {
          const reviewerOverrideS = `## Leader Review Brief\n\n${briefResultS.brief}\n\n---\n\n## 再レビュー対象: 指摘に対応して更新した成果\n\n${taskOutputs[implementationIdx]}\n\n---\n\n## 参照した File Search Markdown\n\n${latestFileSearchS}\n\n---\n\n## あなたのレビュー観点（元の指示）\n\n${subTasks[reviewerIdx].input}`;
          await executeSubTask(reviewerIdx, { inputOverride: reviewerOverrideS });
        }
      }
    }
  }

  // 6. Synthesis step — collect all outputs and pass to Coder/Writer
  const filledResults = taskResults.filter(Boolean);
  const successfulOutputs = filledResults
    .filter((r) => r.status === "success" && r.output)
    .map((r) => `### ${r.role} (${r.provider}):\n${r.output}`);

  let finalOutput: string | undefined;

  if (successfulOutputs.length > 0) {
    // Resolve the synthesis role (coder or writer)
    const synthesisRoleSlug = normalizeRoleSlug(finalRole);
    const synthesisRole = await prisma.role.findUnique({
      where: { slug: synthesisRoleSlug },
    });

    let synthesisProvider: {
      id: string;
      name: string;
      displayName: string;
      apiBaseUrl: string;
      apiType: string;
      apiEndpoint: string;
      modelId: string;
      isEnabled: boolean;
      toolMap?: unknown;
    } | null = null;

    if (synthesisRole) {
      // Try project-specific assignment first, then any assignment for this role
      let synthesisAssignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: synthesisRole.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (!synthesisAssignment) {
        synthesisAssignment = await prisma.roleAssignment.findFirst({
          where: { roleId: synthesisRole.id },
          include: { provider: true },
          orderBy: { priority: "desc" },
        });
      }
      if (synthesisAssignment) {
        const synthConfig = parseAssignmentConfig(synthesisAssignment.config);
        const synthModelId = (synthConfig.model as string) || synthesisAssignment.provider.modelId;
        synthesisProvider = { ...synthesisAssignment.provider, modelId: synthModelId };
      }
    }

    // Fallback: use the leader provider for synthesis if no dedicated assignment exists
    if (!synthesisProvider) {
      synthesisProvider = leaderProvider;
      logger.warn(`[Synthesis] No provider assigned for role "${synthesisRoleSlug}", falling back to leader provider: ${leaderProvider.displayName}`);
    }

    const synthesisApiKey = resolveApiKey(
      synthesisProvider.name,
      synthesisProvider.apiType,
      req.apiKeys,
      req.authenticated
    );

    const synthesisInput = `## ユーザーの元のリクエスト:\n${augmentLeaderInput(req)}\n\n## 各エージェントの作業結果:\n${successfulOutputs.join("\n\n")}`;

    emit({
      type: "synthesis_start",
      id: nextId(),
      role: finalRole,
      provider: synthesisProvider.displayName,
      model: synthesisProvider.modelId,
    });

    const synthStart = Date.now();
    const synthesisMaxTokens = ROLE_SYNTHESIS_MAX_TOKENS[synthesisRoleSlug];
    const synthesisResult = await executeTaskStream(
      {
        provider: synthesisProvider,
        config: { apiKey: synthesisApiKey, ...(synthesisMaxTokens ? { maxTokens: synthesisMaxTokens } : {}) },
        input: synthesisInput,
        role: { slug: synthesisRoleSlug, name: synthesisRole?.name || finalRole },
        systemPrompt: synthesisRole?.systemPrompt ?? SYNTHESIS_SYSTEM_PROMPT,
      },
      (text) => emit({ type: "synthesis_chunk", id: nextId(), text })
    );

    const synthDurationMs = Date.now() - synthStart;

    if (synthesisResult.status === "success") {
      finalOutput = synthesisResult.output;
      emit({
        type: "synthesis_done",
        id: nextId(),
        output: synthesisResult.output,
        durationMs: synthDurationMs,
        role: finalRole,
        provider: synthesisProvider.displayName,
        model: synthesisProvider.modelId,
      });
    } else {
      logger.error(`[Synthesis] Failed: ${synthesisResult.errorMsg}`, {
        role: finalRole,
        provider: synthesisProvider.displayName,
        model: synthesisProvider.modelId,
        apiType: synthesisProvider.apiType,
        apiBaseUrl: synthesisProvider.apiBaseUrl,
      });
      finalOutput = successfulOutputs.join("\n\n---\n\n");
      emit({
        type: "synthesis_done",
        id: nextId(),
        output: finalOutput,
        durationMs: synthDurationMs,
        role: finalRole,
        provider: synthesisProvider.displayName,
        model: synthesisProvider.modelId,
      });
    }
  }

  emit({
    type: "session_done",
    id: nextId(),
    sessionId,
    status: finalOutput ? "success" : "error",
    totalDurationMs: Date.now() - startTime,
    taskCount: filledResults.length,
    finalOutput: finalOutput || undefined,
    results: filledResults,
  });
}