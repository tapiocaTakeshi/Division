import { Router, Request, Response } from "express";
import { z } from "zod";
import { runAgent, runAgentStream } from "../services/orchestrator";
import { asyncHandler } from "../middleware/async-handler";

export const agentRouter = Router();

const agentRunSchema = z.object({
  projectId: z.string().min(1),
  input: z.string().min(1),
  apiKeys: z.record(z.string()).optional(),
  /** Override provider for specific roles, e.g. { coding: "gemini", search: "gpt" } */
  overrides: z.record(z.string()).optional(),
});

/**
 * POST /api/agent/run
 *
 * Send a single request and let the Leader AI decompose it into sub-tasks,
 * automatically dispatch each to the assigned AI provider, and return
 * the aggregated results.
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
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Agent execution failed", message });
  }
}));

/**
 * POST /api/agent/stream
 *
 * SSE streaming endpoint for real-time orchestration logs.
 * Sends events as the Leader decomposes tasks and each sub-task executes.
 *
 * Event types:
 *   session_start  - Session initialized
 *   leader_start   - Leader AI begins task decomposition
 *   leader_chunk   - Streaming text fragment from Leader
 *   leader_done    - Leader finished decomposition, lists sub-tasks
 *   leader_error   - Leader failed
 *   task_start     - Sub-task execution begins
 *   task_chunk     - Streaming text fragment from sub-task AI
 *   task_done      - Sub-task completed
 *   task_error     - Sub-task failed
 *   session_done   - All tasks finished
 */
agentRouter.post("/stream", asyncHandler(async (req: Request, res: Response) => {
  const parsed = agentRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  // Set up SSE headers
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

  const sendEvent = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runAgentStream(parsed.data, (event) => {
      sendEvent(event.type, event);
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendEvent("error", { type: "error", message });
  } finally {
    if (!closed) {
      res.end();
    }
  }
}));
