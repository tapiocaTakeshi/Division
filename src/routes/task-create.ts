import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";
import { executeTask } from "../services/ai-executor";
import { asyncHandler } from "../middleware/async-handler";
import { logger } from "../utils/logger";

export const taskCreateRouter = Router();

// --- Schemas ---

const createTasksSchema = z.object({
  projectId: z.string().min(1),
  input: z.string().min(1),
  apiKeys: z.record(z.string()).optional(),
  /** Chat history for context */
  chatHistory: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).optional(),
});

const updateTaskSchema = z.object({
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  output: z.string().optional(),
});

// --- Leader Prompt for Task Creation ---

const TASK_CREATION_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、具体的なタスクに分解してください。

利用可能なロール:
- search: ウェブ検索・情報収集
- deep-research: 徹底的な多角的調査・包括的分析・詳細レポート作成
- planning: 企画・設計・戦略立案
- coding: コード生成・デバッグ
- writing: 文章作成・ドキュメント
- review: レビュー・品質確認

ルール:
1. 各タスクには0始まりのインデックスが暗黙的に付与されます
2. 他のタスクの結果が必要な場合は "dependsOn" で依存先のインデックスを指定してください
3. 各タスクにはわかりやすいtitleとdescriptionを付けてください
4. titleは短く簡潔に（50文字以内）
5. descriptionはそのタスクで何をすべきか具体的に記述してください
6. 必ず以下のJSON形式のみで回答してください。説明文は不要です
7. タスクは最低5個以上生成してください。リクエストが複雑な場合は8〜15個程度に細分化してください
8. 1つのタスクに複数の作業を詰め込まず、できるだけ細かく分割してください
9. 調査・計画・実装・レビューなど各フェーズを独立したタスクにしてください
10. 同じロールでも異なる観点・対象であれば別タスクに分けてください

\`\`\`json
{
  "tasks": [
    {
      "role": "search",
      "title": "タスクのタイトル",
      "description": "具体的な作業内容の説明",
      "reason": "なぜこのタスクが必要か",
      "dependsOn": []
    }
  ]
}
\`\`\``;

// --- API Key Resolution (same logic as orchestrator) ---

const ENV_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const API_KEY_ALIASES: Record<string, string[]> = {
  anthropic: ["anthropic", "claude", "ANTHROPIC_API_KEY"],
  google: ["google", "gemini", "GOOGLE_API_KEY"],
  openai: ["openai", "gpt", "OPENAI_API_KEY"],
  perplexity: ["perplexity", "PERPLEXITY_API_KEY"],
  xai: ["xai", "grok", "XAI_API_KEY"],
  deepseek: ["deepseek", "DEEPSEEK_API_KEY"],
};

function resolveApiKey(
  providerName: string,
  apiType: string,
  apiKeys?: Record<string, string>
): string | undefined {
  const envVar = ENV_KEY_MAP[apiType];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }
  if (apiKeys) {
    if (apiKeys[providerName]) return apiKeys[providerName];
    const aliases = API_KEY_ALIASES[apiType] || [];
    for (const alias of aliases) {
      if (apiKeys[alias]) return apiKeys[alias];
    }
  }
  return undefined;
}

// --- JSON Extraction ---

function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text;
}

// --- Routes ---

/**
 * POST /api/tasks/create
 * Use Leader AI to decompose a user request into tasks and store them in DB
 */
taskCreateRouter.post(
  "/create",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createTasksSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { projectId, input, apiKeys, chatHistory } = parsed.data;

    // Verify project exists
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      res.status(404).json({ error: `Project not found: ${projectId}` });
      return;
    }

    // Find the Leader assignment
    const leaderRole = await prisma.role.findUnique({
      where: { slug: "leader" },
    });
    if (!leaderRole) {
      res
        .status(500)
        .json({ error: 'Role "leader" not found. Please run db:seed.' });
      return;
    }

    const leaderAssignment = await prisma.roleAssignment.findFirst({
      where: { projectId, roleId: leaderRole.id },
      include: { provider: true },
      orderBy: { priority: "desc" },
    });
    if (!leaderAssignment) {
      res.status(404).json({
        error:
          'No AI provider assigned to "leader" role in this project.',
        hint: "Use POST /api/assignments to assign a provider to the leader role",
      });
      return;
    }

    const leaderApiKey = resolveApiKey(
      leaderAssignment.provider.name,
      leaderAssignment.provider.apiType,
      apiKeys
    );

    // Call Leader AI to decompose the task
    const sessionId = crypto.randomUUID();
    logger.info(`[TaskCreate] Session ${sessionId} - Input: ${input}`);

    const leaderResult = await executeTask({
      provider: leaderAssignment.provider,
      config: { apiKey: leaderApiKey },
      input,
      role: { slug: "leader", name: "Leader" },
      systemPrompt: TASK_CREATION_PROMPT,
      chatHistory,
    });

    if (leaderResult.status === "error") {
      res.status(502).json({
        error: "Leader AI failed to generate tasks",
        errorMsg: leaderResult.errorMsg,
      });
      return;
    }

    // Parse Leader's response
    let parsedTasks: Array<{
      role: string;
      title: string;
      description: string;
      reason?: string;
      dependsOn?: number[];
    }>;

    try {
      const jsonStr = extractJson(leaderResult.output);
      const parsed = JSON.parse(jsonStr);
      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error("Leader response missing 'tasks' array");
      }
      parsedTasks = parsed.tasks.map(
        (t: Record<string, unknown>) => ({
          role: String(t.role || ""),
          title: String(t.title || ""),
          description: String(t.description || t.input || ""),
          reason: t.reason ? String(t.reason) : undefined,
          dependsOn: Array.isArray(t.dependsOn)
            ? (t.dependsOn.filter(
                (v: unknown) => typeof v === "number"
              ) as number[])
            : undefined,
        })
      );
    } catch (err) {
      res.status(502).json({
        error: "Failed to parse Leader AI response",
        errorMsg:
          err instanceof Error ? err.message : String(err),
        rawOutput: leaderResult.output,
      });
      return;
    }

    // Store tasks in database
    const createdTasks = await Promise.all(
      parsedTasks.map((task, index) =>
        prisma.task.create({
          data: {
            projectId,
            sessionId,
            role: task.role,
            title: task.title,
            description: task.description,
            reason: task.reason || null,
            dependsOn: task.dependsOn
              ? JSON.stringify(task.dependsOn)
              : null,
            orderIndex: index,
            status: "pending",
          },
        })
      )
    );

    logger.info(
      `[TaskCreate] Session ${sessionId} - Created ${createdTasks.length} tasks`
    );

    res.status(201).json({
      sessionId,
      projectId,
      input,
      leader: {
        provider: leaderAssignment.provider.displayName,
        model: leaderAssignment.provider.modelId,
      },
      taskCount: createdTasks.length,
      tasks: createdTasks.map((t) => ({
        ...t,
        dependsOn: t.dependsOn ? JSON.parse(t.dependsOn) : [],
      })),
    });
  })
);

/**
 * GET /api/tasks
 * List tasks, optionally filtered by projectId, sessionId, status
 */
taskCreateRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { projectId, sessionId, status, limit } = req.query;

    const where: Record<string, unknown> = {};
    if (projectId) where.projectId = String(projectId);
    if (sessionId) where.sessionId = String(sessionId);
    if (status) where.status = String(status);

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { orderIndex: "asc" }],
      take: limit ? parseInt(String(limit), 10) : 100,
    });

    res.json(
      tasks.map((t) => ({
        ...t,
        dependsOn: t.dependsOn ? JSON.parse(t.dependsOn) : [],
      }))
    );
  })
);

/**
 * GET /api/tasks/sessions
 * List task sessions grouped by sessionId
 */
taskCreateRouter.get(
  "/sessions",
  asyncHandler(async (req: Request, res: Response) => {
    const { projectId } = req.query;

    const where: Record<string, unknown> = {};
    if (projectId) where.projectId = String(projectId);

    const tasks = await prisma.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    // Group by sessionId
    const sessions = new Map<
      string,
      { sessionId: string; projectId: string; taskCount: number; tasks: typeof tasks; createdAt: Date }
    >();

    for (const task of tasks) {
      if (!sessions.has(task.sessionId)) {
        sessions.set(task.sessionId, {
          sessionId: task.sessionId,
          projectId: task.projectId,
          taskCount: 0,
          tasks: [],
          createdAt: task.createdAt,
        });
      }
      const session = sessions.get(task.sessionId)!;
      session.taskCount++;
      session.tasks.push(task);
    }

    res.json(
      Array.from(sessions.values()).map((s) => ({
        ...s,
        tasks: s.tasks.map((t) => ({
          ...t,
          dependsOn: t.dependsOn ? JSON.parse(t.dependsOn) : [],
        })),
      }))
    );
  })
);

/**
 * PATCH /api/tasks/:id
 * Update a task's status or output
 */
taskCreateRouter.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const parsed = updateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: `Task not found: ${id}` });
      return;
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.status !== undefined) data.status = parsed.data.status;
    if (parsed.data.output !== undefined) data.output = parsed.data.output;

    const updated = await prisma.task.update({
      where: { id },
      data,
    });

    res.json({
      ...updated,
      dependsOn: updated.dependsOn ? JSON.parse(updated.dependsOn) : [],
    });
  })
);

/**
 * DELETE /api/tasks/:id
 * Delete a task
 */
taskCreateRouter.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: `Task not found: ${id}` });
      return;
    }

    await prisma.task.delete({ where: { id } });
    res.json({ deleted: true, id });
  })
);
