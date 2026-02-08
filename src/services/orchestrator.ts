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
import { executeTask, ExecutionResult } from "./ai-executor";

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

/**
 * Resolve the API key for a given provider
 */
function resolveApiKey(
  providerName: string,
  apiKeys?: Record<string, string>
): string | undefined {
  if (!apiKeys) return undefined;

  // Direct match
  if (apiKeys[providerName]) return apiKeys[providerName];

  // Map model-level names to API key aliases
  const keyMap: Record<string, string[]> = {
    // Anthropic models
    "claude-sonnet": ["anthropic", "claude", "ANTHROPIC_API_KEY"],
    "claude-haiku": ["anthropic", "claude", "ANTHROPIC_API_KEY"],
    "claude-opus": ["anthropic", "claude", "ANTHROPIC_API_KEY"],
    claude: ["anthropic", "claude", "ANTHROPIC_API_KEY"],
    // Google models
    "gemini-flash": ["google", "gemini", "GOOGLE_API_KEY"],
    "gemini-pro": ["google", "gemini", "GOOGLE_API_KEY"],
    gemini: ["google", "gemini", "GOOGLE_API_KEY"],
    // Perplexity models
    "perplexity-sonar": ["perplexity", "PERPLEXITY_API_KEY"],
    "perplexity-sonar-pro": ["perplexity", "PERPLEXITY_API_KEY"],
    perplexity: ["perplexity", "PERPLEXITY_API_KEY"],
    // OpenAI models
    "gpt-4o": ["openai", "gpt", "OPENAI_API_KEY"],
    "gpt-4o-mini": ["openai", "gpt", "OPENAI_API_KEY"],
    o3: ["openai", "gpt", "OPENAI_API_KEY"],
    "o3-mini": ["openai", "gpt", "OPENAI_API_KEY"],
    gpt: ["openai", "gpt", "OPENAI_API_KEY"],
  };

  const aliases = keyMap[providerName] || [];
  for (const alias of aliases) {
    if (apiKeys[alias]) return apiKeys[alias];
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
    // In dry-run mode, the output is a JSON string containing the request info
    const outputData = JSON.parse(leaderResult.output);
    if (outputData.dryRun) {
      // Dry-run: simulate a task decomposition
      subTasks = simulateLeaderDecomposition(req.input);
      console.log(`[Agent] Dry-run mode: simulated ${subTasks.length} tasks`);
    } else {
      subTasks = parseLeaderResponse(leaderResult.output);
    }
  } catch {
    // If it's not JSON (real API response), try parsing directly
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
    let provider: { id: string; name: string; displayName: string; apiBaseUrl: string; apiType: string; modelId: string; isEnabled: boolean } | null = null;

    const overrideProviderName = req.overrides?.[task.role];
    if (overrideProviderName) {
      // User specified a provider override for this role
      const overrideProvider = await prisma.provider.findUnique({
        where: { name: overrideProviderName },
      });
      if (overrideProvider) {
        provider = overrideProvider;
      }
    }

    if (!provider) {
      // Fall back to DB assignment
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

    const apiKey = resolveApiKey(provider.name, req.apiKeys);

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

/**
 * Simulate Leader decomposition for dry-run mode
 */
function simulateLeaderDecomposition(input: string): SubTask[] {
  // Simple keyword-based simulation
  const tasks: SubTask[] = [];
  const lowerInput = input.toLowerCase();

  // Always start with search for context
  tasks.push({
    role: "search",
    input: `${input}に関する最新の情報やベストプラクティスを調べてください`,
    reason: "最新情報の収集",
  });

  // Planning if it sounds like a project
  if (
    lowerInput.includes("作") ||
    lowerInput.includes("開発") ||
    lowerInput.includes("設計") ||
    lowerInput.includes("アプリ") ||
    lowerInput.includes("システム") ||
    lowerInput.includes("build") ||
    lowerInput.includes("create") ||
    lowerInput.includes("develop")
  ) {
    tasks.push({
      role: "planning",
      input: `「${input}」のプロジェクト計画とアーキテクチャを設計してください`,
      reason: "設計方針の策定",
    });
  }

  // Coding if it involves code
  if (
    lowerInput.includes("コード") ||
    lowerInput.includes("実装") ||
    lowerInput.includes("作") ||
    lowerInput.includes("開発") ||
    lowerInput.includes("code") ||
    lowerInput.includes("implement") ||
    lowerInput.includes("build") ||
    lowerInput.includes("アプリ")
  ) {
    tasks.push({
      role: "coding",
      input: `${input}`,
      reason: "コード生成",
    });
  }

  // Writing if it involves documentation
  if (
    lowerInput.includes("ドキュメント") ||
    lowerInput.includes("文章") ||
    lowerInput.includes("記事") ||
    lowerInput.includes("書") ||
    lowerInput.includes("write") ||
    lowerInput.includes("document")
  ) {
    tasks.push({
      role: "writing",
      input: `${input}`,
      reason: "文章作成",
    });
  }

  // Always end with review
  tasks.push({
    role: "review",
    input: `前のエージェントたちの作業結果をレビューし、改善点や問題点を指摘してください`,
    reason: "品質確認",
  });

  return tasks;
}
