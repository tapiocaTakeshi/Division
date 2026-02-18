/**
 * Generate Route — Single-model text generation
 *
 * Direct AI text generation without orchestration.
 * Supports both non-streaming and SSE streaming responses.
 *
 * POST /api/generate       — Non-streaming generation
 * POST /api/generate/stream — SSE streaming generation
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { executeTask, executeTaskStream } from "../services/ai-executor";
import { asyncHandler } from "../middleware/async-handler";
import { resolveApiKey } from "../services/api-key-resolver";

export const generateRouter = Router();

const generateSchema = z.object({
  provider: z.string().min(1, "provider is required (e.g. 'claude-sonnet-4.5', 'gemini-3-pro')"),
  input: z.string().min(1, "input is required"),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  apiKeys: z.record(z.string()).optional(),
});

/**
 * POST /api/generate
 *
 * Generate text from a single AI model (non-streaming).
 */
generateRouter.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { provider: providerName, input, systemPrompt, maxTokens, apiKeys } = parsed.data;
    const authenticated = !!res.locals.authenticated;

    const provider = await prisma.provider.findUnique({ where: { name: providerName } });
    if (!provider) {
      res.status(404).json({ error: `Provider not found: ${providerName}` });
      return;
    }
    if (!provider.isEnabled) {
      res.status(400).json({ error: `Provider is disabled: ${providerName}` });
      return;
    }

    const apiKey = resolveApiKey(provider.name, provider.apiType, apiKeys, authenticated);

    const result = await executeTask({
      provider,
      config: { apiKey, ...(maxTokens ? { maxTokens } : {}) },
      input,
      role: { slug: "generate", name: "Generate" },
      systemPrompt,
    });

    res.json({
      provider: provider.displayName,
      model: provider.modelId,
      output: result.output,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.errorMsg ? { error: result.errorMsg } : {}),
    });
  })
);

/**
 * POST /api/generate/stream
 *
 * Generate text from a single AI model with SSE streaming.
 *
 * Event types:
 *   start    — Generation started (provider & model info)
 *   chunk    — Text fragment from the AI model
 *   thinking — Thinking/reasoning fragment from the AI model
 *   done     — Generation complete (status, duration, thinking, citations)
 *   error    — Generation failed
 */
generateRouter.post(
  "/stream",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { provider: providerName, input, systemPrompt, maxTokens, apiKeys } = parsed.data;
    const authenticated = !!res.locals.authenticated;

    const provider = await prisma.provider.findUnique({ where: { name: providerName } });
    if (!provider) {
      res.status(404).json({ error: `Provider not found: ${providerName}` });
      return;
    }
    if (!provider.isEnabled) {
      res.status(400).json({ error: `Provider is disabled: ${providerName}` });
      return;
    }

    const apiKey = resolveApiKey(provider.name, provider.apiType, apiKeys, authenticated);

    // Set up SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const sendEvent = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Flush the response buffer to prevent Vercel from buffering SSE events
      if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
        (res as unknown as { flush: () => void }).flush();
      }
    };

    sendEvent("start", {
      type: "start",
      provider: provider.displayName,
      model: provider.modelId,
    });

    try {
      const result = await executeTaskStream(
        {
          provider,
          config: { apiKey, ...(maxTokens ? { maxTokens } : {}) },
          input,
          role: { slug: "generate", name: "Generate" },
          systemPrompt,
        },
        (text) => sendEvent("chunk", { type: "chunk", text }),
        (text) => sendEvent("thinking", { type: "thinking", text })
      );

      if (result.status === "success") {
        sendEvent("done", {
          type: "done",
          status: "success",
          durationMs: result.durationMs,
          ...(result.thinking ? { thinking: result.thinking } : {}),
          ...(result.citations ? { citations: result.citations } : {}),
        });
      } else {
        sendEvent("error", {
          type: "error",
          error: result.errorMsg || "Generation failed",
          durationMs: result.durationMs,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendEvent("error", { type: "error", error: message });
    } finally {
      if (!closed) {
        res.end();
      }
    }
  })
);
