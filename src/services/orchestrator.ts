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
import {
  FILE_SEARCHER_OUTPUT_CONTRACT,
  isEmptyProjectContext,
  mergeProjectContext,
  parseProjectContext,
  renderSharedContext,
  selectRelevantFilesForRole,
  type ContextFile,
  type ProjectContext,
} from "./project-context";
import {
  applyContextPolicy,
  ContextRequestLedger,
  parseContextRequest,
  renderDecision,
  roleReceivesFileBodies,
  type ContextRequest,
} from "./context-policy";

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
  /**
   * Leader がこのタスクに配分したファイルパス。
   * 空/未指定ならロール別の自動選択にフォールバックする。
   * いずれの場合も context-policy のゲートを通ってから渡される。
   */
  context?: string[];
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
  /**
   * `/api/tasks/stop` などからの中断要求を受け取る AbortSignal。
   * 指定すると、内部のすべての executeTask / executeTaskStream の fetch に伝搬し、
   * abort 時はそれぞれが `status: "error"` / `errorMsg: "Aborted by user"` で即座に返る。
   */
  signal?: AbortSignal;
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

const LEADER_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、必要なタスクに分解してください。他のロールはあなたが出したタスクの通りに動くだけなので、実際に必要なタスクと依存関係をあなた自身が正確に決めてください。

## 利用可能なロールと担当
- file-searcher: プロジェクト内のファイル・既存実装の調査（GPT担当）
- ideaman: 創造的ブレインストーミング・アイデア出し（Claude担当）
- searcher: ウェブ検索・情報収集（Perplexity担当）
- researcher: 深い調査・分析・レポート（Perplexity Deep Research担当）
- designer: UI/UXデザイン・HTML/CSS生成・ランディングページ・プロトタイプ（Gemini担当。完全に自己完結したHTMLを生成）
- imager: 画像生成・ビジュアルコンテンツ・イラスト（GPT Image担当）
- planner: 企画・設計・アーキテクチャ・戦略立案（Gemini担当）
- coder: コード生成・実装・デバッグ（Claude担当）
- writer: 文章作成・ドキュメント（Claude担当）
- reviewer: 品質確認・レビュー・改善提案（GPT担当）

**重要**: 各タスクは Leader が出した tasks JSON の指示通りに 1 度だけ実行されます。他のロールは追加のロールを勝手に呼んだり、あなたが書かなかったタスクを実行したりしません。Reviewer ↔ Coder のフィードバックループや、Todos / Brief Gate の自動挿入もありません。後続で必要になる作業は、あらかじめ tasks に書いてください。

【最終統合】reviewer（レビューが無い場合は最後の coder/writer）完了後に自動実行（tasksに含めない）

## ルール
1. 各タスクには0始まりのインデックスが付与されます（0, 1, 2...）
2. dependsOn には「このタスクの前に完了しているべきタスク」のインデックスを指定してください。dependsOn には必ず自分より前のインデックスのみを指定できます。空配列 [] は依存なし＝他タスクと並列実行されます。
3. リクエストの内容に本当に必要なロールだけを選んでください。無関係なロールを形だけ含める必要はありません。単純な依頼なら数タスクで十分です。
4. 各タスクのinputはそのロールのAIに直接渡す具体的な指示にすること。前のタスクの結果を踏まえてほしい場合は、inputにその旨とdependsOnを明記してください。
   - ただし **file-searcher の調査結果だけは例外** です。file-searcher の成果は「プロジェクト共有コンテキスト」に変換され、後続の全ロールへ自動的に配布されます（各ロールには要約・ファイル一覧・依存関係と、そのロールに関係するファイル本文だけが渡ります）。したがって全ロールから file-searcher へ dependsOn を張る必要はありません。file-searcher は 1 つ、依存なし（dependsOn: []）で先頭に置くのが基本です。
   - 調査対象が途中で変わる場合（例: coder の実装後に別領域を調べ直したい）は、2 つ目の file-searcher タスクを追加してかまいません。共有コンテキストは上書きではなくマージされます。
   - 各タスクには任意で `"context": ["src/auth/Auth.ts", ...]` を書けます。**そのタスクが実際に読む必要のあるファイルだけ**を挙げてください（多く渡すほど良いわけではありません）。省略した場合はロール別に自動選択されます。file-searcher の調査が終わった時点で、あなたにもう一度「配分だけ」を尋ねる機会があるので、この時点で分からなければ省略してかまいません。
   - なお、ファイルサイズ上限・秘密情報の除外・ロール権限・コンテキスト上限・要求回数の上限は Division API 側が別途強制します。あなたが指定しても、それらに反するものは渡りません。
5. 必ず以下のJSON形式のみで回答。挨拶や説明文は【絶対に】出力しない
6. 1タスクに複数作業を詰め込まず、必要なら細かく分割する
7. 同じロールでも異なる観点なら別タスクに分けてよい
8. 各タスクに "mode" を指定:
    - "chat": テキスト生成タスク（デフォルト。searcher, researcher, file-searcher 等もこれ）
    - "computer_use": コード実行・テストが必要なタスク（coder ロール用）
    ※ searcher / researcher ロールは Perplexity が Web 検索するため mode="chat" にすること
9. "finalRole" を必ず指定:
    - "coder": コードが主な成果物の場合
    - "writer": ドキュメント・文章が主な成果物の場合

\`\`\`json
{
  "tasks": [
    { "role": "file-searcher", "mode": "chat", "input": "プロジェクト内の関連ファイルを読み込み、既存実装・変更候補・注意点を Markdown レポートにまとめる", "reason": "実装前に既存コードを把握するため", "dependsOn": [] },
    { "role": "coder", "mode": "computer_use", "input": "file-searcher の調査結果を踏まえて実装する", "reason": "動作するコードを生成するため", "dependsOn": [0], "context": [] },
    { "role": "reviewer", "mode": "chat", "input": "実装結果の品質確認と改善提案。OK/Not OK を明示する", "reason": "品質保証のため", "dependsOn": [1], "context": [] }
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

export const FILE_SEARCHER_ROLE = "file-searcher";

export function isFileSearcherRole(roleSlug: string): boolean {
  return normalizeRoleSlug(roleSlug) === FILE_SEARCHER_ROLE;
}

/**
 * dependsOn で指定された上流タスクの出力を貼り付ける。
 *
 * file-searcher だけは例外扱いする。その全文レポートは巨大になりがちで、
 * 直接の依存先だけに全文を配るとトークンが跳ね上がり、他のロールには何も届かない。
 * 代わりに `buildProjectContextBlock` が生成する共有コンテキスト
 * （Level 1 = 全ロール共通の要約 / Level 2 = ロール別の関連ファイル本文）を
 * すべてのロールに配る。
 */
function buildDependencyMarkdown(
  task: SubTask,
  taskOutputs: string[],
  taskRoleNames: string[],
  taskProviderNames: string[],
  subTaskRoles?: string[]
): string {
  const deps = task.dependsOn || [];
  const contextParts: string[] = [];
  for (const depIdx of deps) {
    if (!taskOutputs[depIdx]) continue;
    if (subTaskRoles && isFileSearcherRole(subTaskRoles[depIdx] || "")) continue;
    contextParts.push(`### ${taskRoleNames[depIdx]} (${taskProviderNames[depIdx]}):\n${taskOutputs[depIdx]}`);
  }
  return contextParts.join("\n\n");
}

/** file-searcher の成果をロールに渡すときの構成要素。 */
interface RoleContextBlock {
  /** プロンプトに差し込む Markdown */
  markdown: string;
  /** 実際に本文を渡したパス */
  grantedPaths: string[];
}

/**
 * file-searcher が作った共有コンテキストを、このロール向けの形に整えて返す。
 *
 * - Level 1（サマリ・ファイル一覧・依存関係）は dependsOn の有無に関係なく全ロールへ。
 * - Level 2（ファイル本文）は **Leader が配分した `task.context`** を優先し、
 *   指定が無ければロール別の自動選択にフォールバックする。
 * - どちらの経路でも context-policy のゲートを必ず通る。サイズ上限・秘密情報の除外・
 *   ロール権限・コンテキスト上限は Leader の判断では動かせない。
 */
function buildProjectContextBlock(
  ctx: ProjectContext | null,
  task: SubTask,
  opts: { extraPaths?: string[] } = {}
): RoleContextBlock {
  const empty: RoleContextBlock = { markdown: "", grantedPaths: [] };
  if (!ctx || isEmptyProjectContext(ctx)) return empty;

  const roleSlug = normalizeRoleSlug(task.role);
  if (isFileSearcherRole(roleSlug)) return empty;

  const shared = renderSharedContext(ctx);
  if (!roleReceivesFileBodies(roleSlug)) {
    // 本文を受け取らないロール（planner / searcher など）は Level 1 だけ。
    return { markdown: shared, grantedPaths: [] };
  }

  const byPath = new Map(ctx.relevantFiles.map((f) => [f.path, f]));
  const toContextFile = (path: string, reason?: string): ContextFile => {
    const known = byPath.get(path);
    if (!known) return { path, ...(reason ? { reason } : {}) };
    return reason ? { ...known, reason } : known;
  };

  const leaderRouted = (task.context ?? []).filter(Boolean);
  const requested: ContextFile[] = [];
  for (const p of opts.extraPaths ?? []) {
    requested.push(toContextFile(p, "このタスクからの追加要求"));
  }
  if (leaderRouted.length > 0) {
    for (const p of leaderRouted) requested.push(toContextFile(p, "Leader が配分"));
  } else {
    requested.push(...selectRelevantFilesForRole(ctx, roleSlug));
  }

  // Pull 型の再依頼は「記憶の無い新しい呼び出し」なので、前回渡したものも含めて
  // 毎回すべて渡し直す。`alreadyGranted` は台帳側の循環検出だけに使う。
  const decision = applyContextPolicy(roleSlug, requested, ctx);
  const rendered = renderDecision(roleSlug, decision);

  return {
    markdown: [shared, rendered, PULL_REQUEST_INSTRUCTIONS].filter(Boolean).join("\n\n"),
    grantedPaths: decision.granted.map((g) => g.path),
  };
}

/**
 * Pull 型。各ロールは足りないファイルを自分から要求できる。
 *
 *   Coder → 「Auth.ts が必要」 → Leader/Policy → FileSearcher の成果 → Coder
 *
 * 要求は context-policy のゲートを通り、回数にも上限がある（暴走と循環の防止）。
 */
const PULL_REQUEST_INSTRUCTIONS = `## 足りないファイルの要求

上に載っていないファイルが必要なら、回答の末尾に次のブロックを付けてください。追加のファイルを添えてもう一度あなたに依頼します。

\`\`\`json context-request
{ "paths": ["src/auth/Auth.ts"], "reason": "実装に必要" }
\`\`\`

- 本当に必要なファイルだけを挙げてください（1 回につき最大 8 件、1 タスクにつき最大 2 回）。
- 要求と同時に、いま分かる範囲での回答も書いてください。要求だけを返さないでください。`;

const CONTEXT_ROUTING_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。file-searcher の調査が終わったので、これから走る各タスクに「どのファイルを渡すか」を配分してください。

## 配分の考え方
- そのタスクを遂行するのに実際に読む必要があるファイルだけを挙げてください。多く渡すほど良いわけではありません。
- ロールによって必要なものは違います。実装なら変更対象と呼び出し元、レビューなら実装とテスト、テストならテストと対象実装、セキュリティなら認証・権限・設定まわり。
- ファイル一覧に無いパスは書かないでください。
- 配分を決めきれないタスクは routes から省いてください。自動選択にフォールバックします。

## 出力
次の JSON だけを出力してください。挨拶や説明文は出力しないでください。

\`\`\`json
{
  "routes": [
    { "task": 1, "context": ["src/auth/Auth.ts", "src/pages/Login.tsx"] },
    { "task": 2, "context": ["src/auth/Auth.ts", "tests/auth.test.ts"] }
  ]
}
\`\`\``;

/**
 * file-searcher の成果を Leader に戻し、残りのタスクへのファイル配分を決めさせる。
 *
 *   User → Leader →「FileSearcher に調査させよう」→ FileSearcher → 検索結果
 *        → Leader →「この情報なら Coder には A,B,C を渡そう」→ Coder
 *
 * Leader は「誰に何を渡すか」だけを決める。サイズ上限・秘密情報・ロール権限・
 * コンテキスト上限は context-policy が別に見るので、ここで守らせる必要はない。
 * 失敗しても致命ではない — 配分が得られなければロール別の自動選択に戻るだけ。
 */
async function routeContextWithLeader(params: {
  provider: Parameters<typeof executeTask>[0]["provider"];
  apiKey: string | undefined;
  userInput: string;
  ctx: ProjectContext;
  subTasks: SubTask[];
  pendingIndices: number[];
  signal?: AbortSignal;
}): Promise<number> {
  const { provider, apiKey, userInput, ctx, subTasks, pendingIndices, signal } = params;

  // 既に Leader が配分済み / 本文を受け取らないロールは聞くまでもない。
  const targets = pendingIndices.filter((idx) => {
    const t = subTasks[idx];
    if (!t) return false;
    if (isFileSearcherRole(t.role)) return false;
    if ((t.context ?? []).length > 0) return false;
    return roleReceivesFileBodies(normalizeRoleSlug(t.role));
  });
  if (targets.length === 0) return 0;

  const taskList = targets
    .map((idx) => {
      const t = subTasks[idx];
      return `- task ${idx}: role=${normalizeRoleSlug(t.role)} / ${t.input.slice(0, 200)}`;
    })
    .join("\n");

  const input = [
    `## ユーザーの元のリクエスト\n${userInput}`,
    renderSharedContext(ctx),
    `## 配分先のタスク\n${taskList}`,
  ].join("\n\n---\n\n");

  let output = "";
  try {
    const result = await executeTask({
      provider,
      config: { apiKey },
      input,
      role: { slug: "leader", name: "Leader" },
      systemPrompt: CONTEXT_ROUTING_SYSTEM_PROMPT,
      signal,
    });
    if (result.status !== "success") {
      logger.warn(`[ContextRouting] Leader failed: ${result.errorMsg || "unknown"}`);
      return 0;
    }
    output = result.output || "";
  } catch (err) {
    logger.warn(
      `[ContextRouting] Leader threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return 0;
  }

  let routes: unknown;
  try {
    routes = (JSON.parse(extractJson(output)) as Record<string, unknown>).routes;
  } catch (err) {
    logger.warn(
      `[ContextRouting] Unparsable routing response: ${err instanceof Error ? err.message : String(err)}`
    );
    return 0;
  }
  if (!Array.isArray(routes)) return 0;

  const knownPaths = new Set(ctx.files);
  const targetSet = new Set(targets);
  let applied = 0;

  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    const rec = route as Record<string, unknown>;
    const idx = Number(rec.task ?? rec.taskIndex ?? rec.index);
    if (!Number.isInteger(idx) || !targetSet.has(idx)) continue;
    const paths = (parseContextPaths(rec.context ?? rec.files) ?? []).filter((pth) =>
      knownPaths.has(pth)
    );
    if (paths.length === 0) continue;
    subTasks[idx].context = paths;
    applied++;
    logger.info(`[ContextRouting] task ${idx} (${subTasks[idx].role}) <- ${paths.join(", ")}`);
  }

  return applied;
}

/** Pull 型で追加ファイルを渡すときの、再依頼用の入力を組み立てる。 */
function buildPullFollowUpInput(
  previousInput: string,
  previousOutput: string | undefined,
  request: ContextRequest,
  contextBlock: RoleContextBlock
): string {
  const sections = [
    contextBlock.markdown,
    `## 追加コンテキストを渡しました`,
    [
      `あなたが要求したファイル${request.reason ? `（理由: ${request.reason}）` : ""}を上に添付しました。`,
      `要求が却下されたファイルは理由つきで記載しています。それらは前提から外して進めてください。`,
      `今度は context-request を出さず、最終的な回答を書いてください。`,
    ].join("\n"),
  ];
  if (previousOutput && previousOutput.trim()) {
    sections.push(`## あなたの前回の回答（追加コンテキスト無しで書いたもの）\n${previousOutput.trim()}`);
  }
  sections.push(previousInput);
  return sections.filter(Boolean).join("\n\n---\n\n");
}

/**
 * file-searcher の出力を構造化コンテキストへ変換し、既存のコンテキストにマージする。
 * 2 回目以降の file-searcher 実行はコンテキストを置き換えず積み上げる
 * （file-searcher を 1 回きりの検索役ではなく Context Manager として使う）。
 */
function absorbFileSearcherOutput(
  current: ProjectContext | null,
  output: string | undefined
): ProjectContext | null {
  const text = (output || "").trim();
  if (!text) return current;
  const parsed = parseProjectContext(text);
  if (isEmptyProjectContext(parsed)) return current;
  const merged = mergeProjectContext(current, parsed);
  logger.info(
    `[ProjectContext] absorbed file-searcher output: ${text.length} chars -> ` +
      `${merged.files.length} files, ${merged.relevantFiles.length} relevant, ` +
      `${merged.dependencies.length} deps, ${merged.symbols.length} symbols`
  );
  return merged;
}

/**
 * 非 file-searcher タスクは、原則としてすべての file-searcher タスクの完了を待ってから
 * 開始する。これにより「まず FileSearcher、その結果を全ロールが参照」というフローが
 * Leader の dependsOn の書き方に依存せず常に成立する。
 *
 * ただしその file-searcher 自身が依存している（＝先に走る必要がある）タスクは待たない。
 * 例: planner → file-searcher → coder の並びでは planner はバリアの対象外になる。
 * これにより循環待ちは発生しない。
 *
 * @returns タスク index ごとの「完了を待つべき file-searcher タスク index の配列」
 */
function buildFileSearcherBarriers(subTasks: SubTask[]): number[][] {
  const fileSearcherIndices: number[] = [];
  subTasks.forEach((t, i) => {
    if (isFileSearcherRole(t.role)) fileSearcherIndices.push(i);
  });
  if (fileSearcherIndices.length === 0) return subTasks.map(() => []);

  const ancestorsOf = (idx: number): Set<number> => {
    const out = new Set<number>();
    const stack = [...(subTasks[idx].dependsOn || [])];
    while (stack.length > 0) {
      const d = stack.pop() as number;
      if (!Number.isInteger(d) || d < 0 || d >= subTasks.length || out.has(d)) continue;
      out.add(d);
      stack.push(...(subTasks[d].dependsOn || []));
    }
    return out;
  };

  const ancestors = new Map<number, Set<number>>();
  for (const f of fileSearcherIndices) ancestors.set(f, ancestorsOf(f));

  return subTasks.map((t, i) => {
    if (isFileSearcherRole(t.role)) return [];
    return fileSearcherIndices.filter((f) => f !== i && !(ancestors.get(f) as Set<number>).has(i));
  });
}

/**
 * Leader が指定した dependsOn をそのまま信頼する。ここでは「自分より前のタスクだけを
 * 指す整数インデックス」であることだけを保証する（範囲外・自己参照・未来参照を除去）。
 * ロールの強制挿入や dependsOn の上書きは行わない — Leader が出したタスク構成が
 * そのまま実行される。
 */
function sanitizeDependsOn(tasks: SubTask[]): SubTask[] {
  return tasks.map((t, i) => ({
    ...t,
    dependsOn: (t.dependsOn || []).filter(
      (d) => Number.isInteger(d) && d >= 0 && d < i
    ),
  }));
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

/** Leader が書いた `context` 配列を、パスの配列として読む。 */
function parseContextPaths(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      paths.push(entry.trim().replace(/^\.\//, ""));
      continue;
    }
    // `{"path": "..."}` の形で書いてくることがあるので拾う
    if (entry && typeof entry === "object") {
      const p = (entry as Record<string, unknown>).path;
      if (typeof p === "string" && p.trim()) paths.push(p.trim().replace(/^\.\//, ""));
    }
  }
  return paths.length > 0 ? paths : undefined;
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
      context: parseContextPaths(t.context ?? t.files),
    }));

    const finalRole = parsed.finalRole === "coder" ? "coder" : "writer";

    return { tasks: sanitizeDependsOn(tasks), finalRole };
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

  // NOTE: Leader の systemPrompt は **常にコード側の LEADER_SYSTEM_PROMPT を使う**。
  // DB (Role.systemPrompt) に古いプロンプトが残っていると Leader プロンプトの変更が反映されないため。
  if (leaderRole.systemPrompt && leaderRole.systemPrompt !== LEADER_SYSTEM_PROMPT) {
    logger.info(
      `[Agent] DB の leaderRole.systemPrompt を無視してコード側 LEADER_SYSTEM_PROMPT を使用`
    );
  }
  const leaderResult = await executeTask({
    provider: leaderProvider,
    config: { apiKey: leaderApiKey },
    input: augmentLeaderInput(req),
    role: { slug: "leader", name: "Leader" },
    systemPrompt: LEADER_SYSTEM_PROMPT,
    chatHistory: req.chatHistory,
    signal: req.signal,
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

  /**
   * file-searcher が作る共有コンテキスト。全ロールへ Level 1 + Level 2 の形で配布し、
   * file-searcher が複数回走る場合はマージして更新していく。
   */
  let projectContext: ProjectContext | null = null;
  /** Pull 型の追加要求を数え、循環と暴走を止める台帳 */
  const contextLedger = new ContextRequestLedger();
  /** file-searcher の成果を Leader へ戻す配分ステップは 1 実行につき 1 回だけ */
  let contextRoutingDone = false;
  /** タスクごとに「先に完了していてほしい file-searcher タスク」の一覧 */
  const fileSearcherBarriers = buildFileSearcherBarriers(subTasks);

  async function executeSubTaskNonStream(
    i: number,
    opts?: { inputOverride?: string; isPullRetry?: boolean }
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
    if (opts?.inputOverride !== undefined) {
      enrichedInput = opts.inputOverride;
    } else {
      enrichedInput = task.input;
      if (isFileSearcherRole(task.role)) {
        // 後続ロールへ機械的に配布できるよう、構造化コンテキストの出力契約を付ける。
        enrichedInput = `${enrichedInput}${FILE_SEARCHER_OUTPUT_CONTRACT}`;
      } else {
        const sections: string[] = [];
        const contextBlock = buildProjectContextBlock(projectContext, task);
        if (contextBlock.markdown) sections.push(contextBlock.markdown);
        contextLedger.recordGranted(i, contextBlock.grantedPaths);
        const upstreamMarkdown = buildDependencyMarkdown(
          task,
          taskOutputs,
          taskRoleNames,
          taskProviderNames,
          subTasks.map((t) => t.role)
        );
        if (upstreamMarkdown) {
          sections.push(`## これまでの他のエージェントの作業結果:\n${upstreamMarkdown}`);
        }
        if (sections.length > 0) {
          sections.push(`## あなたへの指示:\n${task.input}`);
          enrichedInput = sections.join("\n\n---\n\n");
        }
      }
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
      signal: req.signal,
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

    if (isFileSearcherRole(task.role) && result.status === "success") {
      projectContext = absorbFileSearcherOutput(projectContext, result.output);
    }

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

    // --- Pull 型: ロールからの追加コンテキスト要求 ---
    //
    //   Coder →「Auth.ts が必要」→ Policy Layer → file-searcher の成果 → Coder
    //
    // 要求はポリシーのゲートを通り、台帳が回数と繰り返しを見張る。1 タスクにつき
    // 最大 2 回、実行全体で最大 6 回。再依頼は記憶の無い新しい呼び出しなので、
    // 前回渡した分も含めて全部渡し直す。
    if (result.status === "success" && !opts?.isPullRetry && !isFileSearcherRole(task.role)) {
      const request = parseContextRequest(result.output || "");
      if (request) {
        const denial = contextLedger.tryConsume(i, request);
        if (denial) {
          log(`[Agent] Context request from [${task.role}] denied: ${denial}`);
        } else {
          const followUp = buildProjectContextBlock(projectContext, task, {
            extraPaths: request.paths,
          });
          const newlyGranted = followUp.grantedPaths.filter(
            (pth) => !contextLedger.grantedPathsFor(i).has(pth)
          );
          if (newlyGranted.length > 0) {
            contextLedger.recordGranted(i, followUp.grantedPaths);
            log(
              `[Agent] Context request from [${task.role}]: granting ${newlyGranted.join(", ")}`
            );
            await executeSubTaskNonStream(i, {
              inputOverride: buildPullFollowUpInput(enrichedInput, result.output, request, followUp),
              isPullRetry: true,
            });
          } else {
            log(
              `[Agent] Context request from [${task.role}]: nothing new to grant (${request.paths.join(", ")})`
            );
          }
        }
      }
    }
  }

  // Dependency-aware parallel scheduler
  const remaining = new Set(subTasks.map((_, idx) => idx));

  while (remaining.size > 0) {
    const ready: number[] = [];
    for (const idx of remaining) {
      const deps = subTasks[idx].dependsOn || [];
      // file-searcher は共有コンテキストの生成役なので、他ロールより先に完了させる。
      const barrier = fileSearcherBarriers[idx] || [];
      if (deps.every((d) => completed.has(d)) && barrier.every((d) => completed.has(d))) {
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

    // file-searcher が終わった直後に、その成果を Leader へ戻して残りタスクへの
    // ファイル配分を決めさせる。次の wave からこの配分が使われる。
    if (!contextRoutingDone && projectContext && !isEmptyProjectContext(projectContext)) {
      contextRoutingDone = true;
      const applied = await routeContextWithLeader({
        provider: leaderProvider,
        apiKey: leaderApiKey,
        userInput: req.input,
        ctx: projectContext,
        subTasks,
        pendingIndices: [...remaining],
        signal: req.signal,
      });
      log(`[Agent] Leader routed context for ${applied} task(s)`);
    }
  }

  // [strict-mode] Reviewer ↔ Coder/Writer ↔ File Search の自動フィードバックループは廃止。
  // Leader が出した tasks JSON だけで実行し、Reviewer は通常のタスクとして 1 度だけ走る。

  // 5. Synthesis step — collect all outputs and pass to Coder/Writer
  const filledResults = results.filter(Boolean);
  const successfulResults = filledResults.filter((r) => r.status === "success" && r.output);
  // file-searcher の全文レポートは共有コンテキストとして別途渡すので、統合入力からは外す。
  const successfulOutputs = successfulResults
    .filter((r) => !isFileSearcherRole(r.role))
    .map((r) => `### ${r.role} (${r.provider}):\n${r.output}`);

  let finalOutput: string | undefined;
  let finalCode: string | undefined;

  if (successfulResults.length > 0) {
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
    const synthesisContextBlock = buildProjectContextBlock(projectContext, {
      role: synthesisRoleSlug,
      mode: "chat",
      input: "",
      reason: "synthesis",
    });
    const synthesisInput = [
      `## ユーザーの元のリクエスト:\n${augmentLeaderInput(req)}`,
      ...(synthesisContextBlock.markdown ? [synthesisContextBlock.markdown] : []),
      `## 各エージェントの作業結果:\n${successfulOutputs.join("\n\n")}`,
    ].join("\n\n---\n\n");

    log(`[Agent] Synthesis step: ${finalRole} → ${synthesisProvider.displayName}`);
    const synthesisMaxTokens = ROLE_SYNTHESIS_MAX_TOKENS[synthesisRoleSlug];
    const synthesisResult = await executeTask({
      provider: synthesisProvider,
      config: { apiKey: synthesisApiKey, ...(synthesisMaxTokens ? { maxTokens: synthesisMaxTokens } : {}) },
      input: synthesisInput,
      role: { slug: synthesisRoleSlug, name: synthesisRole?.name || finalRole },
      systemPrompt: synthesisRole?.systemPrompt ?? SYNTHESIS_SYSTEM_PROMPT,
      signal: req.signal,
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
  // NOTE: Leader の systemPrompt は **常にコード側の LEADER_SYSTEM_PROMPT を使う**。
  // DB (Role.systemPrompt) に古いプロンプトが残っていると Leader プロンプトの変更が反映されないため。
  if (leaderRole.systemPrompt && leaderRole.systemPrompt !== LEADER_SYSTEM_PROMPT) {
    logger.info(
      `[AgentStream] DB の leaderRole.systemPrompt を無視してコード側 LEADER_SYSTEM_PROMPT を使用`
    );
  }
  const leaderResult = await executeTaskStream(
    {
      provider: leaderProvider,
      config: { apiKey: leaderApiKey },
      input: augmentLeaderInput(req),
      role: { slug: "leader", name: "Leader" },
      systemPrompt: LEADER_SYSTEM_PROMPT,
      chatHistory: req.chatHistory,
      signal: req.signal,
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

  /**
   * file-searcher が作る共有コンテキスト。全ロールへ Level 1 + Level 2 の形で配布し、
   * file-searcher が複数回走る場合はマージして更新していく。
   */
  let projectContext: ProjectContext | null = null;
  /** Pull 型の追加要求を数え、循環と暴走を止める台帳 */
  const contextLedger = new ContextRequestLedger();
  /** file-searcher の成果を Leader へ戻す配分ステップは 1 実行につき 1 回だけ */
  let contextRoutingDone = false;
  /** タスクごとに「先に完了していてほしい file-searcher タスク」の一覧 */
  const fileSearcherBarriers = buildFileSearcherBarriers(subTasks);

  /** Execute a single sub-task at the given index */
  async function executeSubTask(
    i: number,
    opts?: { inputOverride?: string; isPullRetry?: boolean }
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
    if (opts?.inputOverride !== undefined) {
      enrichedInput = opts.inputOverride;
    } else {
      enrichedInput = task.input;
      if (isFileSearcherRole(task.role)) {
        // 後続ロールへ機械的に配布できるよう、構造化コンテキストの出力契約を付ける。
        enrichedInput = `${enrichedInput}${FILE_SEARCHER_OUTPUT_CONTRACT}`;
      } else {
        const sections: string[] = [];
        const contextBlock = buildProjectContextBlock(projectContext, task);
        if (contextBlock.markdown) sections.push(contextBlock.markdown);
        contextLedger.recordGranted(i, contextBlock.grantedPaths);
        const upstreamMarkdown = buildDependencyMarkdown(
          task,
          taskOutputs,
          taskRoleNames,
          taskProviderNames,
          subTasks.map((t) => t.role)
        );
        if (upstreamMarkdown) {
          sections.push(`## これまでの他のエージェントの作業結果:\n${upstreamMarkdown}`);
        }
        if (sections.length > 0) {
          sections.push(`## あなたへの指示:\n${task.input}`);
          enrichedInput = sections.join("\n\n---\n\n");
        }
      }
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
        signal: req.signal,
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

    if (isFileSearcherRole(task.role) && result.status === "success") {
      projectContext = absorbFileSearcherOutput(projectContext, result.output);
    }

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

    // --- Pull 型: ロールからの追加コンテキスト要求 ---
    //
    //   Coder →「Auth.ts が必要」→ Policy Layer → file-searcher の成果 → Coder
    //
    // 要求はポリシーのゲートを通り、台帳が回数と繰り返しを見張る。1 タスクにつき
    // 最大 2 回、実行全体で最大 6 回。再依頼は記憶の無い新しい呼び出しなので、
    // 前回渡した分も含めて全部渡し直す。
    if (result.status === "success" && !opts?.isPullRetry && !isFileSearcherRole(task.role)) {
      const request = parseContextRequest(result.output || "");
      if (request) {
        const denial = contextLedger.tryConsume(i, request);
        if (denial) {
          logger.info(`[Agent] Context request from [${task.role}] denied: ${denial}`);
        } else {
          const followUp = buildProjectContextBlock(projectContext, task, {
            extraPaths: request.paths,
          });
          const newlyGranted = followUp.grantedPaths.filter(
            (pth) => !contextLedger.grantedPathsFor(i).has(pth)
          );
          if (newlyGranted.length > 0) {
            contextLedger.recordGranted(i, followUp.grantedPaths);
            logger.info(
              `[Agent] Context request from [${task.role}]: granting ${newlyGranted.join(", ")}`
            );
            await executeSubTask(i, {
              inputOverride: buildPullFollowUpInput(enrichedInput, result.output, request, followUp),
              isPullRetry: true,
            });
          } else {
            logger.info(
              `[Agent] Context request from [${task.role}]: nothing new to grant (${request.paths.join(", ")})`
            );
          }
        }
      }
    }
  }

  // --- Dependency-aware parallel scheduler ---
  // Repeatedly run every task whose dependsOn are all completed, until none remain.
  // Each task's own lifecycle is reported via task_start/task_chunk/task_done/task_error.

  const remaining = new Set(subTasks.map((_, idx) => idx));

  while (remaining.size > 0) {
    // Find tasks whose dependencies are all satisfied
    const ready: number[] = [];
    for (const idx of remaining) {
      const deps = subTasks[idx].dependsOn || [];
      // file-searcher は共有コンテキストの生成役なので、他ロールより先に完了させる。
      const barrier = fileSearcherBarriers[idx] || [];
      if (deps.every((d) => completed.has(d)) && barrier.every((d) => completed.has(d))) {
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

    // Execute this batch concurrently
    await Promise.all(ready.map((idx) => executeSubTask(idx)));

    // Mark as completed
    for (const idx of ready) {
      completed.add(idx);
    }

    // file-searcher が終わった直後に、その成果を Leader へ戻して残りタスクへの
    // ファイル配分を決めさせる。次の wave からこの配分が使われる。
    if (!contextRoutingDone && projectContext && !isEmptyProjectContext(projectContext)) {
      contextRoutingDone = true;
      const applied = await routeContextWithLeader({
        provider: leaderProvider,
        apiKey: leaderApiKey,
        userInput: req.input,
        ctx: projectContext,
        subTasks,
        pendingIndices: [...remaining],
        signal: req.signal,
      });
      logger.info(`[AgentStream] Leader routed context for ${applied} task(s)`);
    }
  }

  // [strict-mode] Reviewer ↔ Coder/Writer ↔ File Search の自動フィードバックループは廃止。
  // Leader が出した tasks JSON だけで実行し、Reviewer は通常のタスクとして 1 度だけ走る。

  // 6. Synthesis step — collect all outputs and pass to Coder/Writer
  const filledResults = taskResults.filter(Boolean);
  const successfulResults = filledResults.filter((r) => r.status === "success" && r.output);
  // file-searcher の全文レポートは共有コンテキストとして別途渡すので、統合入力からは外す。
  const successfulOutputs = successfulResults
    .filter((r) => !isFileSearcherRole(r.role))
    .map((r) => `### ${r.role} (${r.provider}):\n${r.output}`);

  let finalOutput: string | undefined;

  if (successfulResults.length > 0) {
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

    const synthesisContextBlock = buildProjectContextBlock(projectContext, {
      role: synthesisRoleSlug,
      mode: "chat",
      input: "",
      reason: "synthesis",
    });
    const synthesisInput = [
      `## ユーザーの元のリクエスト:\n${augmentLeaderInput(req)}`,
      ...(synthesisContextBlock.markdown ? [synthesisContextBlock.markdown] : []),
      `## 各エージェントの作業結果:\n${successfulOutputs.join("\n\n")}`,
    ].join("\n\n---\n\n");

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
        signal: req.signal,
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