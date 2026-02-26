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

// --- Types ---

export interface SubTask {
  role: string;
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
}

export interface OrchestratorResult {
  sessionId: string;
  input: string;
  leaderProvider: string;
  leaderModel: string;
  tasks: SubTaskResult[];
  finalOutput?: string;
  finalCode?: string;
  totalDurationMs: number;
  status: "success" | "partial" | "error";
}

// --- Leader Prompt ---

const LEADER_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下の専門ロールに分解してください。

利用可能なロール:
- search: ウェブ検索・情報収集（Perplexity担当）
- deep-research: 徹底的な多角的調査・包括的分析・詳細レポート作成（Perplexity Deep Research担当）
- planning: 企画・設計・戦略立案（Gemini担当）
- coding: コード生成・デバッグ（Claude担当）
- writing: 文章作成・ドキュメント（Claude担当）
- review: レビュー・品質確認（GPT担当）
- image: 画像生成・ビジュアルコンテンツ作成・イラスト（GPT Image担当）
- ideaman: 創造的なアイディア出し・ブレインストーミング・革新的コンセプト生成（Claude担当）

ルール:
1. 各タスクには0始まりのインデックスが暗黙的に付与されます（最初のタスクが0、次が1...）
2. 他のタスクの結果が必要な場合は "dependsOn" で依存先のインデックスを指定してください
3. dependsOnが空または省略されたタスクは他のタスクと並列実行されます
4. 不要なロールは使わなくてOKです
5. 各タスクのinputは、そのロールのAIに直接渡す具体的な指示にしてください
6. 必ず以下のJSON形式のみで回答してください。説明文は不要です
7. タスクは最低5個以上生成してください。リクエストが複雑な場合は8〜15個程度に細分化してください
8. 1つのタスクに複数の作業を詰め込まず、できるだけ細かく分割してください
9. 調査・計画・実装・レビューなど各フェーズを独立したタスクにしてください
10. 同じロールでも異なる観点・対象であれば別タスクに分けてください

\`\`\`json
{
  "tasks": [
    { "role": "search", "input": "具体的な検索指示", "reason": "なぜこのタスクが必要か" },
    { "role": "planning", "input": "具体的な企画指示", "reason": "なぜこのタスクが必要か", "dependsOn": [0] }
  ]
}
\`\`\``;

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
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  return text;
}

/**
 * Parse the Leader's response into sub-tasks
 */
function parseLeaderResponse(output: string): SubTask[] {
  try {
    const jsonStr = extractJson(output);
    const parsed = JSON.parse(jsonStr);

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error("Leader response missing 'tasks' array");
    }

    return parsed.tasks.map((t: Record<string, unknown>) => ({
      role: String(t.role || ""),
      input: String(t.input || ""),
      reason: String(t.reason || ""),
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((v: unknown) => typeof v === "number") as number[] : undefined,
    }));
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

  const leaderApiKey = resolveApiKey(
    leaderAssignment.provider.name,
    leaderAssignment.provider.apiType,
    req.apiKeys,
    req.authenticated
  );

  // 2. Ask Leader to decompose the task
  log(`[Agent] Session ${sessionId}`);
  log(`[Agent] Input: ${req.input}`);
  log(`[Agent] Leader: ${leaderAssignment.provider.displayName} (${leaderAssignment.provider.modelId})`);
  logger.info(`[Agent] Starting session`, { sessionId, projectId: req.projectId });

  const leaderResult = await executeTask({
    provider: leaderAssignment.provider,
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
      leaderProvider: leaderAssignment.provider.displayName,
      leaderModel: leaderAssignment.provider.modelId,
      tasks: [],
      totalDurationMs: Date.now() - startTime,
      status: "error",
    };
  }

  // 3. Parse Leader's task breakdown
  let subTasks: SubTask[];
  try {
    subTasks = parseLeaderResponse(leaderResult.output);
  } catch (parseErr) {
    return {
      sessionId,
      input: req.input,
      leaderProvider: leaderAssignment.provider.displayName,
      leaderModel: leaderAssignment.provider.modelId,
      tasks: [
        {
          role: "leader",
          input: req.input,
          reason: "Task decomposition failed",
          provider: leaderAssignment.provider.displayName,
          model: leaderAssignment.provider.modelId,
          output: leaderResult.output,
          status: "error",
          errorMsg:
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          durationMs: leaderResult.durationMs,
        },
      ],
      totalDurationMs: Date.now() - startTime,
      status: "error",
    };
  }

  log(`[Agent] Leader decomposed into ${subTasks.length} tasks:`);
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
        provider = assignment.provider;
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

  // 5. Determine overall status
  const filledResults = results.filter(Boolean);
  const allSuccess = filledResults.every((r) => r.status === "success");
  const allError = filledResults.every((r) => r.status === "error");
  const status = allSuccess ? "success" : allError ? "error" : "partial";

  const totalDurationMs = Date.now() - startTime;
  log(`[Agent] Session complete: ${status} (${totalDurationMs}ms, ${filledResults.length} tasks)`);
  logger.info(
    `[Agent] Session complete: ${status} (${totalDurationMs}ms, ${filledResults.length} tasks)`,
    { sessionId, status, totalDurationMs }
  );

  const finalOutput = results.length > 0 ? results[results.length - 1].output : undefined;
  const codingTask = [...results].reverse().find(r => r.role === 'coding');
  const finalCode = codingTask ? codingTask.output : undefined;

  return {
    sessionId,
    input: req.input,
    leaderProvider: leaderAssignment.provider.displayName,
    leaderModel: leaderAssignment.provider.modelId,
    tasks: filledResults,
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
  | StreamEventWaveDone;

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
    leader: leaderAssignment.provider.displayName,
  });

  emit({
    type: "leader_start",
    id: nextId(),
    provider: leaderAssignment.provider.displayName,
    model: leaderAssignment.provider.modelId,
  });

  // 3. Ask Leader to decompose (streaming)
  const leaderResult = await executeTaskStream(
    {
      provider: leaderAssignment.provider,
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
  try {
    subTasks = parseLeaderResponse(leaderResult.output);
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

  emit({
    type: "leader_done",
    id: nextId(),
    output: leaderResult.output,
    taskCount: subTasks.length,
    tasks: subTasks.map((t, idx) => ({
      id: taskIdOf(idx),
      role: t.role,
      title: t.input,
      reason: t.reason,
      dependsOn: (t.dependsOn || []).map((d) => taskIdOf(d)),
    })),
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
        provider = assignment.provider;
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
    });

    const result = await executeTaskStream(
      {
        provider,
        config: { apiKey },
        input: enrichedInput,
        role: { slug: role.slug, name: role.name },
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

  // 6. Determine overall status & emit session_done with full results
  const filledResults = taskResults.filter(Boolean);
  const allSuccess = filledResults.every((r) => r.status === "success");
  const allError = filledResults.every((r) => r.status === "error");
  const status = allSuccess ? "success" : allError ? "error" : "partial";
  const totalDurationMs = Date.now() - startTime;

  // Pick the last successful output as the final output
  const lastSuccessResult = [...filledResults].reverse().find((r) => r.status === "success");
  const finalOutput = lastSuccessResult?.output;

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
