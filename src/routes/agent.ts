import { Router, Request, Response } from "express";
import { z } from "zod";
import { runAgent, runAgentStream, StreamEvent } from "../services/orchestrator";
import { asyncHandler } from "../middleware/async-handler";

export const agentRouter = Router();

const agentRunSchema = z.object({
  projectId: z.string().min(1),
  input: z.string().min(1),
  apiKeys: z.record(z.string()).optional(),
  /** Override provider for specific roles, e.g. { coding: "gemini", search: "gpt" } */
  overrides: z.record(z.string()).optional(),
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
 * Response format: JSON
 *   - Success: { "type": "result", "data": { ...OrchestratorResult } }
 *   - Error:   { "type": "error", "error": "...", "message": "..." }
 */
agentRouter.post("/run", asyncHandler(async (req: Request, res: Response) => {
  const parsed = agentRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  try {
    const result = await runAgent(parsed.data);
    res.json({ type: "result", data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ type: "error", error: "Agent execution failed", message });
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

  // Handle client disconnect
  let closed = false;
  req.on("close", () => {
    closed = true;
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
