import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { asyncHandler } from "../middleware/async-handler";

export const knockRouter = Router();

/**
 * Knock Detection — API port-knocking security layer.
 *
 * Clients must send a correct sequence of "knocks" (codes) to obtain
 * a temporary access token.  This adds a pre-authentication gate that
 * can protect sensitive endpoints from automated scanning.
 *
 * Configuration (env vars):
 *   KNOCK_SEQUENCE  — Comma-separated knock codes (default: "shave-and-a-haircut,two-bits")
 *   KNOCK_TTL_MS    — Time window to complete the sequence (default: 30 000 ms)
 *   KNOCK_TOKEN_TTL — How long an issued token remains valid (default: 300 000 ms / 5 min)
 *
 * Flow:
 *   1. POST /api/knock  { code: "shave-and-a-haircut", clientId: "abc" }
 *   2. POST /api/knock  { code: "two-bits",             clientId: "abc" }
 *   → { status: "granted", token: "knock_xxx", expiresAt: "..." }
 *
 *   GET /api/knock/verify  Authorization: Bearer knock_xxx
 *   → { valid: true, expiresAt: "..." }
 */

// ---------- helpers ----------

function getSequence(): string[] {
  const raw = process.env.KNOCK_SEQUENCE || "shave-and-a-haircut,two-bits";
  return raw.split(",").map((s) => s.trim());
}

function getKnockTtl(): number {
  return Number(process.env.KNOCK_TTL_MS) || 30_000;
}

function getTokenTtl(): number {
  return Number(process.env.KNOCK_TOKEN_TTL) || 300_000;
}

// ---------- in-memory stores ----------

interface KnockProgress {
  codes: string[];
  startedAt: number;
}

interface KnockToken {
  token: string;
  clientId: string;
  expiresAt: number;
}

/** Active knock sequences keyed by clientId */
const knockProgress = new Map<string, KnockProgress>();

/** Issued tokens keyed by token string */
const knockTokens = new Map<string, KnockToken>();

/** Periodic cleanup every 60s */
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of knockProgress) {
    if (now - p.startedAt > getKnockTtl()) knockProgress.delete(id);
  }
  for (const [tok, t] of knockTokens) {
    if (now > t.expiresAt) knockTokens.delete(tok);
  }
}, 60_000);

// ---------- schemas ----------

const knockSchema = z.object({
  code: z.string().min(1),
  clientId: z.string().min(1),
});

// ---------- routes ----------

/**
 * POST /api/knock
 *
 * Send a knock code. Returns progress or a token on successful completion.
 */
knockRouter.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = knockSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { code, clientId } = parsed.data;
    const sequence = getSequence();
    const knockTtl = getKnockTtl();
    const now = Date.now();

    // Get or create progress
    let progress = knockProgress.get(clientId);
    if (!progress || now - progress.startedAt > knockTtl) {
      progress = { codes: [], startedAt: now };
      knockProgress.set(clientId, progress);
    }

    const nextIndex = progress.codes.length;

    // Wrong code → reset
    if (nextIndex >= sequence.length || code !== sequence[nextIndex]) {
      knockProgress.delete(clientId);
      res.status(403).json({
        status: "rejected",
        message: "Incorrect knock sequence. Reset.",
      });
      return;
    }

    progress.codes.push(code);

    // Sequence complete → issue token
    if (progress.codes.length === sequence.length) {
      knockProgress.delete(clientId);

      const tokenTtl = getTokenTtl();
      const token = `knock_${randomUUID().replace(/-/g, "")}`;
      const expiresAt = now + tokenTtl;

      knockTokens.set(token, { token, clientId, expiresAt });

      res.json({
        status: "granted",
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        message: "Knock sequence completed. Use this token for access.",
      });
      return;
    }

    // Partial progress
    res.json({
      status: "continue",
      progress: `${progress.codes.length}/${sequence.length}`,
      message: "Knock accepted. Continue the sequence.",
    });
  })
);

/**
 * GET /api/knock/verify
 *
 * Verify a knock token. Send `Authorization: Bearer knock_xxx`.
 */
knockRouter.get("/verify", (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header) {
    res.status(401).json({ valid: false, error: "Missing Authorization header" });
    return;
  }

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    res.status(401).json({ valid: false, error: "Malformed Authorization header" });
    return;
  }

  const token = parts[1];
  const entry = knockTokens.get(token);

  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) knockTokens.delete(token);
    res.status(401).json({ valid: false, error: "Token invalid or expired" });
    return;
  }

  res.json({
    valid: true,
    clientId: entry.clientId,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  });
});

/**
 * GET /api/knock/status
 *
 * Check the knock detection service status.
 */
knockRouter.get("/status", (_req: Request, res: Response) => {
  const sequence = getSequence();
  res.json({
    status: "active",
    sequenceLength: sequence.length,
    knockTtlMs: getKnockTtl(),
    tokenTtlMs: getTokenTtl(),
    activeSequences: knockProgress.size,
    activeTokens: knockTokens.size,
  });
});
