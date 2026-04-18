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
import { checkCredits, consumeCredits, estimateTokens } from "./credits";
import { getLatestModelId } from "./model-resolver";

// --- Role Alias Mapping ---
// Leader AI sometimes generates role slugs that differ from DB slugs.
// Keys are casual aliases the Leader might emit; values are the canonical DB slugs.
const ROLE_ALIASES: Record<string, string> = {
  coder: "coding",
  writer: "writing",
  reviewer: "review",
  researcher: "deep-research",
  research: "deep-research",
  planner: "planning",
  designer: "design",
  "idea-man": "ideaman",
  ideagen: "ideaman",
};

function normalizeRoleSlug(slug: string): string {
  return ROLE_ALIASES[slug] || slug;
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
}

export interface OrchestratorResult {
  sessionId: string;
  input: string;
  leaderProvider: string;
  leaderModel: string;
  tasks: SubTaskResult[];
  mindmap: string;
  /** T3 synthesis output (Coder/Writer merge of T1+T2 results) */
  synthesisOutput?: string;
  /** T4 reviewer output — the user-visible final result */
  finalOutput?: string;
  finalCode?: string;
  totalDurationMs: number;
  status: "success" | "partial" | "error";
}

// --- Leader Prompt ---

const LEADER_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下の**固定4段パイプライン**に沿って専門ロールへ分解してください。

パイプライン構造 (User → Leader → T1 → T2 → T3 → T4 → User):
  T1 [調査・発想層]  … 並列実行
    - ideaman      : 創造的ブレインストーミング・アイデア出し
    - search       : ウェブ検索・情報収集（Perplexity）
    - file-search  : プロジェクト内ファイル検索・既存コード理解
    - deep-research: 徹底的な多角的調査・詳細レポート（Perplexity Deep Research）
  T2 [設計・ビジュアル層]  … T1の出力(Markdown)を受けて並列実行
    - design       : UI/UX設計・ワイヤーフレーム・デザインシステム
    - image        : 画像生成・ビジュアルコンテンツ作成
    - planning     : 戦略立案・アーキテクチャ設計・要件定義
  T3 [統合層 / Coder or Writer]  … T2の出力(Markdown)を統合して最終成果物を生成（自動）
  T4 [レビュー層 / Reviewer]     … T3の出力(Code or Text)をレビューして最終版を生成（自動）

利用可能なロール (tasksに含めてよいもの): ideaman, search, file-search, deep-research, design, image, planning
※ review / coding / writing は Leader の tasks に含めないでください。T3/T4は自動的に追加されます。

ルール:
1. 各タスクには0始まりのインデックスが暗黙的に付与されます（最初のタスクが0、次が1...）
2. 他のタスクの結果が必要な場合は "dependsOn" で依存先のインデックスを指定してください
3. **T1のタスクは dependsOn を空にしてください**（並列実行されます）
4. **T2のタスクは必ず少なくとも1つのT1タスクを dependsOn に含めてください**
5. 不要なロールは使わなくてOKです。ただしT1から最低1つ、T2から最低1つは含めてください。
6. 各タスクのinputは、そのロールのAIに直接渡す具体的な指示にしてください
7. 必ず以下のJSON形式のみで回答してください。挨拶や説明文など、JSONブロック以外のテキストは【絶対に】出力しないでください。
8. タスクは T1 と T2 の合計で4〜10個程度にしてください。不要にタスクを増やさないでください。
9. 1つのタスクに複数の作業を詰め込まず、できるだけ細かく分割してください
10. 同じロールでも異なる観点・対象であれば別タスクに分けてください
11. 各タスクには、そのタスクの性質に応じた "mode" を指定してください。
    - "chat" (デフォルト): 通常の文章生成等のテキストベースのタスク
    - "computer_use": 実際にターミナル等でコードを実行・テストする必要があるタスク
    - "function_calling": 検索やファイルの読み込み等、外部ツールを利用して情報収集するタスク（例: search等）
12. "finalRole" を必ず指定してください。T3(統合層)で使われる役割です。
    - "coder": コード生成が主な成果物の場合
    - "writer": ドキュメント・文章・レポートが主な成果物の場合

\`\`\`json
{
  "tasks": [
    { "role": "search", "mode": "function_calling", "input": "機能の実現可能性についての技術情報を検索", "reason": "T1: 前提知識を得るため" },
    { "role": "ideaman", "mode": "chat", "input": "リクエストに対する革新的なアプローチを複数案出す", "reason": "T1: 創造的視点を得るため" },
    { "role": "file-search", "mode": "function_calling", "input": "既存コードベースで関連実装を検索", "reason": "T1: 既存資産を把握するため" },
    { "role": "planning", "mode": "chat", "input": "調査結果とアイデアを元に要件定義とアーキテクチャを作成", "reason": "T2: 実装ゴールを設定するため", "dependsOn": [0, 1, 2] },
    { "role": "design", "mode": "chat", "input": "UI/UX設計とユーザーフローを作成", "reason": "T2: ユーザー体験を具体化するため", "dependsOn": [0, 1] }
  ],
  "finalRole": "coder"
}
\`\`\``;

// --- Synthesis Prompt ---

const SYNTHESIS_SYSTEM_PROMPT = `あなたは優秀な統合担当AIです (パイプラインT3: Coder or Writer)。
T1(調査・発想)とT2(設計・ビジュアル)の各専門AIエージェントの出力が以下に提供されます。
これらの全出力を統合し、ユーザーの元のリクエストに対する**最終的な成果物(Code or Text)**を生成してください。

ルール:
1. 必ず Markdown 形式で出力してください
2. 各エージェントの出力から重要な情報を抽出し、矛盾があれば最も正確な情報を採用してください
3. コードが含まれる場合はコードブロック内に正しい言語タグを付けてください
4. 見出し・リスト・表などを適切に使い、読みやすく構造化してください
5. 冗長な重複は排除し、簡潔で実用的な成果物にまとめてください
6. ユーザーのリクエストに直接答える形で出力してください`;

// --- Review Prompt (Tier 4) ---

const REVIEW_SYSTEM_PROMPT = `あなたは優秀なレビュー担当AIです (パイプラインT4: Reviewer)。
T3の統合担当AIが生成した成果物(Code or Text)が以下に提供されます。
この成果物をレビューし、ユーザーに届ける**最終版(result)**を出力してください。

手順:
1. 論理的誤り・矛盾・不正確な記述・バグ・セキュリティ上の懸念を特定する
2. 問題があれば修正を適用した最終版を出力する
3. 問題がなければ成果物を微調整し、読みやすさ・完成度を高めた最終版を出力する

出力フォーマット (Markdown):
## レビュー
- 検出した問題と対処 (箇条書き 3〜6点。問題なしの場合はその旨を短く記載)

## 最終成果物
<ここにユーザーに届ける最終版を配置。コードはコードブロック内に正しい言語タグを付ける>`;

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

/**
 * Resolve model ID from config + provider.
 * Supports "latest" keyword: dynamically looks up the best model for this apiType.
 * Falls back: config.model → provider.modelId → dynamic latest
 */
async function resolveModelId(
  config: Record<string, unknown> | undefined,
  provider: { apiType: string; modelId: string }
): Promise<string> {
  const configModel = config?.model as string | undefined;
  if (configModel && configModel !== "latest") return configModel;
  if (configModel === "latest") return getLatestModelId(provider.apiType, provider.modelId);
  if (provider.modelId) return provider.modelId;
  return getLatestModelId(provider.apiType);
}

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
      role: String(t.role || ""),
      mode: String(t.mode || "chat"),
      input: String(t.input || ""),
      reason: String(t.reason || ""),
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((v: unknown) => typeof v === "number") as number[] : undefined,
    }));

    const finalRole = parsed.finalRole === "coder" ? "coder" : "writer";

    return { tasks, finalRole };
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
    if (envVar && process.env[envVar]) {
      return process.env[envVar];
    }
  }

  // 2. Fall back to user-supplied apiKeys from request
  if (apiKeys) {
    // Direct match by provider name
    if (apiKeys[providerName]) return apiKeys[providerName];

    // Look up by apiType aliases
    const aliases = API_KEY_ALIASES[apiType] || [];
    for (const alias of aliases) {
      if (apiKeys[alias]) return apiKeys[alias];
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

  const leaderAssignment = await prisma.roleAssignment.findFirst({
    where: { projectId: req.projectId, roleId: leaderRole.id },
    include: { provider: true },
    orderBy: { priority: "desc" },
  });
  if (!leaderAssignment) {
    throw new Error(
      'No AI provider assigned to "leader" role in this project.'
    );
  }

  // Resolve model: config.model → "latest" → provider.modelId
  const leaderConfig = leaderAssignment.config ? JSON.parse(leaderAssignment.config) : {};
  const leaderModelId = await resolveModelId(leaderConfig, leaderAssignment.provider);
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

  // --- Credit check before processing ---
  if (req.userId && req.authenticated) {
    const estimatedTokensForSession = estimateTokens(req.input) * 5; // Rough estimate for multi-task session
    const creditCheck = await checkCredits(req.userId, estimatedTokensForSession);
    if (creditCheck && !creditCheck.canAfford) {
      log(`[Agent] Insufficient credits: balance=${creditCheck.creditBalance}, estimated=${creditCheck.estimatedCost}`);
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
    if (creditCheck) {
      log(`[Agent] Credit check OK: balance=${creditCheck.creditBalance}`);
    }
  }

  const leaderResult = await executeTask({
    provider: leaderProvider,
    config: { apiKey: leaderApiKey },
    input: req.input,
    role: { slug: "leader", name: "Leader" },
    systemPrompt: LEADER_SYSTEM_PROMPT,
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

  async function executeSubTaskNonStream(i: number): Promise<void> {
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
      modelId: string;
      isEnabled: boolean;
    } | null = null;

    const overrideProviderName = req.overrides?.[task.role];
    if (overrideProviderName) {
      const overrideProvider = await prisma.provider.findUnique({
        where: { name: overrideProviderName },
      });
      if (overrideProvider) {
        provider = overrideProvider;
      }
    }

    if (!provider) {
      const assignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: role.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (assignment) {
        const taskConfig = assignment.config ? JSON.parse(assignment.config) : {};
        const taskModelId = await resolveModelId(taskConfig, assignment.provider);
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

    // Build input with context from dependency tasks
    let enrichedInput = task.input;
    const deps = task.dependsOn || [];
    if (deps.length > 0) {
      const contextParts: string[] = [];
      for (const depIdx of deps) {
        if (taskOutputs[depIdx]) {
          contextParts.push(`### ${taskRoleNames[depIdx]} (${taskProviderNames[depIdx]}):\n${taskOutputs[depIdx]}`);
        }
      }
      if (contextParts.length > 0) {
        enrichedInput = `## これまでの他のエージェントの作業結果:\n${contextParts.join("\n")}\n\n## あなたへの指示:\n${task.input}`;
      }
    }

    const apiKey = resolveApiKey(provider.name, provider.apiType, req.apiKeys, req.authenticated);

    log(`[Agent] Executing: [${task.role}] → ${provider.displayName}`);
    logger.info(
      `[Agent] Executing: [${task.role}] → ${provider.displayName}`
    );

    const result = await executeTask({
      provider,
      config: { apiKey },
      input: enrichedInput,
      role: { slug: role.slug, name: role.name },
      mode: task.mode,
    });

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

    // --- Credit consumption after each task ---
    if (req.userId && req.authenticated && result.status === "success") {
      // Estimate tokens from input + output length
      const inputTokens = Math.ceil(enrichedInput.length / 3);
      const outputTokens = Math.ceil((result.output || "").length / 3);
      const totalTokens = inputTokens + outputTokens;
      try {
        await consumeCredits(
          req.userId,
          totalTokens,
          provider.modelId,
          provider.name,
          sessionId
        );
      } catch (creditErr) {
        log(`[Agent] Credit error: ${creditErr instanceof Error ? creditErr.message : String(creditErr)}`);
      }
    }

    // Log to DB
    await prisma.taskLog.create({
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

  // 5. Synthesis step (T3) — collect all outputs and pass to Coder/Writer
  const filledResults = results.filter(Boolean);
  const successfulOutputs = filledResults
    .filter((r) => r.status === "success" && r.output)
    .map((r) => `### ${r.role} (${r.provider}):\n${r.output}`);

  let synthesisOutput: string | undefined;
  let finalOutput: string | undefined;
  let finalCode: string | undefined;

  if (successfulOutputs.length > 0) {
    const synthesisRoleSlug = normalizeRoleSlug(finalRole);
    const synthesisRole = await prisma.role.findUnique({ where: { slug: synthesisRoleSlug } });

    let synthesisProvider: typeof leaderProvider | null = null;
    if (synthesisRole) {
      const synthesisAssignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: synthesisRole.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (synthesisAssignment) {
        const synthConfig = synthesisAssignment.config ? JSON.parse(synthesisAssignment.config) : {};
        const synthModelId = await resolveModelId(synthConfig, synthesisAssignment.provider);
        synthesisProvider = { ...synthesisAssignment.provider, modelId: synthModelId };
      }
    }

    if (synthesisProvider) {
      const synthesisApiKey = resolveApiKey(synthesisProvider.name, synthesisProvider.apiType, req.apiKeys, req.authenticated);
      const synthesisInput = `## ユーザーの元のリクエスト:\n${req.input}\n\n## 各エージェントの作業結果:\n${successfulOutputs.join("\n\n")}`;

      log(`[Agent] Synthesis step (T3): ${finalRole} → ${synthesisProvider.displayName} (${synthesisProvider.modelId})`);
      const synthesisResult = await executeTask({
        provider: synthesisProvider,
        config: { apiKey: synthesisApiKey },
        input: synthesisInput,
        role: { slug: synthesisRoleSlug, name: synthesisRole?.name || finalRole },
        systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
      });

      if (synthesisResult.status === "success") {
        synthesisOutput = synthesisResult.output;
      } else {
        synthesisOutput = successfulOutputs.join("\n\n---\n\n");
      }
    } else {
      synthesisOutput = successfulOutputs.join("\n\n---\n\n");
    }
  }

  // 5b. Review step (T4) — Reviewer polishes the T3 synthesis into the user-visible result
  if (synthesisOutput) {
    const reviewRole = await prisma.role.findUnique({ where: { slug: "review" } });
    let reviewProvider: typeof leaderProvider | null = null;
    if (reviewRole) {
      const reviewAssignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: reviewRole.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (reviewAssignment) {
        const revConfig = reviewAssignment.config ? JSON.parse(reviewAssignment.config) : {};
        const revModelId = await resolveModelId(revConfig, reviewAssignment.provider);
        reviewProvider = { ...reviewAssignment.provider, modelId: revModelId };
      }
    }

    if (reviewProvider) {
      const reviewApiKey = resolveApiKey(reviewProvider.name, reviewProvider.apiType, req.apiKeys, req.authenticated);
      const reviewInput = `## ユーザーの元のリクエスト:\n${req.input}\n\n## T3統合担当AIが生成した成果物(Code or Text):\n${synthesisOutput}`;

      log(`[Agent] Review step (T4): review → ${reviewProvider.displayName} (${reviewProvider.modelId})`);
      const reviewResult = await executeTask({
        provider: reviewProvider,
        config: { apiKey: reviewApiKey },
        input: reviewInput,
        role: { slug: "review", name: reviewRole?.name || "Review" },
        systemPrompt: REVIEW_SYSTEM_PROMPT,
      });

      finalOutput = reviewResult.status === "success" ? reviewResult.output : synthesisOutput;
    } else {
      finalOutput = synthesisOutput;
    }

    if (finalRole === "coder") finalCode = finalOutput;
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
    synthesisOutput,
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
  /** T3 synthesis output (Coder/Writer) */
  synthesisOutput?: string;
  /** T4 reviewer output — the user-visible final result */
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
export interface StreamEventReviewStart {
  type: "review_start";
  id: string;
  role: string;
  provider: string;
  model: string;
}
export interface StreamEventReviewChunk {
  type: "review_chunk";
  id: string;
  text: string;
}
export interface StreamEventReviewDone {
  type: "review_done";
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
  | StreamEventSynthesisDone
  | StreamEventReviewStart
  | StreamEventReviewChunk
  | StreamEventReviewDone;

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

  const leaderAssignment = await prisma.roleAssignment.findFirst({
    where: { projectId: req.projectId, roleId: leaderRole.id },
    include: { provider: true },
    orderBy: { priority: "desc" },
  });
  if (!leaderAssignment) {
    emit({ type: "leader_error", id: nextId(), error: 'No AI provider assigned to "leader" role in this project.' });
    return;
  }

  // Resolve model: config.model → "latest" → provider.modelId
  const leaderConfig = leaderAssignment.config ? JSON.parse(leaderAssignment.config) : {};
  const leaderModelId = await resolveModelId(leaderConfig, leaderAssignment.provider);
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
      input: req.input,
      role: { slug: "leader", name: "Leader" },
      systemPrompt: LEADER_SYSTEM_PROMPT,
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
  }> = new Array(subTasks.length);

  // Track completion state per task
  const taskOutputs: string[] = new Array(subTasks.length).fill("");
  const taskRoleNames: string[] = new Array(subTasks.length).fill("");
  const taskProviderNames: string[] = new Array(subTasks.length).fill("");
  const completed = new Set<number>();

  /** Execute a single sub-task at the given index */
  async function executeSubTask(i: number): Promise<void> {
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
      modelId: string;
      isEnabled: boolean;
    } | null = null;

    const overrideProviderName = req.overrides?.[task.role];
    if (overrideProviderName) {
      const overrideProvider = await prisma.provider.findUnique({
        where: { name: overrideProviderName },
      });
      if (overrideProvider) {
        provider = overrideProvider;
      }
    }

    if (!provider) {
      const assignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: role.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (assignment) {
        const taskConfig = assignment.config ? JSON.parse(assignment.config) : {};
        const taskModelId = await resolveModelId(taskConfig, assignment.provider);
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

    // Build enriched input with context from dependency tasks
    let enrichedInput = task.input;
    const deps = task.dependsOn || [];
    if (deps.length > 0) {
      const contextParts: string[] = [];
      for (const depIdx of deps) {
        if (taskOutputs[depIdx]) {
          contextParts.push(`### ${taskRoleNames[depIdx]} (${taskProviderNames[depIdx]}):\n${taskOutputs[depIdx]}`);
        }
      }
      if (contextParts.length > 0) {
        enrichedInput = `## これまでの他のエージェントの作業結果:\n${contextParts.join("\n")}\n\n## あなたへの指示:\n${task.input}`;
      }
    }

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
      input: task.input,
      mode: task.mode,
    });

    const result = await executeTaskStream(
      {
        provider,
        config: { apiKey },
        input: enrichedInput,
        role: { slug: role.slug, name: role.name },
        mode: task.mode,
      },
      (text) => emit({ type: "task_chunk", id: nextId(), taskId: taskIdOf(i), index: i, role: task.role, text }),
      (text) => emit({ type: "task_thinking_chunk", id: nextId(), taskId: taskIdOf(i), index: i, role: task.role, text })
    );

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
    };
    taskOutputs[i] = result.output;

    // Log to DB
    await prisma.taskLog.create({
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

  // 6. Synthesis step (T3) — collect all outputs and pass to Coder/Writer
  const filledResults = taskResults.filter(Boolean);
  const successfulOutputs = filledResults
    .filter((r) => r.status === "success" && r.output)
    .map((r) => `### ${r.role} (${r.provider}):\n${r.output}`);

  type ProviderRecord = {
    id: string;
    name: string;
    displayName: string;
    apiBaseUrl: string;
    apiType: string;
    modelId: string;
    isEnabled: boolean;
  };

  let synthesisOutput: string | undefined;
  let finalOutput: string | undefined;

  if (successfulOutputs.length > 0) {
    // Resolve the synthesis role (coder or writer)
    const synthesisRoleSlug = normalizeRoleSlug(finalRole);
    const synthesisRole = await prisma.role.findUnique({
      where: { slug: synthesisRoleSlug },
    });

    let synthesisProvider: ProviderRecord | null = null;

    if (synthesisRole) {
      const synthesisAssignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: synthesisRole.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (synthesisAssignment) {
        const synthConfig = synthesisAssignment.config ? JSON.parse(synthesisAssignment.config) : {};
        const synthModelId = await resolveModelId(synthConfig, synthesisAssignment.provider);
        synthesisProvider = { ...synthesisAssignment.provider, modelId: synthModelId };
      }
    }

    if (synthesisProvider) {
      const synthesisApiKey = resolveApiKey(
        synthesisProvider.name,
        synthesisProvider.apiType,
        req.apiKeys,
        req.authenticated
      );

      const synthesisInput = `## ユーザーの元のリクエスト:\n${req.input}\n\n## 各エージェントの作業結果:\n${successfulOutputs.join("\n\n")}`;

      emit({
        type: "synthesis_start",
        id: nextId(),
        role: finalRole,
        provider: synthesisProvider.displayName,
        model: synthesisProvider.modelId,
      });

      const synthStart = Date.now();
      const synthesisResult = await executeTaskStream(
        {
          provider: synthesisProvider,
          config: { apiKey: synthesisApiKey },
          input: synthesisInput,
          role: { slug: synthesisRoleSlug, name: synthesisRole?.name || finalRole },
          systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
        },
        (text) => emit({ type: "synthesis_chunk", id: nextId(), text })
      );

      const synthDurationMs = Date.now() - synthStart;
      synthesisOutput =
        synthesisResult.status === "success"
          ? synthesisResult.output
          : successfulOutputs.join("\n\n---\n\n");

      emit({
        type: "synthesis_done",
        id: nextId(),
        output: synthesisOutput,
        durationMs: synthDurationMs,
        role: finalRole,
        provider: synthesisProvider.displayName,
        model: synthesisProvider.modelId,
      });
    } else {
      // No synthesis provider assigned — fall back to concatenated outputs
      synthesisOutput = successfulOutputs.join("\n\n---\n\n");
    }
  }

  // 6b. Review step (T4) — Reviewer polishes the T3 synthesis into the user-visible result
  if (synthesisOutput) {
    const reviewRole = await prisma.role.findUnique({ where: { slug: "review" } });
    let reviewProvider: ProviderRecord | null = null;

    if (reviewRole) {
      const reviewAssignment = await prisma.roleAssignment.findFirst({
        where: { projectId: req.projectId, roleId: reviewRole.id },
        include: { provider: true },
        orderBy: { priority: "desc" },
      });
      if (reviewAssignment) {
        const revConfig = reviewAssignment.config ? JSON.parse(reviewAssignment.config) : {};
        const revModelId = await resolveModelId(revConfig, reviewAssignment.provider);
        reviewProvider = { ...reviewAssignment.provider, modelId: revModelId };
      }
    }

    if (reviewProvider) {
      const reviewApiKey = resolveApiKey(
        reviewProvider.name,
        reviewProvider.apiType,
        req.apiKeys,
        req.authenticated
      );

      const reviewInput = `## ユーザーの元のリクエスト:\n${req.input}\n\n## T3統合担当AIが生成した成果物(Code or Text):\n${synthesisOutput}`;

      emit({
        type: "review_start",
        id: nextId(),
        role: "review",
        provider: reviewProvider.displayName,
        model: reviewProvider.modelId,
      });

      const revStart = Date.now();
      const reviewResult = await executeTaskStream(
        {
          provider: reviewProvider,
          config: { apiKey: reviewApiKey },
          input: reviewInput,
          role: { slug: "review", name: reviewRole?.name || "Review" },
          systemPrompt: REVIEW_SYSTEM_PROMPT,
        },
        (text) => emit({ type: "review_chunk", id: nextId(), text })
      );

      const revDurationMs = Date.now() - revStart;
      finalOutput =
        reviewResult.status === "success" ? reviewResult.output : synthesisOutput;

      emit({
        type: "review_done",
        id: nextId(),
        output: finalOutput,
        durationMs: revDurationMs,
        role: "review",
        provider: reviewProvider.displayName,
        model: reviewProvider.modelId,
      });
    } else {
      // No reviewer provider assigned — synthesis output becomes the final
      finalOutput = synthesisOutput;
    }
  }

  // 7. Determine overall status & emit session_done with full results
  const allSuccess = filledResults.every((r) => r.status === "success");
  const allError = filledResults.every((r) => r.status === "error");
  const status = allSuccess ? "success" : allError ? "error" : "partial";
  const totalDurationMs = Date.now() - startTime;

  emit({
    type: "session_done",
    id: nextId(),
    sessionId,
    status,
    totalDurationMs,
    taskCount: subTasks.length,
    synthesisOutput,
    finalOutput,
    results: filledResults,
  });
}
