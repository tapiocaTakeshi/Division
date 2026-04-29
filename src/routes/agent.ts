import { Router, Request, Response } from "express";
import { z } from "zod";
import { runAgent, runAgentStream, StreamEvent } from "../services/orchestrator";
import { asyncHandler } from "../middleware/async-handler";
import { normalizeChatHistory } from "../utils/normalize-chat-history";
import { newRunId, registerRun, unregisterRun } from "../services/task-registry";

export const agentRouter = Router();

const agentRunSchema = z.object({
  projectId: z.string().min(1),
  input: z.string().min(1),
  apiKeys: z.record(z.string()).optional(),
  /** Override provider for specific roles, e.g. { coding: "gemini", search: "gpt" } */
  overrides: z.record(z.string()).optional(),
  /**
   * Chat history for context.
   * OpenAI 互換の `system` / `tool` / `function` / `developer` も受け付け、
   * サーバ側で `user` / `assistant` に正規化する。
   */
  chatHistory: z.array(z.object({
    role: z.string(),
    content: z.string(),
    name: z.string().optional().nullable(),
    tool_call_id: z.string().optional().nullable(),
  })).optional(),
  /** Absolute path to user's workspace for file-search / coder tools */
  workspacePath: z.string().optional(),
  /**
   * IDE/CLI がローカルで収集したワークスペース本文（Markdown 等）。指定時 API はユーザーのディスクを直接読まない。
   */
  localWorkspaceContext: z.string().optional(),
  /**
   * クライアント側で発行した実行 ID。`POST /api/tasks/stop` に同じ ID を渡せば
   * このオーケストレーション全体を中断できる。省略時はサーバー側で生成し
   * `X-Run-Id` ヘッダで返す（ストリームでは `session_start` の直前にも書ける）。
   */
  runId: z.string().min(1).optional(),
});

const agentStreamSchema = agentRunSchema.extend({
  /** Response format: "sse" (default) or "ndjson" */
  format: z.enum(["sse", "ndjson"]).optional(),
});

/**
 * POST /api/agent/run
 *
 * Send a single request and let the Leader AI decompose it into sub-tasks,
 * automatically dispatch each to the assigned AI provider, and return
 * the aggregated results.
 *
 * Response format: NDJSON (newline-delimited JSON) stream
 *   - Log lines:  { "type": "log", "message": "..." }
 *   - Final line: { "type": "result", "data": { ...OrchestratorResult } }
 *   - Error line: { "type": "error", "error": "...", "message": "..." }
 */
agentRouter.post("/run", asyncHandler(async (req: Request, res: Response) => {
  const parsed = agentRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  // /api/tasks/stop からの中断要求を受け取れるようレジストリに登録する。
  const runId = parsed.data.runId || newRunId();
  res.setHeader("X-Run-Id", runId);
  const abortController = registerRun(runId, {
    kind: "agent-run",
    projectId: parsed.data.projectId,
    userId: (res.locals.userId as string | undefined) ?? undefined,
  });

  // Stream NDJSON for real-time log output
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let closed = false;
  req.on("close", () => {
    closed = true;
    if (!res.writableEnded) {
      abortController.abort("Client disconnected");
    }
  });

  const writeLine = (obj: Record<string, unknown>) => {
    if (!closed) {
      res.write(JSON.stringify(obj) + "\n");
    }
  };

  // X-Run-Id をクライアントが取り損ねないよう、最初の行でも明示する。
  writeLine({ type: "run", runId });

  try {
    const result = await runAgent(
      {
        ...parsed.data,
        chatHistory: normalizeChatHistory(parsed.data.chatHistory),
        authenticated: !!res.locals.authenticated,
        userId: res.locals.userId as string | undefined,
        signal: abortController.signal,
      },
      (message) => { writeLine({ type: "log", message }); }
    );
    writeLine({ type: "result", data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    writeLine({ type: "error", error: "Agent execution failed", message });
  } finally {
    unregisterRun(runId);
    if (!closed) {
      res.end();
    }
  }
}));

/**
 * POST /api/agent/stream
 *
 * Streaming endpoint for real-time multi-agent orchestration.
 * Supports two response formats:
 *   - SSE (default): Standard Server-Sent Events with `id:` for reconnection
 *   - NDJSON: Newline-delimited JSON for programmatic consumption
 *
 * Set `format: "ndjson"` in the request body to use NDJSON format.
 *
 * Event types:
 *   session_start  - Session initialized (includes sessionId)
 *   leader_start   - Leader AI begins task decomposition
 *   leader_chunk   - Streaming text fragment from Leader
 *   leader_done    - Leader finished, lists sub-tasks with inputs & reasons
 *   leader_error   - Leader failed
 *   task_start     - Sub-task execution begins (includes provider & input)
 *   task_chunk     - Streaming text fragment from sub-task AI
 *   task_done      - Sub-task completed (includes full output)
 *   task_error     - Sub-task failed
 *   session_done   - All tasks finished (includes aggregated results)
 *   heartbeat      - Connection keepalive (every 15s)
 *
 * SSE Reconnection:
 *   Each event includes an `id` field. Clients can send `Last-Event-ID`
 *   header to indicate the last received event (for future reconnection support).
 */
agentRouter.post("/stream", asyncHandler(async (req: Request, res: Response) => {
  const parsed = agentStreamSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const format = parsed.data.format || "sse";
  const isNdjson = format === "ndjson";

  // /api/tasks/stop からの中断要求を受け取れるようレジストリに登録する。
  const runId = parsed.data.runId || newRunId();
  res.setHeader("X-Run-Id", runId);
  const abortController = registerRun(runId, {
    kind: "agent-stream",
    projectId: parsed.data.projectId,
    userId: (res.locals.userId as string | undefined) ?? undefined,
  });

  // Handle client disconnect
  let closed = false;
  req.on("close", () => {
    closed = true;
    if (!res.writableEnded) {
      abortController.abort("Client disconnected");
    }
  });

  if (isNdjson) {
    // NDJSON format
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  } else {
    // SSE format
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }

  const sendEvent = (event: StreamEvent) => {
    if (closed) return;
    if (isNdjson) {
      res.write(JSON.stringify(event) + "\n");
    } else {
      // SSE with event ID for reconnection
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    // Flush the response buffer to prevent Vercel from buffering SSE events
    if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
      (res as unknown as { flush: () => void }).flush();
    }
  };

  try {
    await runAgentStream(
      {
        ...parsed.data,
        chatHistory: normalizeChatHistory(parsed.data.chatHistory),
        authenticated: !!res.locals.authenticated,
        userId: res.locals.userId as string | undefined,
        signal: abortController.signal,
      },
      sendEvent
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errorEvent: StreamEvent = {
      type: "leader_error",
      id: `error-${Date.now()}`,
      error: message,
    };
    sendEvent(errorEvent);
  } finally {
    unregisterRun(runId);
    if (!closed) {
      res.end();
    }
  }
}));
