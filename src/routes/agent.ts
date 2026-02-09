import { Router, Request, Response } from "express";
import { z } from "zod";
import { runAgent } from "../services/orchestrator";
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
