import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";
import { executeTask } from "../services/ai-executor";
import { asyncHandler } from "../middleware/async-handler";
import { logger } from "../utils/logger";
import { normalizeChatHistory } from "../utils/normalize-chat-history";

export const taskCreateRouter = Router();

/**
 * RoleAssignment.config は JSON `{"model":"..."}` を前提に書かれているが、
 * 実データにはモデル ID をそのまま保存したプレーン文字列（例: `"gpt-5.4"`）も混在する。
 * JSON として解釈できない場合はモデル名とみなして `{ model: value }` を返し、
 * leader が常に 500 で落ちるのを防ぐ。
 */
function parseAssignmentConfigSafe(raw: string | null | undefined): Record<string, unknown> {
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
      /* fall through */
    }
  }
  return { model: text };
}

// --- Schemas ---

const createTasksSchema = z.object({
  projectId: z.string().min(1),
  input: z.string().min(1),
  apiKeys: z.record(z.string()).optional(),
  /**
   * Chat history for context.
   * OpenAI 互換の `system` / `tool` / `function` / `developer` ロールも受け付け、
   * サーバ側で `user` / `assistant` に正規化する（情報は本文にプレフィックスで残す）。
   */
  chatHistory: z.array(z.object({
    role: z.string(),
    content: z.string(),
    name: z.string().optional().nullable(),
    tool_call_id: z.string().optional().nullable(),
  })).optional(),
  /** Absolute path to user's workspace for file-search / coder tools */
  workspacePath: z.string().optional(),
  /** IDE/CLI 連携: ローカルで収集したスナップショット */
  localWorkspaceContext: z.string().optional(),
});

const updateTaskSchema = z.object({
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  output: z.string().optional(),
});

// --- Leader Prompt for Task Creation ---

const TASK_CREATION_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下のフローに基づいてタスクを分解してください。

## パイプライン構造（必ずこの順序で多層化する）

【Layer 1 — 調査・発想・既存コード把握】並列実行（dependsOn: []）
- ideaman: 創造的ブレインストーミング・アイデア出し
- searcher: ウェブ検索・情報収集
- researcher: 調査・分析・レポート
- file-searcher: プロジェクト内の **すべてのフォルダ・ファイル** を最初から読み込み、構造・既存実装・変更候補・注意点を Markdown レポートにまとめる

【Leader Design Brief】Layer 1 → Layer 2 のハンドオフで Leader が自動挿入（tasksには含めない）
- Leader は ideaman / searcher / researcher / file-searcher の Markdown を統合し、designer / imager / planner に渡す Design Brief Markdown を生成する

【Layer 2 — 設計・デザイン】Layer 1 のすべての Markdown 出力に依存
- designer: UI/UXデザイン・HTML/CSS生成・プロトタイプ
- imager: 画像生成・ビジュアルコンテンツ
- planner: 企画・設計・アーキテクチャ

【Layer 3 — Leader Todos】Layer 2 の Markdown 出力を Leader が再統合（tasksには含めない）
- Leader は file-searcher / designer / imager / planner の Markdown を受け取り、Coder/Writer に渡す具体的な Todos Markdown を自動生成する

【Layer 4 — 実装・執筆】Layer 2（および Leader Todos）に依存
- coder: コード生成・実装・デバッグ
- writer: 文章作成・ドキュメント

【Leader Review Brief】Layer 4 → Layer 5 のハンドオフで Leader が自動挿入（tasksには含めない）
- Leader は coder / writer の出力を受け、Reviewer が短時間で評価できる Review Brief を生成する

【Layer 5 — レビュー】Layer 4に依存
- reviewer: 品質確認・レビュー・改善提案（dependsOn にレビュー対象の coder または writer の index を必ず含める）

オーケストラ実行時: reviewer が Not OK の場合、reviewer → Leader Todos → file-searcher → coder/writer → Leader Review Brief → reviewer を reviewer が OK を出すまで（最大20周。REVIEWER_CODER_MAX_ROUNDS で変更可）ループします。プランに追加タスクは不要です。

## ルール
1. 各タスクには0始まりのインデックスが付与されます
2. dependsOn で依存先インデックスを指定。空=並列実行
3. 各タスクにわかりやすいtitleとdescriptionを付ける
4. titleは短く簡潔に（50文字以内）
5. descriptionはそのタスクで何をすべきか具体的に記述。file-searcher の description は「プロジェクト内のすべてのフォルダ・ファイルを読み込んで構造を把握する」ことを必ず含めること
6. 必ず以下のJSON形式のみで回答。説明文は一切不要
7. タスクは最低5個以上。複雑な場合は8〜15個に細分化
8. 1タスクに複数作業を詰め込まず細かく分割
9. 同じロールでも異なる観点なら別タスクに分ける
10. **【必須】Layer 1 には ideaman, searcher, researcher, file-searcher を必ず1タスクずつ含め、すべて dependsOn: [] で並列実行すること。Layer 2 には designer, imager, planner を必ず1タスクずつ含め、Layer 1 のすべての index に依存させること。Leader Design Brief / Leader Todos / Leader Review Brief はオーケストラが自動生成するため tasks には含めないこと。**
11. 各タスクに "mode" を指定:
    - "chat": テキスト生成タスク（デフォルト。searcher, researcher, file-searcher 等もこれ）
    - "computer_use": コード実行・テストが必要なタスク（coder ロール用）
    - "function_calling": 使用しない（廃止）
    ※ searcher / researcher ロールは Perplexity が Web 検索するため mode="chat" にすること

\`\`\`json
{
  "tasks": [
    { "role": "ideaman", "mode": "chat", "title": "アイデア提案", "description": "ユーザーのリクエストに対する革新的なアプローチを複数提案", "reason": "多角的な視点を得るため", "dependsOn": [] },
    { "role": "searcher", "mode": "chat", "title": "技術調査", "description": "技術的な実現可能性と最新のベストプラクティスを検索", "reason": "正確な前提知識を得るため", "dependsOn": [] },
    { "role": "researcher", "mode": "chat", "title": "技術トレンド調査", "description": "関連する技術トレンドと事例を調査", "reason": "深い理解を得るため", "dependsOn": [] },
    { "role": "file-searcher", "mode": "chat", "title": "プロジェクト全体スキャン", "description": "プロジェクト内のすべてのフォルダ・ファイルを読み込み、構造・既存実装・変更候補・注意点を Markdown レポートにまとめる", "reason": "サーチ／リサーチと同じタイミングで既存コードベース全体を把握するため", "dependsOn": [] },
    { "role": "designer", "mode": "chat", "title": "UIデザイン作成", "description": "調査・既存コードを元にUIデザインとプロトタイプHTMLを作成", "reason": "ビジュアルを具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "imager", "mode": "chat", "title": "画像・ビジュアル作成", "description": "調査・デザイン方針を元に画像/ビジュアル案を作成", "reason": "視覚要素を具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "planner", "mode": "chat", "title": "設計・要件定義", "description": "調査・既存コードを元に要件定義と設計を作成", "reason": "実装の方向性を決めるため", "dependsOn": [0, 1, 2, 3] },
    { "role": "coder", "mode": "computer_use", "title": "実装", "description": "Layer 1〜2 の調査・設計に沿って実装", "reason": "動作するコードを生成するため", "dependsOn": [4, 5, 6] },
    { "role": "reviewer", "mode": "chat", "title": "品質レビュー", "description": "実装結果の品質確認と改善提案。OK/Not OK を明示する", "reason": "品質保証のため", "dependsOn": [7] }
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

function normalizeTaskRole(role: string): string {
  return role === "file_searcher" ? "file-searcher" : role;
}

function isImplementationTaskRow(t: ParsedTaskRow): boolean {
  const role = normalizeTaskRole(t.role);
  return role === "coder" || role === "writer" || t.mode === "computer_use";
}

function getTaskFlowGroup(task: ParsedTaskRow): number {
  const role = normalizeTaskRole(task.role);
  if (
    role === "ideaman" ||
    role === "searcher" ||
    role === "researcher" ||
    role === "file-searcher"
  ) {
    return 0;
  }
  if (role === "designer" || role === "imager" || role === "planner") return 1;
  if (isImplementationTaskRow(task)) return 2;
  if (role === "reviewer") return 3;
  return 1;
}

function normalizeDiagramTaskFlow(tasks: ParsedTaskRow[]): ParsedTaskRow[] {
  const base = tasks.some((t) => normalizeTaskRole(t.role) === "file-searcher")
    ? tasks
    : [
        ...tasks,
        {
          role: "file-searcher",
          mode: "chat",
          title: "プロジェクト全体スキャン",
          description:
            "プロジェクト内のすべてのフォルダ・ファイルを最初から読み込んで構造を把握し、ユーザーのリクエストに関連する既存実装・変更候補・注意点を Markdown レポートにまとめる。",
          reason: "サーチ／リサーチと同じタイミングで既存コードベース全体を把握するため",
          dependsOn: [],
        },
      ];

  const ordered = base
    .map((task, oldIndex) => ({ task: { ...task, role: normalizeTaskRole(task.role) }, oldIndex }))
    .sort((a, b) => {
      const byGroup = getTaskFlowGroup(a.task) - getTaskFlowGroup(b.task);
      return byGroup !== 0 ? byGroup : a.oldIndex - b.oldIndex;
    })
    .map(({ task }) => task);

  const indicesByRole = (roles: string[]) =>
    ordered
      .map((t, i) => (roles.includes(normalizeTaskRole(t.role)) ? i : -1))
      .filter((i) => i >= 0);

  const layer1 = indicesByRole([
    "ideaman",
    "searcher",
    "researcher",
    "file-searcher",
  ]);
  const layer2 = indicesByRole(["designer", "imager", "planner"]);
  const fileSearchers = indicesByRole(["file-searcher"]);
  const implementers = ordered
    .map((t, i) => (isImplementationTaskRow(t) ? i : -1))
    .filter((i) => i >= 0);
  const reviewers = indicesByRole(["reviewer"]);

  const dedupSorted = (arr: number[]) =>
    Array.from(new Set(arr)).sort((a, b) => a - b);

  for (let i = 0; i < ordered.length; i++) {
    if (layer1.includes(i)) ordered[i].dependsOn = [];
    else if (layer2.includes(i)) ordered[i].dependsOn = layer1.length ? [...layer1] : [];
    else if (implementers.includes(i)) {
      const baseDeps = layer2.length ? [...layer2] : [...layer1];
      ordered[i].dependsOn = dedupSorted([...baseDeps, ...fileSearchers]);
    } else if (reviewers.includes(i)) {
      ordered[i].dependsOn = implementers.length
        ? [...implementers]
        : dedupSorted([...layer2, ...layer1]);
    }
  }

  return ordered;
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

    const { projectId, input, apiKeys, workspacePath, localWorkspaceContext } = parsed.data;
    const chatHistory = normalizeChatHistory(parsed.data.chatHistory);

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

    const workspaceHint = localWorkspaceContext?.trim()
      ? `\n\n【実行環境】IDE/CLI から localWorkspaceContext（ワークスペーススナップショット）が付与されます。API はローカルディスクを直接読みません。設計後に Leader Todos を挟み、その後の File Search タスクとして file-searcher を必ず含めてください。\n`
      : workspacePath
        ? `\n\n【実行環境】ローカルプロジェクトが開かれています（タスク実行時に workspacePath が渡されます）。設計後に Leader Todos を挟み、その後の File Search タスクとして file-searcher を必ず含めてください。\n`
        : "";

    const enrichedInput = `${formattedHistory}【ユーザーの最新のリクエスト】\n${input}${workspaceHint}`;

    const savedConfig = parseAssignmentConfigSafe(leaderAssignment.config);
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
      parsedTasks = normalizeDiagramTaskFlow(parsedTasks);
      if (parsedTasks.length > beforeFs) {
        logger.info(
          `[TaskCreate] Session ${sessionId} - Injected missing file-searcher task and normalized diagram flow`
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
