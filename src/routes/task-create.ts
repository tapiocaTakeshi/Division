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

const TASK_CREATION_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、必要なタスクに分解してください。他のロールはあなたが出したタスクの通りに動くだけなので、実際に必要なタスクと依存関係をあなた自身が正確に決めてください。

## 利用可能なロール
- file-searcher: プロジェクト内のファイル・既存実装の調査
- ideaman: 創造的ブレインストーミング・アイデア出し
- searcher: ウェブ検索・情報収集
- researcher: 深い調査・分析・レポート
- designer: UI/UXデザイン・HTML/CSS生成・プロトタイプ
- imager: 画像生成・ビジュアルコンテンツ
- planner: 企画・設計・アーキテクチャ
- coder: コード生成・実装・デバッグ
- writer: 文章作成・ドキュメント
- reviewer: 品質確認・レビュー・改善提案

**重要**: 各タスクは Leader が出した tasks JSON の指示通りに 1 度だけ実行されます。Reviewer ↔ Coder のフィードバックループや、Todos / Brief Gate の自動挿入はありません。後続で必要になる作業は、あらかじめ tasks に書いてください。

## ルール
1. 各タスクには0始まりのインデックスが付与されます
2. dependsOn には「このタスクの前に完了しているべきタスク」のインデックスを指定してください。自分より前のインデックスのみ指定できます。空配列 [] は依存なし＝並列実行
3. 各タスクにわかりやすいtitleとdescriptionを付ける
4. titleは短く簡潔に（50文字以内）
5. リクエストの内容に本当に必要なロールだけを選んでください。無関係なロールを形だけ含める必要はありません。単純な依頼なら数タスクで十分です。
6. 必ず以下のJSON形式のみで回答。説明文は一切不要
7. 1タスクに複数作業を詰め込まず、必要なら細かく分割する
8. 同じロールでも異なる観点なら別タスクに分けてよい
9. 各タスクに "mode" を指定:
    - "chat": テキスト生成タスク（デフォルト。searcher, researcher, file-searcher 等もこれ）
    - "computer_use": コード実行・テストが必要なタスク（coder ロール用）
    ※ searcher / researcher ロールは Perplexity が Web 検索するため mode="chat" にすること
10. 各タスクには任意で "context": ["src/auth/Auth.ts", ...] を書けます。**そのタスクが実際に読む必要のあるファイルだけ**を挙げてください（多く渡すほど良いわけではありません）。省略した場合はロール別に自動選択されます。file-searcher の調査前でパスが分からない段階では省略してかまいません。
    ※ ファイルサイズ上限・秘密情報の除外・ロール権限・コンテキスト上限は実行側が別途強制します。あなたが指定しても、それらに反するものは渡りません。

\`\`\`json
{
  "tasks": [
    { "role": "file-searcher", "mode": "chat", "title": "既存実装の調査", "description": "プロジェクト内の関連ファイルを読み込み、既存実装・変更候補・注意点を Markdown レポートにまとめる", "reason": "実装前に既存コードを把握するため", "dependsOn": [] },
    { "role": "coder", "mode": "computer_use", "title": "実装", "description": "file-searcher の調査結果を踏まえて実装する", "reason": "動作するコードを生成するため", "dependsOn": [0], "context": [] },
    { "role": "reviewer", "mode": "chat", "title": "品質レビュー", "description": "実装結果の品質確認と改善提案。OK/Not OK を明示する", "reason": "品質保証のため", "dependsOn": [1], "context": [] }
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
  /**
   * Leader がこのタスクに配分したファイルパス。
   * Task テーブルには持たせず、この作成レスポンスにだけ載せる。実行側
   * （Orchestra のローカル orchestration）が受け取って即座に使うためのもので、
   * ポリシー適用後に何が実際に渡ったかは実行側の記録が正となる。
   */
  context?: string[];
};

/** Leader が書いた `context` 配列をパスの配列として読む。 */
function parseTaskContextPaths(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      paths.push(entry.trim().replace(/^\.\//, ""));
      continue;
    }
    if (entry && typeof entry === "object") {
      const p = (entry as Record<string, unknown>).path;
      if (typeof p === "string" && p.trim()) paths.push(p.trim().replace(/^\.\//, ""));
    }
  }
  return paths.length > 0 ? paths : undefined;
}

function normalizeTaskRole(role: string): string {
  return role === "file_searcher" ? "file-searcher" : role;
}

/**
 * Leader が指定した dependsOn をそのまま信頼する。ロール強制挿入や dependsOn の
 * 上書きは行わず、範囲外・自己参照・未来参照のインデックスだけを取り除く。
 */
function sanitizeTaskDependsOn(tasks: ParsedTaskRow[]): ParsedTaskRow[] {
  return tasks.map((t, i) => ({
    ...t,
    role: normalizeTaskRole(t.role),
    dependsOn: (t.dependsOn || []).filter(
      (d) => Number.isInteger(d) && d >= 0 && d < i
    ),
  }));
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
      ? `\n\n【実行環境】IDE/CLI から localWorkspaceContext（ワークスペーススナップショット）が付与されます。API はローカルディスクを直接読みません。必要なら file-searcher タスクを含めてください。\n`
      : workspacePath
        ? `\n\n【実行環境】ローカルプロジェクトが開かれています（タスク実行時に workspacePath が渡されます）。必要なら file-searcher タスクを含めてください。\n`
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
      context?: string[];
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
          context: parseTaskContextPaths(t.context ?? t.files),
        })
      );

      parsedTasks = sanitizeTaskDependsOn(parsedTasks);
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
      tasks: createdTasks.map((t, index) => ({
        ...t,
        dependsOn: t.dependsOn ? JSON.parse(t.dependsOn) : [],
        context: parsedTasks[index]?.context ?? [],
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
