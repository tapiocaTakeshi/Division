import { Router, Request, Response } from "express";
import { z } from "zod";
import { runAgentStream } from "../services/orchestrator";
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
 * Multi-agent orchestration with SSE-style event log.
 * Returns all events as a JSON array (Vercel-compatible).
 * Each event has: event name, data payload, and timestamp (ms from start).
 *
 * Events:
 *   session      - session started
 *   leader_start - leader AI starting decomposition
 *   leader_done  - leader finished, sub-tasks listed
 *   task_start   - sub-task execution begins
 *   task_done    - sub-task completed with output
 *   done         - all tasks finished
 *   error        - fatal error
 */
sseRouter.post("/", asyncHandler(async (req: Request, res: Response) => {
  const parsed = sseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const events: Array<{ event: string; data: unknown; timestamp: number }> = [];
  const startTime = Date.now();

  const emit = (event: string, data: unknown) => {
    events.push({ event, data, timestamp: Date.now() - startTime });
  };

  try {
    await runAgentStream(parsed.data, emit);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", { message });
  }

  res.json({ events, totalDurationMs: Date.now() - startTime });
}));
