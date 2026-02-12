import { z } from "zod";
import { runAgentStream } from "../src/services/orchestrator";

const schema = z.object({
  projectId: z.string().min(1),
  input: z.string().min(1),
  apiKeys: z.record(z.string()).optional(),
  overrides: z.record(z.string()).optional(),
});

/**
 * POST /api/sse — Native Vercel SSE streaming handler (Web Standard API).
 *
 * Returns a ReadableStream with Server-Sent Events for real-time
 * multi-agent orchestration progress. Bypasses Express to avoid
 * Vercel's @vercel/node response buffering.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(":ok\n\n"));

      const emit = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        await runAgentStream(parsed.data, emit);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        emit("error", { message });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
