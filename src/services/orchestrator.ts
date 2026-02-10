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

// --- Types ---

export interface SubTask {
  role: string;
  input: string;
  reason: string;
}

export interface SubTaskResult extends SubTask {
  provider: string;
  model: string;
  output: string;
  status: "success" | "error";
  errorMsg?: string;
  durationMs: number;
}

export interface OrchestratorRequest {
  projectId: string;
  input: string;
  apiKeys?: Record<string, string>;
  /** Override which provider handles each role, e.g. { coding: "gemini", search: "gpt" } */
  overrides?: Record<string, string>;
}

export interface OrchestratorResult {
  sessionId: string;
  input: string;
  leaderProvider: string;
  leaderModel: string;
  tasks: SubTaskResult[];
  totalDurationMs: number;
  status: "success" | "partial" | "error";
}

// --- Leader Prompt ---

const LEADER_SYSTEM_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下の専門ロールに分解してください。

利用可能なロール:
- search: ウェブ検索・情報収集（Perplexity担当）
- planning: 企画・設計・戦略立案（Gemini担当）
- coding: コード生成・デバッグ（Claude担当）
- writing: 文章作成・ドキュメント（Claude担当）
- review: レビュー・品質確認（GPT担当）

ルール:
1. タスクは実行順序で並べてください（前のタスクの結果が後のタスクに必要な場合）
2. 不要なロールは使わなくてOKです
3. 各タスクのinputは、そのロールのAIに直接渡す具体的な指示にしてください
4. 必ず以下のJSON形式のみで回答してください。説明文は不要です

\`\`\`json
{
  "tasks": [
    { "role": "search", "input": "具体的な検索指示", "reason": "なぜこのタスクが必要か" },
    { "role": "planning", "input": "具体的な企画指示", "reason": "なぜこのタスクが必要か" }
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
 * Priority: 1) environment variables (Vercel/production), 2) user-supplied apiKeys (request)
 */
function resolveApiKey(
  providerName: string,
  apiType: string,
  apiKeys?: Record<string, string>
): string | undefined {
  // 1. Check environment variables first (production / Vercel)
  const envVar = ENV_KEY_MAP[apiType];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
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
 */
export async function runAgent(
  req: OrchestratorRequest
): Promise<OrchestratorResult> {
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
    req.apiKeys
  );

  // 2. Ask Leader to decompose the task
  console.log(`\n[Agent] Session ${sessionId}`);
  console.log(`[Agent] Input: ${req.input}`);
  console.log(
    `[Agent] Leader: ${leaderAssignment.provider.displayName} (${leaderAssignment.provider.modelId})`
  );

  const leaderResult = await executeTask({
    provider: leaderAssignment.provider,
    config: { apiKey: leaderApiKey },
    input: req.input,
    role: { slug: "leader", name: "Leader" },
    systemPrompt: LEADER_SYSTEM_PROMPT,
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

  console.log(`[Agent] Leader decomposed into ${subTasks.length} tasks:`);
  subTasks.forEach((t, i) =>
    console.log(`  ${i + 1}. [${t.role}] ${t.input.substring(0, 60)}...`)
  );

  // 4. Execute each sub-task sequentially (passing previous context)
  const results: SubTaskResult[] = [];
  let previousContext = "";

  for (const task of subTasks) {
    // Find role
    const role = await prisma.role.findUnique({
      where: { slug: task.role },
    });
    if (!role) {
      results.push({
        ...task,
        provider: "unknown",
        model: "unknown",
        output: "",
        status: "error",
        errorMsg: `Role not found: ${task.role}`,
        durationMs: 0,
      });
      continue;
    }

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
      results.push({
        ...task,
        provider: "unassigned",
        model: "unassigned",
        output: "",
        status: "error",
        errorMsg: `No provider assigned to role "${task.role}"`,
        durationMs: 0,
      });
      continue;
    }

    // Build input with context from previous tasks
    let enrichedInput = task.input;
    if (previousContext) {
      enrichedInput = `## これまでの他のエージェントの作業結果:\n${previousContext}\n\n## あなたへの指示:\n${task.input}`;
    }

    const apiKey = resolveApiKey(provider.name, provider.apiType, req.apiKeys);

    console.log(
      `[Agent] Executing: [${task.role}] → ${provider.displayName}`
    );

    const result = await executeTask({
      provider,
      config: { apiKey },
      input: enrichedInput,
      role: { slug: role.slug, name: role.name },
    });

    const subResult: SubTaskResult = {
      ...task,
      provider: provider.displayName,
      model: provider.modelId,
      output: result.output,
      status: result.status,
      errorMsg: result.errorMsg,
      durationMs: result.durationMs,
    };

    results.push(subResult);

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

    // Add to context for next task
    if (result.status === "success" && result.output) {
      previousContext += `\n### ${role.name} (${provider.displayName}):\n${result.output}\n`;
    }
  }

  // 5. Determine overall status
  const allSuccess = results.every((r) => r.status === "success");
  const allError = results.every((r) => r.status === "error");
  const status = allSuccess ? "success" : allError ? "error" : "partial";

  const totalDurationMs = Date.now() - startTime;
  console.log(
    `[Agent] Session complete: ${status} (${totalDurationMs}ms, ${results.length} tasks)`
  );

  return {
    sessionId,
    input: req.input,
    leaderProvider: leaderAssignment.provider.displayName,
    leaderModel: leaderAssignment.provider.modelId,
    tasks: results,
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
  taskCount: number;
  tasks: Array<{ role: string; input: string; reason: string }>;
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
  index: number;
  role: string;
  text: string;
}
export interface StreamEventTaskDone {
  type: "task_done";
  id: string;
  index: number;
  role: string;
  provider: string;
  model: string;
  output: string;
  status: string;
  durationMs: number;
}
export interface StreamEventTaskError {
  type: "task_error";
  id: string;
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
  results: Array<{
    role: string;
    provider: string;
    model: string;
    output: string;
    status: string;
    durationMs: number;
  }>;
}
export interface StreamEventHeartbeat {
  type: "heartbeat";
  id: string;
  timestamp: number;
}

export type StreamEvent =
  | StreamEventSessionStart
  | StreamEventLeaderStart
  | StreamEventLeaderChunk
  | StreamEventLeaderDone
  | StreamEventLeaderError
  | StreamEventTaskStart
  | StreamEventTaskChunk
  | StreamEventTaskDone
  | StreamEventTaskError
  | StreamEventSessionDone
  | StreamEventHeartbeat;

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
    req.apiKeys
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

  emit({
    type: "leader_done",
    id: nextId(),
    taskCount: subTasks.length,
    tasks: subTasks.map((t) => ({ role: t.role, input: t.input, reason: t.reason })),
    rawOutput: leaderResult.output,
  });

  // 5. Execute each sub-task sequentially (streaming)
  let previousContext = "";
  const taskResults: Array<{
    role: string;
    provider: string;
    model: string;
    output: string;
    status: string;
    durationMs: number;
  }> = [];

  for (let i = 0; i < subTasks.length; i++) {
    const task = subTasks[i];

    // Find role
    const role = await prisma.role.findUnique({
      where: { slug: task.role },
    });
    if (!role) {
      emit({ type: "task_error", id: nextId(), index: i, role: task.role, error: `Role not found: ${task.role}` });
      taskResults.push({
        role: task.role,
        provider: "unknown",
        model: "unknown",
        output: "",
        status: "error",
        durationMs: 0,
      });
      continue;
    }

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
        index: i,
        role: task.role,
        error: `No provider assigned to role "${task.role}"`,
      });
      taskResults.push({
        role: task.role,
        provider: "unassigned",
        model: "unassigned",
        output: "",
        status: "error",
        durationMs: 0,
      });
      continue;
    }

    // Build enriched input
    let enrichedInput = task.input;
    if (previousContext) {
      enrichedInput = `## これまでの他のエージェントの作業結果:\n${previousContext}\n\n## あなたへの指示:\n${task.input}`;
    }

    const apiKey = resolveApiKey(provider.name, provider.apiType, req.apiKeys);

    emit({
      type: "task_start",
      id: nextId(),
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
      (text) => emit({ type: "task_chunk", id: nextId(), index: i, role: task.role, text })
    );

    if (result.status === "success") {
      emit({
        type: "task_done",
        id: nextId(),
        index: i,
        role: task.role,
        provider: provider.displayName,
        model: provider.modelId,
        output: result.output,
        status: "success",
        durationMs: result.durationMs,
      });
    } else {
      emit({
        type: "task_error",
        id: nextId(),
        index: i,
        role: task.role,
        error: result.errorMsg || "Execution failed",
      });
    }

    taskResults.push({
      role: task.role,
      provider: provider.displayName,
      model: provider.modelId,
      output: result.output,
      status: result.status,
      durationMs: result.durationMs,
    });

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

    // Add to context for next task
    if (result.status === "success" && result.output) {
      previousContext += `\n### ${role.name} (${provider.displayName}):\n${result.output}\n`;
    }
  }

  // 6. Determine overall status & emit session_done with full results
  const allSuccess = taskResults.every((r) => r.status === "success");
  const allError = taskResults.every((r) => r.status === "error");
  const status = allSuccess ? "success" : allError ? "error" : "partial";
  const totalDurationMs = Date.now() - startTime;

  emit({
    type: "session_done",
    id: nextId(),
    sessionId,
    status,
    totalDurationMs,
    taskCount: subTasks.length,
    results: taskResults,
  });
}

