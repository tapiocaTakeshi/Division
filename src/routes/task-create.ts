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

const TASK_CREATION_PROMPT = `あなたはAIチームのリーダーです。ユーザーのリクエストを分析し、以下の Wave 構造でタスクを分解してください。

## パイプライン構造（必ずこの Wave 順序で多層化する）

【Wave 1 — 初回ファイルスキャン】単独実行（dependsOn: []）
- file-searcher（**初回スキャン**）: プロジェクト内の **すべてのフォルダ・ファイル** を最初に読み込み、構造・既存実装・変更候補・注意点を Markdown レポートにまとめる。**ideaman / searcher / researcher より前**に必ず単独で走り、後続全員にプロジェクトの「現在の真実」を渡す。

【Wave 2 — 調査・発想】Wave 1 に依存（dependsOn: [Wave 1 の file-searcher の index]）
- ideaman: 創造的ブレインストーミング・アイデア出し（既存コードを把握した上で）
- searcher: ウェブ検索・情報収集
- researcher: 調査・分析・レポート

【Wave 3 — 設計・デザイン】Wave 1 + Wave 2 に依存
- designer: UI/UXデザイン・HTML/CSS生成・プロトタイプ
- imager: 画像生成・ビジュアルコンテンツ
- planner: 企画・設計・アーキテクチャ

【Wave 4 — File Search（集中再調査）】Wave 3 に依存
- file-searcher（**集中再調査**）: Wave 3 の設計・画像・計画を元に、変更対象ファイル・既存実装の差分・注意点を集中的に調査して Coder/Writer 向け Markdown レポートを作成する

【Wave 5 — 実装・執筆】Wave 4 の集中再調査に依存
- coder: コード生成・実装・デバッグ
- writer: 文章作成・ドキュメント

【Wave 6 — レビュー】Wave 5に依存（最終ステップ）
- reviewer: 品質確認・レビュー・改善提案（dependsOn にレビュー対象の coder または writer の index を必ず含める）

**重要**: 各タスクは Leader が出した tasks JSON の指示通りに 1 度だけ実行されます。Reviewer ↔ Coder のフィードバックループや、Leader による Todos / Brief Gate の自動挿入はありません。Reviewer の指摘で再修正させたい場合は、必要なタスクをあらかじめ tasks に書いてください。

## ルール
1. 各タスクには0始まりのインデックスが付与されます
2. dependsOn で依存先インデックスを指定。空=並列実行
3. 各タスクにわかりやすいtitleとdescriptionを付ける
4. titleは短く簡潔に（50文字以内）
5. **【必須】file-searcher を 2 タスク含めること**:
   - 1 つ目（**Wave 1 = 初回スキャン**）: 配列の **先頭（index 0）** に置く。dependsOn: [] で **単独で先に**実行する。description には「プロジェクト内のすべてのフォルダ・ファイルを読み込んで構造を把握する」ことを必ず含める。
   - 2 つ目（**Wave 4 = 集中再調査**）: dependsOn には Wave 3（designer/imager/planner）の index を含める。description には「Wave 3 の設計を踏まえて変更対象ファイルと差分を集中的に調査する」ことを必ず含める。
6. 必ず以下のJSON形式のみで回答。説明文は一切不要
7. タスクは最低5個以上。複雑な場合は8〜15個に細分化
8. 1タスクに複数作業を詰め込まず細かく分割
9. 同じロールでも異なる観点なら別タスクに分ける
10. **【必須】Wave 2 には ideaman, searcher, researcher を必ず1タスクずつ含め、すべて dependsOn に Wave 1 file-searcher の index を含めること。Wave 3 には designer, imager, planner を必ず1タスクずつ含め、Wave 1 + Wave 2 のすべての index に依存させること。**
11. 各タスクに "mode" を指定:
    - "chat": テキスト生成タスク（デフォルト。searcher, researcher, file-searcher 等もこれ）
    - "computer_use": コード実行・テストが必要なタスク（coder ロール用）
    - "function_calling": 使用しない（廃止）
    ※ searcher / researcher ロールは Perplexity が Web 検索するため mode="chat" にすること

\`\`\`json
{
  "tasks": [
    { "role": "file-searcher", "mode": "chat", "title": "プロジェクト全体スキャン（初回）", "description": "プロジェクト内のすべてのフォルダ・ファイルを読み込み、構造・既存実装・変更候補・注意点を Markdown レポートにまとめる（Wave 1 / 初回スキャン）", "reason": "Wave 2 以降の全員に既存コードベース全体を渡すため", "dependsOn": [] },
    { "role": "ideaman", "mode": "chat", "title": "アイデア提案", "description": "Wave 1 の既存コードを踏まえ、ユーザーのリクエストに対する革新的なアプローチを複数提案", "reason": "多角的な視点を得るため", "dependsOn": [0] },
    { "role": "searcher", "mode": "chat", "title": "技術調査", "description": "Wave 1 の既存コードを踏まえ、技術的な実現可能性と最新のベストプラクティスを検索", "reason": "正確な前提知識を得るため", "dependsOn": [0] },
    { "role": "researcher", "mode": "chat", "title": "技術トレンド調査", "description": "Wave 1 の既存コードを踏まえ、関連する技術トレンドと事例を調査", "reason": "深い理解を得るため", "dependsOn": [0] },
    { "role": "designer", "mode": "chat", "title": "UIデザイン作成", "description": "既存コードと Wave 2 の調査を元にUIデザインとプロトタイプHTMLを作成", "reason": "ビジュアルを具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "imager", "mode": "chat", "title": "画像・ビジュアル作成", "description": "既存コードと Wave 2 のデザイン方針を元に画像/ビジュアル案を作成", "reason": "視覚要素を具体化するため", "dependsOn": [0, 1, 2, 3] },
    { "role": "planner", "mode": "chat", "title": "設計・要件定義", "description": "既存コードと Wave 2 の調査を元に要件定義と設計を作成", "reason": "実装の方向性を決めるため", "dependsOn": [0, 1, 2, 3] },
    { "role": "file-searcher", "mode": "chat", "title": "変更対象ファイル特定（再調査）", "description": "Wave 3 の設計・画像・計画を元に、変更対象ファイル・既存実装の差分・注意点を集中的に調査して Coder/Writer 向け Markdown レポートを作成する（Wave 4 / 集中再調査）", "reason": "設計後に変更対象を絞り込んで実装の指示書を作るため", "dependsOn": [4, 5, 6] },
    { "role": "coder", "mode": "computer_use", "title": "実装", "description": "Wave 4 の集中再調査の指示に沿って実装", "reason": "動作するコードを生成するため", "dependsOn": [7] },
    { "role": "reviewer", "mode": "chat", "title": "品質レビュー", "description": "実装結果の品質確認と改善提案。OK/Not OK を明示する", "reason": "品質保証のため", "dependsOn": [8] }
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

/**
 * file-searcher が 2 タスク構成になるよう正規化する:
 *  - "primary"  file-searcher: **Wave 1（最初に単独で実行）**
 *  - "focused"  file-searcher: Wave 4（Wave 3 の設計に依存）
 *
 * Wave 構造:
 *   Wave 1: primary file-searcher（単独）
 *   Wave 2: ideaman / searcher / researcher（並列、primary fs に依存）
 *   Wave 3: designer / imager / planner（並列、Wave 1 + Wave 2 に依存）
 *   Wave 4: focused file-searcher（Wave 3 に依存）
 *   Wave 5: coder / writer（focused fs に依存）
 *   Wave 6: reviewer
 */
function normalizeDiagramTaskFlow(tasks: ParsedTaskRow[]): ParsedTaskRow[] {
  const layer1RoleSet = new Set(["ideaman", "searcher", "researcher"]);
  const layer2RoleSet = new Set(["designer", "imager", "planner"]);

  let primaryFsOldIdx = -1;
  let focusedFsOldIdx = -1;
  for (let i = 0; i < tasks.length; i++) {
    if (normalizeTaskRole(tasks[i].role) !== "file-searcher") continue;
    const deps = tasks[i].dependsOn || [];
    const hasLayer2Dep = deps.some((d) => {
      const u = tasks[d];
      return u && layer2RoleSet.has(normalizeTaskRole(u.role));
    });
    if (hasLayer2Dep) {
      if (focusedFsOldIdx < 0) focusedFsOldIdx = i;
    } else {
      if (primaryFsOldIdx < 0) primaryFsOldIdx = i;
    }
  }

  const base: ParsedTaskRow[] = tasks.map((t) => ({
    ...t,
    role: normalizeTaskRole(t.role),
  }));

  if (primaryFsOldIdx < 0) {
    base.push({
      role: "file-searcher",
      mode: "chat",
      title: "プロジェクト全体スキャン（初回）",
      description:
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
      title: "変更対象ファイル特定（再調査）",
      description:
        "Wave 3 の設計・画像・計画を元に、変更対象ファイル・既存実装の差分・注意点を集中的に調査して Coder/Writer がそのまま実装できる Markdown レポートを作成する。",
      reason: "Wave 4: 設計後の集中再調査（Coder/Writer の直前指示）",
      dependsOn: [],
    });
    focusedFsOldIdx = base.length - 1;
  }

  // group 番号 = Wave 番号 - 1
  const groupOf = (task: ParsedTaskRow, oldIndex: number): number => {
    if (oldIndex === primaryFsOldIdx) return 0;   // Wave 1
    if (oldIndex === focusedFsOldIdx) return 3;   // Wave 4
    const role = normalizeTaskRole(task.role);
    if (layer1RoleSet.has(role)) return 1;         // Wave 2
    if (layer2RoleSet.has(role)) return 2;         // Wave 3
    if (isImplementationTaskRow(task)) return 4;   // Wave 5
    if (role === "reviewer") return 5;             // Wave 6
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

  const wave2Indices = indicesByGroup(1);
  const wave3Indices = indicesByGroup(2);
  const implementerIndices = indicesByGroup(4);
  const reviewerIndices = indicesByGroup(5);

  const dedupSorted = (arr: number[]) =>
    Array.from(new Set(arr)).sort((a, b) => a - b);

  for (let i = 0; i < ordered.length; i++) {
    if (i === newPrimaryFsIdx) {
      // Wave 1: 単独実行
      ordered[i].dependsOn = [];
    } else if (i === newFocusedFsIdx) {
      // Wave 4: Wave 3 に依存
      ordered[i].dependsOn = wave3Indices.length
        ? [...wave3Indices]
        : wave2Indices.length
        ? [...wave2Indices]
        : newPrimaryFsIdx >= 0
        ? [newPrimaryFsIdx]
        : [];
    } else if (wave2Indices.includes(i)) {
      // Wave 2: primary fs に依存
      ordered[i].dependsOn = newPrimaryFsIdx >= 0 ? [newPrimaryFsIdx] : [];
    } else if (wave3Indices.includes(i)) {
      // Wave 3: primary fs + Wave 2 に依存
      const deps: number[] = [];
      if (newPrimaryFsIdx >= 0) deps.push(newPrimaryFsIdx);
      deps.push(...wave2Indices);
      ordered[i].dependsOn = dedupSorted(deps);
    } else if (implementerIndices.includes(i)) {
      // Wave 5: focused fs に依存
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
      ? `\n\n【実行環境】IDE/CLI から localWorkspaceContext（ワークスペーススナップショット）が付与されます。API はローカルディスクを直接読みません。設計後に file-searcher（Wave 4 / 集中再調査）タスクを必ず含めてください。\n`
      : workspacePath
        ? `\n\n【実行環境】ローカルプロジェクトが開かれています（タスク実行時に workspacePath が渡されます）。設計後に file-searcher（Wave 4 / 集中再調査）タスクを必ず含めてください。\n`
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
