import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { runAgentStream } from "../src/services/orchestrator";

const schema = z.object({
  projectId: z.string().min(1),
  input: z.string().min(1),
  apiKeys: z.record(z.string()).optional(),
  overrides: z.record(z.string()).optional(),
});

/**
 * Vercel-native SSE streaming handler (bypasses Express).
 *
 * Express + @vercel/node buffers the entire response before sending it,
 * which breaks Server-Sent Events. This handler writes directly to the
 * Node.js ServerResponse via res.write(), which Vercel's streaming bridge
 * can flush incrementally.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Content-Encoding", "none");
  res.setHeader("X-Accel-Buffering", "no");
  res.status(200);

  // Send initial SSE comment to start the stream immediately
  res.write(":ok\n\n");

  const emit = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runAgentStream(parsed.data, emit);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", { message });
  }

  res.end();
}
