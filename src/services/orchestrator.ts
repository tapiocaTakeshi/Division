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

const LEADER_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下の Wave 構造でタスクを分解してください。

## パイプライン構造（必ずこの Wave 順序で多層化する）

【Wave 1 — 初回ファイルスキャン】単独実行（dependsOn: []）
- file-searcher（**初回スキャン**）: プロジェクト内の **すべてのフォルダ・ファイル** を最初に読み込み、構造・既存実装・変更候補・注意点を Markdown レポートにまとめる（GPT担当）。**ideaman / searcher / researcher より前**に必ず単独で走り、後続全員にプロジェクトの「現在の真実」を渡す。

【Wave 2 — 調査・発想】Wave 1 に依存（dependsOn: [Wave 1 の file-searcher の index]）
- ideaman: 創造的ブレインストーミング・アイデア出し（Claude担当）。既存コードを把握した上でアイデアを出す。
- searcher: ウェブ検索・情報収集（Perplexity担当）
- researcher: 調査・分析・レポート（Perplexity Deep Research担当）

【Wave 3 — 設計・デザイン】Wave 1 + Wave 2 に依存
- designer: UI/UXデザイン・HTML/CSS生成・ランディングページ・プロトタイプ（Gemini担当。完全に自己完結したHTMLを生成）
- imager: 画像生成・ビジュアルコンテンツ・イラスト（GPT Image担当）
- planner: 企画・設計・アーキテクチャ・戦略立案（Gemini担当）

【Wave 4 — File Search（集中再調査）】Wave 3 に依存
- file-searcher（**集中再調査**）: Wave 3 の設計・画像・計画を元に、変更対象ファイル・既存実装の差分・注意点を集中的に調査し、Coder/Writer がそのまま実装できる詳細な Markdown レポートを作成する（GPT担当）

【Wave 5 — 実装・執筆】Wave 4 の集中再調査に依存
- coder: コード生成・実装・デバッグ（Claude担当）
- writer: 文章作成・ドキュメント（Claude担当）

【Wave 6 — レビュー】Wave 5に依存（最終ステップ）
- reviewer: 品質確認・レビュー・改善提案（GPT担当）※ dependsOn には必ず「レビュー対象の coder または writer」のタスク index を含める

【最終統合】reviewer 完了後に自動実行（tasksに含めない）

**重要**: 各タスクは Leader が出した tasks JSON の指示通りに 1 度だけ実行されます。Reviewer ↔ Coder のフィードバックループや、Leader による Todos / Brief Gate の自動挿入はありません。Reviewer の指摘で再修正させたい場合は、必要なタスクをあらかじめ tasks に書いてください。

## 利用可能なロール一覧
ideaman, searcher, researcher, file-searcher, designer, imager, planner, coder, writer, reviewer

## ルール
1. 各タスクには0始まりのインデックスが付与されます（0, 1, 2...）
2. dependsOn で依存先のインデックスを指定。空=並列実行
3. **【必須】file-searcher を 2 タスク含めること**:
   - 1 つ目（**Wave 1 = 初回スキャン**）: 配列の **先頭（index 0）** に置く。dependsOn: [] で **単独で先に**実行する。input には「プロジェクト内のすべてのフォルダ・ファイルを読み込んで構造を把握する」ことを必ず含める。
   - 2 つ目（**Wave 4 = 集中再調査**）: dependsOn には Wave 3（designer/imager/planner）の index を含める。input には「Wave 3 の設計を踏まえて、変更対象ファイルと差分を集中的に調査する」ことを必ず含める。
4. **【必須】Wave 2 には ideaman, searcher, researcher を必ず1タスクずつ含め、すべて dependsOn に Wave 1 file-searcher の index を含めること。Wave 3 には designer, imager, planner を必ず1タスクずつ含め、Wave 1 + Wave 2 のすべての index に依存させること。**
5. 各タスクのinputはそのロールのAIに直接渡す具体的な指示にすること。Coder/Writer や file-searcher（再調査）に何を読ませて何を作らせたいかは、Leader が input にすべて書き切ること。
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
    { "role": "file-searcher", "mode": "chat", "input": "プロジェクト内のすべてのフォルダ・ファイルを読み込み、構造・既存実装・変更候補・注意点を Markdown レポートにまとめる（Wave 1 / 初回スキャン）", "reason": "Wave 2 以降の全員に既存コードベース全体を渡すため", "dependsOn": [] },
    { "role": "ideaman", "mode": "chat", "input": "Wave 1 の既存コードスキャンを踏まえ、ユーザーのリクエストに対する革新的なアプローチを複数提案", "reason": "多角的な視点を得るため", "dependsOn": [0] },
    { "role": "searcher", "mode": "chat", "input": "Wave 1 の既存コードを踏まえ、技術的な実現可能性と最新のベストプラクティスを検索", "reason": "正確な前提知識を得るため", "dependsOn": [0] },
    { "role": "researcher", "mode": "chat", "input": "Wave 1 の既存コードを踏まえ、関連する技術トレンドと事例を調査", "reason": "深い理解を得るため", "dependsOn": [0] },
    { "role": "designer", "mode": "chat", "input": "既存コードと Wave 2 の調査を元にUIデザインとプロトタイプHTMLを作成", "reason": "ビジュアルイメージを具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "imager", "mode": "chat", "input": "既存コードと Wave 2 のデザイン方針を元に必要な画像/ビジュアル案を作成", "reason": "視覚要素を具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "planner", "mode": "chat", "input": "既存コードと Wave 2 の調査を元に要件定義と設計を作成", "reason": "実装の方向性を決めるため", "dependsOn": [0, 1, 2, 3] },
    { "role": "file-searcher", "mode": "chat", "input": "Wave 3 の設計・画像・計画を元に、変更対象ファイル・既存実装の差分・注意点を集中的に調査して Coder/Writer 向け Markdown レポートを作成する（Wave 4 / 集中再調査）", "reason": "設計後に変更対象を絞り込んで実装の指示書を作るため", "dependsOn": [4, 5, 6] },
    { "role": "coder", "mode": "computer_use", "input": "Wave 4 の集中再調査の指示に沿って実装", "reason": "動作するコードを生成するため", "dependsOn": [7] },
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

/**
 * file-searcher ロールが DB に存在しない場合は自動で作成し、
 * 当該プロジェクトに assignment が無ければ leader と同じプロバイダーで自動 assign する。
 *
 * これがないと、`db:seed` を昔のバージョンで実行した既存ユーザーは file-searcher タスクが
 * 「Role not found: file-searcher」エラーで wave 1 で必ず失敗してしまう。
 */
async function ensureFileSearcherSetup(
  projectId: string,
  leaderProviderId: string
): Promise<void> {
  const role = await prisma.role.upsert({
    where: { slug: "file-searcher" },
    update: {},
    create: {
      slug: "file-searcher",
      name: "File Searcher",
      description:
        "Project-wide file scanner: reads all folders/files in Layer 1 and re-investigates focused areas in Layer 3 after the design phase.",
    },
  });

  // プロジェクト内 assignment があれば何もしない
  const existing = await prisma.roleAssignment.findFirst({
    where: { projectId, roleId: role.id },
  });
  if (existing) return;

  // 優先: 有効な OpenAI プロバイダー（GPT は file-searcher に最適）
  let provider = await prisma.provider.findFirst({
    where: { apiType: "openai", isEnabled: true },
    orderBy: { createdAt: "asc" },
  });

  // フォールバック: leader と同じプロバイダー（必ず存在する）
  if (!provider) {
    provider = await prisma.provider.findUnique({
      where: { id: leaderProviderId },
    });
  }
  if (!provider) return;

  await prisma.roleAssignment.create({
    data: {
      projectId,
      roleId: role.id,
      providerId: provider.id,
      priority: 10,
      config: JSON.stringify({ model: provider.modelId }),
    },
  });
  logger.info(
    `[Agent] Auto-bootstrapped file-searcher assignment: project=${projectId} -> ${provider.displayName} (${provider.modelId})`
  );
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

/**
 * Coder/Writer 相当の「実装タスク」か判定する。`normalizeDiagramFlow` のグルーピングに利用。
 */
function isImplementationTask(t: SubTask): boolean {
  const role = normalizeRoleSlug(t.role);
  return role === "coder" || role === "writer" || t.mode === "computer_use";
}

/**
 * file-searcher が 2 タスク構成になるよう正規化する:
 *  - "primary"  file-searcher: **Wave 1（最初に単独で実行）**。プロジェクト全体を最初に読む。
 *  - "focused"  file-searcher: Wave 4（dependsOn = Wave 3 の設計）。設計を踏まえて再調査。
 *
 * Wave 構造:
 *   Wave 1: primary file-searcher（単独）
 *   Wave 2: ideaman / searcher / researcher（並列、primary fs に依存）
 *   Wave 3: designer / imager / planner（並列、Wave 1 + Wave 2 に依存）
 *   Wave 4: focused file-searcher（Wave 3 に依存）
 *   Wave 5: coder / writer（focused fs に依存）
 *   Wave 6: reviewer（implementer に依存）
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
      reason: "Wave 1: ideaman / searcher / researcher の前にプロジェクト全体を把握するため",
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
      reason: "Wave 4: 設計後の集中再調査（Coder/Writer の直前指示）",
      dependsOn: [],
    });
    focusedFsOldIdx = base.length - 1;
  }

  // group 番号 = Wave 番号 - 1
  const groupOf = (task: SubTask, oldIndex: number): number => {
    if (oldIndex === primaryFsOldIdx) return 0;   // Wave 1
    if (oldIndex === focusedFsOldIdx) return 3;   // Wave 4
    const role = normalizeRoleSlug(task.role);
    if (layer1RoleSet.has(role)) return 1;         // Wave 2: ideaman/searcher/researcher
    if (layer2RoleSet.has(role)) return 2;         // Wave 3: designer/imager/planner
    if (isImplementationTask(task)) return 4;      // Wave 5: coder/writer
    if (role === "reviewer") return 5;             // Wave 6: reviewer
    return 2;
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

  const wave2Indices = indicesByGroup(1); // ideaman / searcher / researcher
  const wave3Indices = indicesByGroup(2); // designer / imager / planner
  const implementerIndices = indicesByGroup(4); // coder / writer
  const reviewerIndices = indicesByGroup(5);

  const dedupSorted = (arr: number[]) =>
    Array.from(new Set(arr)).sort((a, b) => a - b);

  for (let i = 0; i < ordered.length; i++) {
    if (i === newPrimaryFsIdx) {
      // Wave 1: primary file-searcher 単独。誰にも依存しない。
      ordered[i].dependsOn = [];
    } else if (i === newFocusedFsIdx) {
      // Wave 4: focused file-searcher は Wave 3（設計）に依存。
      ordered[i].dependsOn = wave3Indices.length
        ? [...wave3Indices]
        : wave2Indices.length
        ? [...wave2Indices]
        : newPrimaryFsIdx >= 0
        ? [newPrimaryFsIdx]
        : [];
    } else if (wave2Indices.includes(i)) {
      // Wave 2: ideaman / searcher / researcher は primary file-searcher に依存。
      ordered[i].dependsOn = newPrimaryFsIdx >= 0 ? [newPrimaryFsIdx] : [];
    } else if (wave3Indices.includes(i)) {
      // Wave 3: designer / imager / planner は primary fs + Wave 2 に依存。
      const deps: number[] = [];
      if (newPrimaryFsIdx >= 0) deps.push(newPrimaryFsIdx);
      deps.push(...wave2Indices);
      ordered[i].dependsOn = dedupSorted(deps);
    } else if (implementerIndices.includes(i)) {
      // Wave 5: coder / writer は focused file-searcher にのみ依存。
      const deps =
        newFocusedFsIdx >= 0
          ? [newFocusedFsIdx]
          : wave3Indices.length
          ? [...wave3Indices]
          : wave2Indices.length
          ? [...wave2Indices]
          : newPrimaryFsIdx >= 0
          ? [newPrimaryFsIdx]
          : [];
      ordered[i].dependsOn = dedupSorted(deps);
    } else if (reviewerIndices.includes(i)) {
      ordered[i].dependsOn = implementerIndices.length
        ? [...implementerIndices]
        : newFocusedFsIdx >= 0
        ? [newFocusedFsIdx]
        : wave3Indices.length
        ? [...wave3Indices]
        : wave2Indices.length
        ? [...wave2Indices]
        : newPrimaryFsIdx >= 0
        ? [newPrimaryFsIdx]
        : [];
    }
  }

  return ordered;
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

  // 1.5. file-searcher ロール / assignment を自動セットアップ（既存 DB 互換）
  await ensureFileSearcherSetup(req.projectId, leaderAssignment.provider.id);

  // 2. Ask Leader to decompose the task
  log(`[Agent] Session ${sessionId}`);
  log(`[Agent] Input: ${req.input}`);
  log(`[Agent] Leader: ${leaderProvider.displayName} (${leaderModelId})`);
  logger.info(`[Agent] Starting session`, { sessionId, projectId: req.projectId });

  // NOTE: Leader の systemPrompt は **常にコード側の LEADER_SYSTEM_PROMPT を使う**。
  // DB (Role.systemPrompt) に古いプロンプトが残っていると Wave 構造の変更が反映されないため。
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
    if (opts?.inputOverride !== undefined) {
      enrichedInput = opts.inputOverride;
    } else {
      enrichedInput = task.input;
      const upstreamMarkdown = buildDependencyMarkdown(task, taskOutputs, taskRoleNames, taskProviderNames);
      if (upstreamMarkdown) {
        enrichedInput = `## これまでの他のエージェントの作業結果:\n${upstreamMarkdown}\n\n## あなたへの指示:\n${task.input}`;
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

  // [strict-mode] Reviewer ↔ Coder/Writer ↔ File Search の自動フィードバックループは廃止。
  // Leader が出した tasks JSON だけで実行し、Reviewer は通常のタスクとして 1 度だけ走る。

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

  // 1.5. file-searcher ロール / assignment を自動セットアップ（既存 DB 互換）
  await ensureFileSearcherSetup(req.projectId, leaderAssignment.provider.id);

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
  // DB (Role.systemPrompt) に古いプロンプトが残っていると Wave 構造の変更が反映されないため。
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
    if (opts?.inputOverride !== undefined) {
      enrichedInput = opts.inputOverride;
    } else {
      enrichedInput = task.input;
      const upstreamMarkdown = buildDependencyMarkdown(task, taskOutputs, taskRoleNames, taskProviderNames);
      if (upstreamMarkdown) {
        enrichedInput = `## これまでの他のエージェントの作業結果:\n${upstreamMarkdown}\n\n## あなたへの指示:\n${task.input}`;
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

  // [strict-mode] Reviewer ↔ Coder/Writer ↔ File Search の自動フィードバックループは廃止。
  // Leader が出した tasks JSON だけで実行し、Reviewer は通常のタスクとして 1 度だけ走る。

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