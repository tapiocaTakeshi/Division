/**
 * Credit Service
 *
 * Handles credit check and consumption by calling the division-hp
 * (division.he-ro.jp) credit API endpoints.
 *
 * Flow:
 *   1. Before AI request → POST /api/credits/check  (残高確認)
 *   2. After AI request  → POST /api/credits/consume (クレジット消費)
 */

import { logger } from "../utils/logger";

const CREDIT_API_BASE =
  process.env.CREDIT_API_URL || "https://division.he-ro.jp";
const WEBHOOK_SECRET =
  process.env.DIVISION_WEBHOOK_SECRET || process.env.DIVISION_API_KEY || "";

interface CreditCheckResult {
  userId: string;
  plan: string;
  creditBalance: number;
  canAfford: boolean;
  estimatedCost: number;
}

interface CreditConsumeResult {
  success: boolean;
  creditsConsumed: number;
  remainingBalance: number;
  totalUsed: number;
}

/**
 * Check if a user has enough credits to process a request.
 * Returns null if credit system is not configured or request fails
 * (graceful degradation — don't block requests if credit service is down).
 */
export async function checkCredits(
  userId: string,
  estimatedTokens?: number
): Promise<CreditCheckResult | null> {
  if (!WEBHOOK_SECRET) {
    logger.warn("[Credits] DIVISION_WEBHOOK_SECRET not set — skipping credit check");
    return null;
  }

  try {
    const res = await fetch(`${CREDIT_API_BASE}/api/credits/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEBHOOK_SECRET}`,
      },
      body: JSON.stringify({ userId, estimatedTokens }),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!res.ok) {
      logger.warn(`[Credits] Check failed: ${res.status} ${res.statusText}`);
      return null;
    }

    return (await res.json()) as CreditCheckResult;
  } catch (err) {
    logger.error("[Credits] Check request failed:", err);
    return null; // Graceful degradation
  }
}

/**
 * Consume credits after a successful AI provider call.
 * Returns null if credit system is not configured or request fails.
 */
export async function consumeCredits(
  userId: string,
  tokensUsed: number,
  model: string,
  provider: string,
  requestId?: string
): Promise<CreditConsumeResult | null> {
  if (!WEBHOOK_SECRET) {
    logger.warn("[Credits] DIVISION_WEBHOOK_SECRET not set — skipping credit consumption");
    return null;
  }

  try {
    const res = await fetch(`${CREDIT_API_BASE}/api/credits/consume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEBHOOK_SECRET}`,
      },
      body: JSON.stringify({
        userId,
        tokensUsed,
        model,
        provider,
        requestId,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      logger.warn(`[Credits] Consume failed: ${res.status}`, errorData);

      // If 402 (insufficient credits), throw to stop processing
      if (res.status === 402) {
        throw new Error(
          `Insufficient credits. Balance: ${(errorData as { currentBalance?: number }).currentBalance ?? 0}, Required: ${(errorData as { required?: number }).required ?? 0}`
        );
      }
      return null;
    }

    const result = (await res.json()) as CreditConsumeResult;
    logger.info(
      `[Credits] Consumed: ${result.creditsConsumed} credits (${tokensUsed} tokens, ${model}), remaining: ${result.remainingBalance}`
    );
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Insufficient credits")) {
      throw err; // Re-throw insufficient credits error
    }
    logger.error("[Credits] Consume request failed:", err);
    return null; // Graceful degradation for network errors
  }
}

/**
 * Estimate token count from input text.
 * Simple heuristic: ~4 chars per token for English, ~2 chars for Japanese.
 * Multiply by 2 for estimated output tokens.
 */
export function estimateTokens(input: string): number {
  // Detect if input is primarily Japanese
  const japaneseChars = (input.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  const isJapanese = japaneseChars > input.length * 0.3;

  const charsPerToken = isJapanese ? 2 : 4;
  const inputTokens = Math.ceil(input.length / charsPerToken);
  // Estimate output as 1.5x input tokens
  const estimatedOutputTokens = Math.ceil(inputTokens * 1.5);

  return inputTokens + estimatedOutputTokens;
}
