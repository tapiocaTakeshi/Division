import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { z } from "zod";
import { executeTask, executeTaskStream } from "../services/ai-executor";
import { asyncHandler } from "../middleware/async-handler";
import {
  wrapCoderInput,
  coderOutputHasCode,
  isCoderRoleSlug,
} from "../services/coder-guard";
import {
  abortAllRuns,
  abortRun,
  listRuns,
  newRunId,
  registerRun,
  unregisterRun,
} from "../services/task-registry";

/**
 * file-searcher は ai-executor 内でスナップショットを結合するためここでは付与しない。
 * それ以外（coder / writer / designer など）は orchestrator 経由ではなく直接 /api/tasks/execute
 * を叩くフローでも、元コードを完全に無視した「ゼロから書き直し」にならないようスナップショットを付与する。
 */
function attachLocalWorkspaceContext(
  roleSlug: string,
  input: string,
  bundle: string | undefined
): string {
  const b = (bundle || "").trim();
  if (!b) return input;
  if (roleSlug === "file-searcher") return input;
  return `# ローカルワークスペーススナップショット（クライアントが提供。API はユーザーの PC を直接読みません）

> **重要**: このスナップショットがあなたのプロジェクトの「現在の真実」です。新規にゼロから作り直さず、必要な箇所だけを差分で更新してください。既存ファイルパス・既存スタイル・既存コンポーネント名を必ず維持してください。

${b}

---

## このタスクでの指示

${input}`;
}

export const taskRouter = Router();

/**
 * RoleAssignment.config は JSON `{"model":"..."}` を想定。だが古いデータには
 * プレーン文字列のモデル ID が入っていることがあり、そのまま JSON.parse すると
 * "Unexpected token 'g'" で落ちてしまう。ここで吸収する。
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

const executeTaskSchema = z.object({
  projectId: z.string().min(1),
  roleSlug: z.string().min(1),
  input: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  stream: z.boolean().optional(),
  workspacePath: z.string().optional(),
  localWorkspaceContext: z.string().optional(),
  /**
   * クライアント側で発行した実行 ID。指定されていれば
   * `POST /api/tasks/stop` で同じ ID を渡して中断できる。
   * 省略時はサーバー側で生成し、`X-Run-Id` ヘッダで返す。
   */
  runId: z.string().min(1).optional(),
});

const stopRunSchema = z.object({
  /** 指定されると当該 runId のみ中断。省略時は全アクティブランを中断。 */
  runId: z.string().min(1).optional(),
  /** デバッグ用の任意メッセージ（abort reason として伝搬）。 */
  reason: z.string().optional(),
});

// 各ロールに割り当てられているモデルの output 上限まで使い切る。
//  - Anthropic Opus 4.6  : 32,000
//  - Google  Gemini 2.5 Pro: 65,536
//  - OpenAI  GPT-5.x      : 131,072
//  - Perplexity sonar-pro : 8,192
const ROLE_MAX_TOKENS: Record<string, number> = {
  designer: 65536,
  imager: 65536,
  planner: 65536,

  coder: 32000,
  reviewer: 32000,
  "file-searcher": 32000,

  writer: 131072,
  ideaman: 131072,
  leader: 131072,

  searcher: 8192,
  researcher: 8192,
};

/**
 * Resolve a role slug to its canonical form.
 * First checks the DB directly; if not found, tries known aliases.
 */
async function resolveRole(slug: string) {
  const direct = await prisma.role.findUnique({ where: { slug } });
  if (direct) return direct;

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

  const canonical = ROLE_ALIASES[slug];
  if (canonical) {
    return prisma.role.findUnique({ where: { slug: canonical } });
  }
  return null;
}

// Execute a task: route to the AI assigned to the given role in the project
taskRouter.post("/execute", asyncHandler(async (req: Request, res: Response) => {
  const parsed = executeTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const { projectId, roleSlug, input, config, workspacePath, localWorkspaceContext } = parsed.data;

  // クライアント指定 runId か新規生成 ID をレジストリに登録し、
  // `X-Run-Id` ヘッダで返す（クライアントは後続の /api/tasks/stop に同じ ID を渡せる）。
  const runId = parsed.data.runId || newRunId();
  res.setHeader("X-Run-Id", runId);

  const abortController = registerRun(runId, {
    kind: parsed.data.stream ? "tasks-execute-stream" : "tasks-execute",
    projectId,
    roleSlug,
    userId: (res.locals.userId as string | undefined) ?? undefined,
  });

  // クライアントが切断したらこの実行も中断する（無駄な provider 課金を避ける）。
  req.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort("Client disconnected");
    }
  });

  try {
  // Find the role by slug (supports aliases for backward compatibility)
  const role = await resolveRole(roleSlug);
  if (!role) {
    const allRoles = await prisma.role.findMany({ select: { slug: true, name: true }, orderBy: { slug: "asc" } });
    const available = allRoles.map((r) => `${r.slug} (${r.name})`).join(", ");
    res.status(404).json({
      error: `Role not found: ${roleSlug}`,
      availableRoles: available,
    });
    return;
  }

  // Find the assignment for this project + role (highest priority first)
  const assignment = await prisma.roleAssignment.findFirst({
    where: { projectId, roleId: role.id },
    include: { provider: true },
    orderBy: { priority: "desc" },
  });

  if (!assignment) {
    res.status(404).json({
      error: `No AI provider assigned to role "${roleSlug}" in this project`,
      hint: "Use POST /api/assignments to assign a provider to this role",
    });
    return;
  }

  if (!assignment.provider.isEnabled) {
    res.status(400).json({
      error: `Provider "${assignment.provider.displayName}" is currently disabled`,
    });
    return;
  }

  // Merge saved config with request-time config + role-specific maxTokens
  const savedConfig = parseAssignmentConfigSafe(assignment.config);
  const roleMaxTokens = ROLE_MAX_TOKENS[role.slug];
  const mergedConfig = {
    ...(roleMaxTokens ? { maxTokens: roleMaxTokens } : {}),
    ...savedConfig,
    ...config,
  };

  // Coder ロールは「ツールコール JSON しか返さない」「Let me analyze で止まる」現象が
  // 頻発するため、orchestrator と同じ多層ガードをこのルートでも適用する。
  const isCoderRole = isCoderRoleSlug(role.slug);

  // 1. DB の Role.systemPrompt を必ず使う。フォールバックは持たない。
  const roleSystemPrompt =
    (role as { systemPrompt?: string | null }).systemPrompt ?? undefined;

  // 2. Coder では provider.toolMap を剥がし、Anthropic 等が native tool 呼び出しを
  //    返す経路を物理的に遮断する。
  const effectiveProvider = isCoderRole
    ? { ...assignment.provider, toolMap: undefined }
    : assignment.provider;

  // 3. file-searcher 以外には先にローカルワークスペーススナップショットを差し込む
  //    （これをやらないと coder は元コードを完全に無視して書き直しを始める）。
  const inputWithWorkspace = attachLocalWorkspaceContext(
    role.slug,
    input,
    localWorkspaceContext
  );

  // 4. Coder では入力にもガードを差し込む（system prompt が無視されたときの保険）。
  const finalInput = isCoderRole ? wrapCoderInput(inputWithWorkspace) : inputWithWorkspace;

  const execReq = {
    provider: effectiveProvider,
    config: mergedConfig,
    input: finalInput,
    role: { slug: role.slug, name: role.name },
    ...(roleSystemPrompt ? { systemPrompt: roleSystemPrompt } : {}),
    workspacePath,
    localWorkspaceContext,
    signal: abortController.signal,
  };

  // Streaming mode
  if (parsed.data.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const result = await executeTaskStream(
      execReq,
      (text) => { res.write(`data: ${JSON.stringify({ type: "chunk", text })}\n\n`); },
      (text) => { res.write(`data: ${JSON.stringify({ type: "thinking", text })}\n\n`); }
    );

    // Coder は「コードブロック無し / ツールコール JSON だけ」をエラー扱いにする。
    if (
      isCoderRole &&
      result.status === "success" &&
      !coderOutputHasCode(result.output)
    ) {
      result.status = "error";
      result.errorMsg =
        "Coder did not produce any code block. Ignored output (likely tool-call JSON or analytical preamble).";
    }

    await prisma.taskLog.create({
      data: {
        projectId,
        roleId: role.id,
        providerId: assignment.provider.id,
        input,
        output: result.output || null,
        status: result.status,
        errorMsg: result.errorMsg || null,
        durationMs: result.durationMs,
      },
    });

    if (result.status === "error" && result.errorMsg) {
      res.write(`data: ${JSON.stringify({ type: "error", message: result.errorMsg })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      type: "done",
      role: role.name,
      provider: assignment.provider.displayName,
      model: assignment.provider.modelId,
      status: result.status,
      errorMsg: result.errorMsg || null,
      durationMs: result.durationMs,
    })}\n\n`);
    res.end();
    return;
  }

  // Non-streaming mode
  const result = await executeTask(execReq);

  if (
    isCoderRole &&
    result.status === "success" &&
    !coderOutputHasCode(result.output)
  ) {
    result.status = "error";
    result.errorMsg =
      "Coder did not produce any code block. Ignored output (likely tool-call JSON or analytical preamble).";
  }

  await prisma.taskLog.create({
    data: {
      projectId,
      roleId: role.id,
      providerId: assignment.provider.id,
      input,
      output: result.output || null,
      status: result.status,
      errorMsg: result.errorMsg || null,
      durationMs: result.durationMs,
    },
  });

  res.json({
    role: role.name,
    provider: assignment.provider.displayName,
    model: assignment.provider.modelId,
    ...result,
  });
  } finally {
    unregisterRun(runId);
  }
}));

/**
 * GET /api/tasks/active
 * 現在 task-registry に登録されている実行中タスクを返す。
 * （UI から「現在走っている処理」を一覧したいケース向け）
 */
taskRouter.get("/active", asyncHandler(async (_req: Request, res: Response) => {
  res.json({ runs: listRuns() });
}));

/**
 * POST /api/tasks/stop
 *   body: { runId?: string; reason?: string }
 *
 * - `runId` 指定時: 該当する 1 件を中断（fetch 中なら即座に AbortError、
 *   その後ハンドラの finally でレジストリから外される）。
 * - `runId` 省略時: 現在登録されている全実行を中断する（管理用キルスイッチ）。
 *
 * Vercel のように複数インスタンスにルーティングされる環境では、
 * `X-Run-Id` を発行したインスタンスに stop が届かないと中断できない。
 * 開発時は同一プロセスで動くので確実に効く。
 */
taskRouter.post("/stop", asyncHandler(async (req: Request, res: Response) => {
  const parsed = stopRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const { runId, reason } = parsed.data;

  if (runId) {
    const aborted = abortRun(runId, reason);
    if (!aborted) {
      res.status(404).json({
        error: `No active run found for runId: ${runId}`,
        hint: "Already finished, or this stop request hit a different server instance.",
      });
      return;
    }
    res.json({ aborted: true, runId, reason: reason ?? null });
    return;
  }

  const count = abortAllRuns(reason);
  res.json({ aborted: true, count, reason: reason ?? null });
}));

// Get task execution logs
taskRouter.get("/logs", asyncHandler(async (req: Request, res: Response) => {
  const { projectId, roleSlug, limit } = req.query;

  const where: Record<string, unknown> = {};
  if (projectId) where.projectId = String(projectId);
  if (roleSlug) {
    const role = await resolveRole(String(roleSlug));
    if (role) where.roleId = role.id;
  }

  const logs = await prisma.taskLog.findMany({
    where,
    include: { role: true },
    orderBy: { createdAt: "desc" },
    take: limit ? parseInt(String(limit), 10) : 50,
  });

  res.json(logs);
}));
