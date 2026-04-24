/**
 * Usage & Cost Service
 *
 * Tracks per-call token usage and calculates costs using the Model table's
 * inputCostPerMToken / outputCostPerMToken. Each call is logged to UsageLog
 * and a webhook is fired to notify external billing systems.
 *
 * Flow:
 *   1. AI call completes → recordUsage() called
 *   2. Look up cost data from Model table
 *   3. Calculate cost: tokens * costPerMToken / 1_000_000
 *   4. Insert into UsageLog
 *   5. Fire webhook (async, non-blocking)
 */

import { prisma } from "../db";
import { logger } from "../utils/logger";
import { Decimal } from "@prisma/client/runtime/library";

const WEBHOOK_URL = process.env.USAGE_WEBHOOK_URL || process.env.CREDIT_API_URL || "";
const WEBHOOK_SECRET = process.env.DIVISION_WEBHOOK_SECRET || process.env.DIVISION_API_KEY || "";

// ===== Types =====

export interface UsageRecord {
  userId?: string;
  projectId?: string;
  sessionId?: string;
  providerId: string;
  modelId: string;
  role?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageCost {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

export interface RecordUsageResult {
  id: string;
  cost: UsageCost;
  webhookStatus: string;
}

export interface WebhookPayload {
  event: "usage.recorded";
  usageId: string;
  userId?: string;
  projectId?: string;
  sessionId?: string;
  providerId: string;
  modelId: string;
  role?: string;
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  timestamp: string;
}

// ===== Cost Calculation =====

/**
 * Look up cost rates from the Model table and calculate USD cost.
 */
async function calculateCost(
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number
): Promise<UsageCost> {
  const model = await prisma.model.findFirst({
    where: {
      OR: [
        { providerId, modelId },
        { providerId, modelId: { startsWith: modelId.split("-").slice(0, 2).join("-") } },
      ],
    },
    select: { inputCostPerMToken: true, outputCostPerMToken: true },
  });

  if (!model || !model.inputCostPerMToken || !model.outputCostPerMToken) {
    logger.warn(`[Usage] No cost data for ${providerId}/${modelId}, using zero cost`);
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 };
  }

  const inputRate = Number(model.inputCostPerMToken);
  const outputRate = Number(model.outputCostPerMToken);

  const inputCostUsd = (inputTokens * inputRate) / 1_000_000;
  const outputCostUsd = (outputTokens * outputRate) / 1_000_000;
  const totalCostUsd = inputCostUsd + outputCostUsd;

  return { inputCostUsd, outputCostUsd, totalCostUsd };
}

// ===== Webhook =====

/** Timeouts and retry policy. Override via env if needed. */
const WEBHOOK_TIMEOUT_MS = Number(process.env.USAGE_WEBHOOK_TIMEOUT_MS ?? 30_000);
const WEBHOOK_MAX_ATTEMPTS = Math.max(1, Number(process.env.USAGE_WEBHOOK_MAX_ATTEMPTS ?? 4));
const WEBHOOK_RETRY_BASE_MS = Math.max(100, Number(process.env.USAGE_WEBHOOK_RETRY_BASE_MS ?? 500));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 1 回分の HTTP POST。タイムアウトと retry は上位 `fireWebhook` で束ねる。
 * 200 系は `ok`、429/5xx は `retryable`、それ以外の 4xx は `client_error` を返す。
 */
async function sendWebhookOnce(
  url: string,
  payload: WebhookPayload
): Promise<
  | { kind: "ok"; body: string }
  | { kind: "retryable"; status: number | null; body: string }
  | { kind: "client_error"; status: number; body: string }
> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        /**
         * Edge Function 側はこのヘッダを優先して冪等性キーとして扱う。
         * 同じ `usageId` なら何度叩いても二重に credit が引かれない。
         */
        "Idempotency-Key": payload.usageId,
        ...(WEBHOOK_SECRET ? { Authorization: `Bearer ${WEBHOOK_SECRET}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    const body = await res.text().catch(() => "");

    if (res.ok) return { kind: "ok", body };
    if (res.status === 429 || res.status >= 500) {
      return { kind: "retryable", status: res.status, body: body.slice(0, 500) };
    }
    return { kind: "client_error", status: res.status, body: body.slice(0, 500) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "retryable", status: null, body: msg };
  }
}

/**
 * Webhook 送信 + 指数バックオフ再送。冪等性は `Idempotency-Key: usageId` で担保されるので、
 * 重複課金を恐れずに安全にリトライできる。
 */
async function fireWebhook(payload: WebhookPayload): Promise<{ status: string; response?: string }> {
  if (!WEBHOOK_URL) {
    return { status: "skipped", response: "No USAGE_WEBHOOK_URL configured" };
  }

  const url = WEBHOOK_URL.includes("/functions/")
    ? WEBHOOK_URL
    : `${WEBHOOK_URL}/api/webhook/usage`;

  let lastErrorLine = "";
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    const result = await sendWebhookOnce(url, payload);

    if (result.kind === "ok") {
      if (attempt > 1) {
        logger.info(`[Usage] Webhook succeeded on attempt ${attempt}`);
      }
      return { status: "sent", response: result.body.slice(0, 500) };
    }

    if (result.kind === "client_error") {
      logger.warn(`[Usage] Webhook client error (no retry): ${result.status} ${result.body.slice(0, 200)}`);
      return { status: "failed", response: `${result.status}: ${result.body.slice(0, 200)}` };
    }

    lastErrorLine = result.status ? `${result.status}: ${result.body}` : result.body;
    if (attempt < WEBHOOK_MAX_ATTEMPTS) {
      const backoff = Math.round(WEBHOOK_RETRY_BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random()));
      logger.warn(
        `[Usage] Webhook attempt ${attempt}/${WEBHOOK_MAX_ATTEMPTS} failed (${lastErrorLine.slice(0, 160)}); retry in ${backoff}ms`
      );
      await sleep(backoff);
    }
  }

  logger.error(`[Usage] Webhook gave up after ${WEBHOOK_MAX_ATTEMPTS} attempts: ${lastErrorLine.slice(0, 240)}`);
  return { status: "error", response: lastErrorLine.slice(0, 500) };
}

// ===== Main API =====

/**
 * Record usage after an AI call completes.
 * Calculates cost from Model table, saves to UsageLog, fires webhook.
 */
export async function recordUsage(record: UsageRecord): Promise<RecordUsageResult> {
  const cost = await calculateCost(
    record.providerId,
    record.modelId,
    record.inputTokens,
    record.outputTokens
  );

  const usageLog = await prisma.usageLog.create({
    data: {
      userId: record.userId,
      projectId: record.projectId,
      sessionId: record.sessionId,
      providerId: record.providerId,
      modelId: record.modelId,
      role: record.role,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      inputCostUsd: new Decimal(cost.inputCostUsd.toFixed(6)),
      outputCostUsd: new Decimal(cost.outputCostUsd.toFixed(6)),
      totalCostUsd: new Decimal(cost.totalCostUsd.toFixed(6)),
      webhookStatus: "pending",
    },
  });

  logger.info(
    `[Usage] ${record.providerId}/${record.modelId}: ${record.inputTokens}in/${record.outputTokens}out = $${cost.totalCostUsd.toFixed(6)}`
  );

  // Fire webhook async (don't block the response)
  const webhookPayload: WebhookPayload = {
    event: "usage.recorded",
    usageId: usageLog.id,
    userId: record.userId,
    projectId: record.projectId,
    sessionId: record.sessionId,
    providerId: record.providerId,
    modelId: record.modelId,
    role: record.role,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    inputCostUsd: cost.inputCostUsd,
    outputCostUsd: cost.outputCostUsd,
    totalCostUsd: cost.totalCostUsd,
    timestamp: usageLog.createdAt.toISOString(),
  };

  fireWebhook(webhookPayload).then(async (result) => {
    try {
      await prisma.usageLog.update({
        where: { id: usageLog.id },
        data: {
          webhookStatus: result.status,
          webhookResponse: result.response?.slice(0, 1000),
        },
      });
    } catch (e) {
      logger.error(`[Usage] Failed to update webhook status: ${e}`);
    }
  });

  return { id: usageLog.id, cost, webhookStatus: "pending" };
}

// ===== Legacy compatibility =====

/**
 * Estimate token count from input text.
 */
export function estimateTokens(input: string): number {
  const japaneseChars = (input.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  const isJapanese = japaneseChars > input.length * 0.3;
  const charsPerToken = isJapanese ? 2 : 4;
  const inputTokens = Math.ceil(input.length / charsPerToken);
  return inputTokens + Math.ceil(inputTokens * 1.5);
}

/**
 * @deprecated Use recordUsage() instead. Kept for backward compatibility.
 */
export async function checkCredits(
  _userId: string,
  _estimatedTokens?: number
): Promise<null> {
  return null;
}

/**
 * @deprecated Use recordUsage() instead. Kept for backward compatibility.
 */
export async function consumeCredits(
  _userId: string,
  _tokensUsed: number,
  _model: string,
  _provider: string,
  _requestId?: string
): Promise<null> {
  return null;
}
