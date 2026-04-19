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

async function fireWebhook(payload: WebhookPayload): Promise<{ status: string; response?: string }> {
  if (!WEBHOOK_URL) {
    return { status: "skipped", response: "No USAGE_WEBHOOK_URL configured" };
  }

  try {
    // If URL contains /functions/ (Supabase Edge Function), use as-is; otherwise append path
    const url = WEBHOOK_URL.includes("/functions/")
      ? WEBHOOK_URL
      : `${WEBHOOK_URL}/api/webhook/usage`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WEBHOOK_SECRET ? { Authorization: `Bearer ${WEBHOOK_SECRET}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    const body = await res.text().catch(() => "");

    if (!res.ok) {
      logger.warn(`[Usage] Webhook failed: ${res.status} ${body.slice(0, 200)}`);
      return { status: "failed", response: `${res.status}: ${body.slice(0, 200)}` };
    }

    return { status: "sent", response: body.slice(0, 500) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[Usage] Webhook error: ${msg}`);
    return { status: "error", response: msg };
  }
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
