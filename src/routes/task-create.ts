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
  /** Absolute path to user's workspace for file-search / coder tools */
  workspacePath: z.string().optional(),
});

const updateTaskSchema = z.object({
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  output: z.string().optional(),
});

// --- Leader Prompt for Task Creation ---

const TASK_CREATION_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下の5層パイプラインに基づいてタスクを分解してください。

## パイプライン構造（必ずこの順序で多層化する）

【Layer 1 — 調査・発想】並列実行（dependsOn: []）
- ideaman: 創造的ブレインストーミング・アイデア出し
- searcher: ウェブ検索・情報収集
- file-searcher: プロジェクト内ファイル検索・コード解析
- researcher: 調査・分析・レポート

【Layer 2 — 設計・デザイン】Layer 1に依存
- designer: UI/UXデザイン・HTML/CSS生成・プロトタイプ
- imager: 画像生成・ビジュアルコンテンツ
- planner: 企画・設計・アーキテクチャ

【Layer 3 — 実装・執筆】Layer 2に依存
- coder: コード生成・実装・デバッグ
- writer: 文章作成・ドキュメント

【Layer 4 — レビュー】Layer 3に依存
- reviewer: 品質確認・レビュー・改善提案

## ルール
1. 各タスクには0始まりのインデックスが付与されます
2. dependsOn で依存先インデックスを指定。空=並列実行
3. 各タスクにわかりやすいtitleとdescriptionを付ける
4. titleは短く簡潔に（50文字以内）
5. descriptionはそのタスクで何をすべきか具体的に記述
6. 必ず以下のJSON形式のみで回答。説明文は一切不要
7. タスクは最低5個以上。複雑な場合は8〜15個に細分化
8. 1タスクに複数作業を詰め込まず細かく分割
9. 同じロールでも異なる観点なら別タスクに分ける
10. **【必須】Layer 1 には次の4ロールを必ず1タスクずつ含めること（どれか1つでも欠けると不合格）: ideaman, searcher, file-searcher, researcher。デザインのみ・コード不要に見える依頼でも file-searcher を省略してはならない（既存のスタイル・HTML・設定ファイルの有無を調べる）。**
11. 各タスクに "mode" を指定:
    - "chat": テキスト生成タスク（デフォルト。searcher, researcher 等 Web検索ロールもこれ）
    - "computer_use": コード実行・テストが必要なタスク（coder ロール用）
    - "function_calling": 使用しない（廃止）
    ※ searcher / researcher ロールは Perplexity が Web 検索するため mode="chat" にすること

\`\`\`json
{
  "tasks": [
    { "role": "ideaman", "mode": "chat", "title": "アイデア提案", "description": "ユーザーのリクエストに対する革新的なアプローチを複数提案", "reason": "多角的な視点を得るため", "dependsOn": [] },
    { "role": "searcher", "mode": "chat", "title": "技術調査", "description": "技術的な実現可能性と最新のベストプラクティスを検索", "reason": "正確な前提知識を得るため", "dependsOn": [] },
    { "role": "file-searcher", "mode": "chat", "title": "既存コード調査", "description": "プロジェクト内の関連ファイルとコードを調査", "reason": "既存実装を把握するため", "dependsOn": [] },
    { "role": "researcher", "mode": "chat", "title": "技術トレンド調査", "description": "関連する技術トレンドと事例を調査", "reason": "深い理解を得るため", "dependsOn": [] },
    { "role": "designer", "mode": "chat", "title": "UIデザイン作成", "description": "調査結果を元にUIデザインとプロトタイプHTMLを作成", "reason": "ビジュアルを具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "planner", "mode": "chat", "title": "設計・要件定義", "description": "調査とアイデアを元に要件定義と設計を作成", "reason": "実装の方向性を決めるため", "dependsOn": [0, 1, 2, 3] },
    { "role": "coder", "mode": "computer_use", "title": "実装", "description": "設計とデザインに沿って実装", "reason": "動作するコードを生成するため", "dependsOn": [4, 5] },
    { "role": "reviewer", "mode": "chat", "title": "品質レビュー", "description": "実装結果の品質確認と改善提案", "reason": "品質保証のため", "dependsOn": [6] }
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
  apiKeys?: Record<string, string>,
  authenticated?: boolean
): string | undefined {
  if (authenticated) {
    const envVar = ENV_KEY_MAP[apiType];
    const raw = envVar ? process.env[envVar] : undefined;
    const fromEnv = raw?.trim();
    if (fromEnv) return fromEnv;
  }
  if (apiKeys) {
    const byName = apiKeys[providerName]?.trim();
    if (byName) return byName;
    const aliases = API_KEY_ALIASES[apiType] || [];
    for (const alias of aliases) {
      const v = apiKeys[alias]?.trim();
      if (v) return v;
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

type ParsedTaskRow = {
  role: string;
  mode: string;
  title: string;
  description: string;
  reason?: string;
  dependsOn?: number[];
};

/**
 * file-searcher を常にタスク配列の先頭に配置する。
 * - 欠けていれば先頭に挿入し、全タスクの dependsOn インデックスを +1 ずらす。
 * - 途中/末尾にある場合は先頭に移動し、dependsOn インデックスを補正する。
 */
function ensureFileSearcherTask(tasks: ParsedTaskRow[]): ParsedTaskRow[] {
  const fsIdx = tasks.findIndex(
    (t) => t.role === "file-searcher" || t.role === "file_searcher"
  );

  if (fsIdx === 0) return tasks;

  if (fsIdx < 0) {
    const inserted: ParsedTaskRow = {
      role: "file-searcher",
      mode: "chat",
      title: "既存コード・スタイルの調査",
      description:
        "プロジェクト内の既存UI、スタイル、テーマ、HTML/CSS、設定ファイルを検索し、リクエストに関連する実装や資産を把握する。",
      reason: "既存デザインとの整合と重複回避のため",
      dependsOn: [],
    };

    const shifted = tasks.map((t) => ({
      ...t,
      dependsOn: t.dependsOn?.map((d) => d + 1),
    }));

    return [inserted, ...shifted];
  }

  // fsIdx > 0: move the existing file-searcher task to the front.
  // Index remap: old fsIdx -> 0, old i (i<fsIdx) -> i+1, old i (i>fsIdx) -> i.
  const remap = (d: number): number => {
    if (d === fsIdx) return 0;
    if (d < fsIdx) return d + 1;
    return d;
  };

  const movedFs: ParsedTaskRow = {
    ...tasks[fsIdx],
    dependsOn: [],
  };

  const rest = tasks
    .filter((_, i) => i !== fsIdx)
    .map((t) => ({
      ...t,
      dependsOn: t.dependsOn?.map(remap),
    }));

  return [movedFs, ...rest];
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

    const { projectId, input, apiKeys, chatHistory, workspacePath } = parsed.data;

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

    const authenticated = !!res.locals.authenticated;
    const leaderApiKey = resolveApiKey(
      leaderAssignment.provider.name,
      leaderAssignment.provider.apiType,
      apiKeys,
      authenticated
    );

    // Call Leader AI to decompose the task
    const sessionId = crypto.randomUUID();
    logger.info(`[TaskCreate] Session ${sessionId} - Input: ${input}`);

    // Format chat history as a string to avoid persona drift in the model
    const formattedHistory = chatHistory && chatHistory.length > 0
      ? "【これまでの会話履歴】\n" + chatHistory.map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n\n') + "\n\n"
      : "";

    const workspaceHint = workspacePath
      ? `\n\n【実行環境】ローカルプロジェクトが開かれています（タスク実行時に workspacePath が渡されます）。Layer 1 に file-searcher を必ず含めてください。\n`
      : "";

    const enrichedInput = `${formattedHistory}【ユーザーの最新のリクエスト】\n${input}${workspaceHint}`;

    const savedConfig = leaderAssignment.config
      ? JSON.parse(leaderAssignment.config)
      : {};
    const leaderResult = await executeTask({
      provider: leaderAssignment.provider,
      config: { ...savedConfig, apiKey: leaderApiKey },
      input: enrichedInput,
      role: { slug: "leader", name: "Leader" },
      systemPrompt: TASK_CREATION_PROMPT,
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
      mode: string;
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
          mode: String(t.mode || "chat"),
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

      const beforeFs = parsedTasks.length;
      parsedTasks = ensureFileSearcherTask(parsedTasks);
      if (parsedTasks.length > beforeFs) {
        logger.info(
          `[TaskCreate] Session ${sessionId} - Injected missing file-searcher task; dependsOn indices shifted`
        );
      }
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
            mode: task.mode,
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
