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
import { executeTask, executeTaskStream, executeCoderLoop } from "./ai-executor";
import type { ChatMessage } from "./ai-executor";
import { logger } from "../utils/logger";
import { recordUsage, estimateTokens } from "./credits";

/** Provider shape used throughout the orchestrator (apiEndpoint is optional for Prisma compat) */
interface OrchestratorProvider {
  id: string;
  name: string;
  displayName: string;
  apiBaseUrl: string;
  apiType: string;
  apiEndpoint?: string;
  modelId: string;
  isEnabled: boolean;
}

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
// High-output roles (designer, coder, writer) keep large limits.
// Other roles get reduced output to leave more room for input context.
const ROLE_MAX_TOKENS: Record<string, number> = {
  designer: 32768,
  coder: 32768,
  writer: 16384,
  planner: 16384,
  reviewer: 16384,
  searcher: 8192,
  researcher: 16384,
  filesearcher: 8192,
  ideaman: 16384,
};

// --- Synthesis Max Tokens (used when coder/writer is the final synthesizer) ---
// Regular task invocations use ROLE_MAX_TOKENS (reduced). When coder or writer
// acts as the synthesizer, they get a larger window so they can fully
// incorporate every upstream agent output into the final answer.
const ROLE_SYNTHESIS_MAX_TOKENS: Record<string, number> = {
  coder: 65536,
  writer: 65536,
};

// --- Role-Specific System Prompts ---
const ROLE_SYSTEM_PROMPTS: Record<string, string> = {
  designer: `あなたは優秀なUIデザイナー兼フロントエンドエンジニアです。
リクエストに基づいて、**完全に自己完結した単一のHTMLファイル**を生成してください。

ルール:
1. 出力は <!DOCTYPE html> から </html> まで、完全なHTMLドキュメントにしてください
2. CSSは <style> タグ内にインラインで記述してください（外部ファイル参照禁止）
3. JavaScriptは <script> タグ内にインラインで記述してください（外部ファイル参照禁止）
4. モダンで美しいデザインにしてください（グラデーション、シャドウ、アニメーション等を活用）
5. レスポンシブデザイン対応にしてください
6. 必ず \`\`\`html で囲んで出力してください
7. 外部CDN（Google Fonts, Font Awesome, Tailwind CDN等）は使用して構いません
8. インタラクティブな要素（ホバー効果、クリックイベント等）を積極的に入れてください
9. ダークモード対応も考慮してください
10. HTMLの前後に説明テキストを入れず、HTMLコードブロックのみを出力してください`,
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

const LEADER_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下の5層パイプラインに基づいてタスクを分解してください。

## パイプライン構造（必ずこの順序で多層化する）

【Layer 1 — 調査・発想】並列実行（dependsOn: []）
- ideaman: 創造的ブレインストーミング・アイデア出し・革新的コンセプト提案（Claude担当）
- searcher: ウェブ検索・情報収集（Perplexity担当）
- file-searcher: プロジェクト内ファイル検索・コード解析・既存コード理解（GPT担当）
- researcher: 調査・分析・レポート（Perplexity Deep Research担当）

【Layer 2 — 設計・デザイン】Layer 1に依存（dependsOn で Layer 1 のタスクを参照）
- designer: UI/UXデザイン・HTML/CSS生成・ランディングページ・プロトタイプ（Gemini担当。完全に自己完結したHTMLを生成）
- imager: 画像生成・ビジュアルコンテンツ・イラスト（GPT Image担当）
- planner: 企画・設計・アーキテクチャ・戦略立案（Gemini担当）

【Layer 3 — 実装・執筆】Layer 2に依存
- coder: コード生成・実装・デバッグ（Claude担当）
- writer: 文章作成・ドキュメント（Claude担当）

【Layer 4 — レビュー】Layer 3に依存
- reviewer: 品質確認・レビュー・改善提案（GPT担当）

【最終統合】reviewer 完了後に自動実行（tasksに含めない）

## 利用可能なロール一覧
ideaman, searcher, file-searcher, researcher, designer, imager, planner, coder, writer, reviewer

## ルール
1. 各タスクには0始まりのインデックスが付与されます（0, 1, 2...）
2. dependsOn で依存先のインデックスを指定。空=並列実行
3. 不要なロールは使わなくてOK。リクエストに応じて適切に選択
4. 各タスクのinputはそのロールのAIに直接渡す具体的な指示にすること
5. 必ず以下のJSON形式のみで回答。挨拶や説明文は【絶対に】出力しない
6. タスクは最低5個以上。複雑な場合は8〜15個に細分化
7. 1タスクに複数作業を詰め込まず細かく分割
8. 同じロールでも異なる観点なら別タスクに分ける
9. 各タスクに "mode" を指定:
   - "chat": テキスト生成タスク（デフォルト。searcher, researcher 等 Web検索ロールもこれ）
   - "computer_use": コード実行・テストが必要なタスク（coder ロール用）
   - "function_calling": ローカルファイル検索のみ（file-searcher ロール専用）
   ※ searcher / researcher ロールは Perplexity が Web 検索するため mode="chat" にすること
10. "finalRole" を必ず指定:
    - "coder": コードが主な成果物の場合
    - "writer": ドキュメント・文章が主な成果物の場合

\`\`\`json
{
  "tasks": [
    { "role": "ideaman", "mode": "chat", "input": "ユーザーのリクエストに対する革新的なアプローチを複数提案", "reason": "多角的な視点を得るため" },
    { "role": "searcher", "mode": "chat", "input": "技術的な実現可能性と最新のベストプラクティスを検索", "reason": "正確な前提知識を得るため" },
    { "role": "file-searcher", "mode": "function_calling", "input": "プロジェクト内の関連ファイルとコードを調査", "reason": "既存実装の把握のため" },
    { "role": "researcher", "mode": "chat", "input": "関連する技術トレンドと事例を調査", "reason": "深い理解を得るため" },
    { "role": "designer", "mode": "chat", "input": "調査結果を元にUIデザインとプロトタイプHTMLを作成", "reason": "ビジュアルイメージを具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "planner", "mode": "chat", "input": "調査とアイデアを元に要件定義と設計を作成", "reason": "実装の方向性を決めるため", "dependsOn": [0, 1, 2, 3] },
    { "role": "coder", "mode": "computer_use", "input": "設計とデザインに沿って実装", "reason": "動作するコードを生成するため", "dependsOn": [4, 5] },
    { "role": "reviewer", "mode": "chat", "input": "実装結果の品質確認と改善提案", "reason": "品質保証のため", "dependsOn": [6] }
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
  const leaderConfig = leaderAssignment.config ? JSON.parse(leaderAssignment.config) : {};
  const leaderModelId = (leaderConfig.model as string) || leaderAssignment.provider.modelId;
  const leaderProvider: OrchestratorProvider = { ...leaderAssignment.provider, modelId: leaderModelId };

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
    let provider: OrchestratorProvider | null = null;

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
        const taskConfig = assignment.config ? JSON.parse(assignment.config) : {};
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

    const roleSystemPrompt = ROLE_SYSTEM_PROMPTS[task.role];
    const roleMaxTokens = ROLE_MAX_TOKENS[task.role];
    const isCoderRole = task.role === "coder" || task.mode === "computer_use";

    const result = isCoderRole
      ? await executeCoderLoop(
          {
            provider,
            config: { apiKey, ...(roleMaxTokens ? { maxTokens: roleMaxTokens } : {}) },
            input: enrichedInput,
            role: { slug: role.slug, name: role.name },
            mode: task.mode,
            ...(roleSystemPrompt ? { systemPrompt: roleSystemPrompt } : {}),
          },
          (msg) => log(`  [coder] ${msg.trim()}`)
        )
      : await executeTask({
          provider,
          config: { apiKey, ...(roleMaxTokens ? { maxTokens: roleMaxTokens } : {}) },
          input: enrichedInput,
          role: { slug: role.slug, name: role.name },
          mode: task.mode,
          ...(roleSystemPrompt ? { systemPrompt: roleSystemPrompt } : {}),
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

    let synthesisProvider: OrchestratorProvider | null = null;
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
        const synthConfig = synthesisAssignment.config ? JSON.parse(synthesisAssignment.config) : {};
        const synthModelId = (synthConfig.model as string) || synthesisAssignment.provider.modelId;
        synthesisProvider = { ...synthesisAssignment.provider, modelId: synthModelId };
      }
    }

    if (!synthesisProvider) {
      synthesisProvider = leaderProvider;
      logger.warn(`[Synthesis] No provider for "${synthesisRoleSlug}", falling back to leader: ${leaderProvider.displayName}`);
    }

    const synthesisApiKey = resolveApiKey(synthesisProvider.name, synthesisProvider.apiType, req.apiKeys, req.authenticated);
    const synthesisInput = `## ユーザーの元のリクエスト:\n${req.input}\n\n## 各エージェントの作業結果:\n${successfulOutputs.join("\n\n")}`;

    log(`[Agent] Synthesis step: ${finalRole} → ${synthesisProvider.displayName}`);
    const synthesisMaxTokens = ROLE_SYNTHESIS_MAX_TOKENS[synthesisRoleSlug];
    const synthesisResult = await executeTask({
      provider: synthesisProvider,
      config: { apiKey: synthesisApiKey, ...(synthesisMaxTokens ? { maxTokens: synthesisMaxTokens } : {}) },
      input: synthesisInput,
      role: { slug: synthesisRoleSlug, name: synthesisRole?.name || finalRole },
      systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
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
  const leaderConfig = leaderAssignment.config ? JSON.parse(leaderAssignment.config) : {};
  const leaderModelId = (leaderConfig.model as string) || leaderAssignment.provider.modelId;
  const leaderProvider: OrchestratorProvider = { ...leaderAssignment.provider, modelId: leaderModelId };

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
    previewUrl?: string;
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
    let provider: OrchestratorProvider | null = null;

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
        const taskConfig = assignment.config ? JSON.parse(assignment.config) : {};
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

    const roleSystemPrompt = ROLE_SYSTEM_PROMPTS[task.role];
    const roleMaxTokens = ROLE_MAX_TOKENS[task.role];
    const isCoderRole = task.role === "coder" || task.mode === "computer_use";

    const result = isCoderRole
      ? await executeCoderLoop(
          {
            provider,
            config: { apiKey, ...(roleMaxTokens ? { maxTokens: roleMaxTokens } : {}) },
            input: enrichedInput,
            role: { slug: role.slug, name: role.name },
            mode: task.mode,
            ...(roleSystemPrompt ? { systemPrompt: roleSystemPrompt } : {}),
          },
          (msg) => emit({ type: "task_chunk", id: nextId(), taskId: taskIdOf(i), index: i, role: task.role, text: msg })
        )
      : await executeTaskStream(
          {
            provider,
            config: { apiKey, ...(roleMaxTokens ? { maxTokens: roleMaxTokens } : {}) },
            input: enrichedInput,
            role: { slug: role.slug, name: role.name },
            mode: task.mode,
            ...(roleSystemPrompt ? { systemPrompt: roleSystemPrompt } : {}),
          },
          (text) => emit({ type: "task_chunk", id: nextId(), taskId: taskIdOf(i), index: i, role: task.role, text }),
          (text) => emit({ type: "task_thinking_chunk", id: nextId(), taskId: taskIdOf(i), index: i, role: task.role, text })
        );

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

    // Record usage & cost (webhook fires async)
    if (result.status === "success") {
      const inputTokens = Math.ceil(enrichedInput.length / 3);
      const outputTokens = Math.ceil((result.output || "").length / 3);
      recordUsage({
        userId: req.userId,
        projectId: req.projectId,
        sessionId,
        providerId: provider.id,
        modelId: provider.modelId,
        role: task.role,
        inputTokens,
        outputTokens,
      }).catch(() => {});
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

    let synthesisProvider: OrchestratorProvider | null = null;

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
        const synthConfig = synthesisAssignment.config ? JSON.parse(synthesisAssignment.config) : {};
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

    const synthesisInput = `## ユーザーの元のリクエスト:\n${req.input}\n\n## 各エージェントの作業結果:\n${successfulOutputs.join("\n\n")}`;

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
        systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
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
    finalOutput,
    results: filledResults,
  });
}
