/**
 * SSE Route — Server-Sent Events streaming endpoints
 *
 * POST /api/sse       — True SSE streaming for multi-agent orchestration
 * GET  /api/sse/test  — Lightweight connectivity test
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { runAgentStream, StreamEvent } from "../services/orchestrator";
import { asyncHandler } from "../middleware/async-handler";

export const sseRouter = Router();

const sseSchema = z.object({
  projectId: z.string().min(1),
  input: z.string().min(1),
  apiKeys: z.record(z.string()).optional(),
  overrides: z.record(z.string()).optional(),
});

/**
 * POST /api/sse
 *
 * True Server-Sent Events streaming endpoint for multi-agent orchestration.
 * Accepts the same body as /api/agent/run but streams events in real-time.
 *
 * Event types:
 *   session_start  - Session initialized (includes sessionId)
 *   leader_start   - Leader AI begins task decomposition
 *   leader_chunk   - Streaming text fragment from Leader
 *   leader_done    - Leader finished, lists sub-tasks
 *   leader_error   - Leader failed
 *   wave_start     - Parallel execution batch begins
 *   task_start     - Sub-task execution begins
 *   task_chunk     - Streaming text fragment from sub-task AI
 *   task_done      - Sub-task completed
 *   task_error     - Sub-task failed
 *   wave_done      - Parallel execution batch completed
 *   session_done   - All tasks finished (includes aggregated results)
 *   heartbeat      - Connection keepalive (every 15s)
 *
 * SSE Reconnection:
 *   Each event includes an `id` field. Clients can send `Last-Event-ID`
 *   header to indicate the last received event.
 */
sseRouter.post("/", asyncHandler(async (req: Request, res: Response) => {
  const parsed = sseSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Handle client disconnect
  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const sendEvent = (event: StreamEvent) => {
    if (closed) return;
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    // Flush the response buffer to prevent Vercel from buffering SSE events
    if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
      (res as unknown as { flush: () => void }).flush();
    }
  };

  try {
    await runAgentStream(parsed.data, sendEvent);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errorEvent: StreamEvent = {
      type: "leader_error",
      id: `error-${Date.now()}`,
      error: message,
    };
    sendEvent(errorEvent);
  } finally {
    if (!closed) {
      res.end();
    }
  }
}));

/**
 * GET /api/sse/test
 *
 * Streams a short sequence of status events to verify SSE connectivity.
 *
 * Event flow:
 *   1. Immediately sends {"status":"started"}
 *   2. After 1s sends {"status":"running","msg":"step1 done"}
 *   3. After 2s sends {"status":"done"} and closes the connection
 */
sseRouter.get("/test", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let closed = false;
  req.on("close", () => {
    closed = true;
    clearTimeout(timer1);
    clearTimeout(timer2);
  });

  res.write(`data: {"status":"started"}\n\n`);

  const timer1 = setTimeout(() => {
    if (closed) return;
    res.write(`data: {"status":"running","msg":"step1 done"}\n\n`);
  }, 1000);

  const timer2 = setTimeout(() => {
    if (closed) return;
    res.write(`data: {"status":"done"}\n\n`);
    res.end();
  }, 2000);
});
