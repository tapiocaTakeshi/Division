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
 * SSE (Server-Sent Events) streaming version.
 * Emits events as each step completes:
 *   session      -> session started
 *   leader_start -> leader AI starting
 *   leader_done  -> leader decomposed tasks
 *   task_start   -> sub-task starting
 *   task_done    -> sub-task completed
 *   done         -> all tasks complete
 *   error        -> fatal error
 */
agentRouter.post("/stream", async (req: Request, res: Response) => {
  const parsed = agentRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  // SSE headers — disable all buffering for Vercel / nginx / proxies
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Content-Encoding", "none");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);
  res.flushHeaders();

  const emit = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Force flush for Vercel serverless / buffered proxies
    if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
      (res as unknown as { flush: () => void }).flush();
    }
  };

  try {
    await runAgentStream(parsed.data, emit);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", { message });
  }

  res.end();
});
