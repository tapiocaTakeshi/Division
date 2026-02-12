/**
 * SSE Route — Server-Sent Events streaming test endpoint
 *
 * A lightweight endpoint for verifying SSE connectivity
 * and demonstrating the streaming protocol.
 *
 * GET /api/sse      — Streams a simple status sequence
 * GET /api/sse/test — Alias for the same SSE test stream
 */

import { Router, Request, Response } from "express";

export const sseRouter = Router();

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
sseRouter.get("/", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let closed = false;
  req.on("close", () => {
    closed = true;
    clearTimeout(t1);
    clearTimeout(t2);
  });

  res.write(`data: {"status":"started"}\n\n`);

  const t1 = setTimeout(() => {
    if (closed) return;
    res.write(`data: {"status":"running","msg":"step1 done"}\n\n`);
  }, 1000);

  const t2 = setTimeout(() => {
    if (closed) return;
    res.write(`data: {"status":"done"}\n\n`);
    res.end();
  }, 2000);
});

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
