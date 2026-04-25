/**
 * Supabase Webhook Trigger (per-request)
 *
 * 全 API 呼び出しごとに `USAGE_WEBHOOK_URL`（Supabase Edge Function）へ
 * `event: "api.invoked"` を fire-and-forget で送信する。
 *
 * - 失敗してもリクエスト本体には影響を与えない（ログのみ）。
 * - `Idempotency-Key` を毎回新しい requestId で発行するため、同じリクエストを
 *   2 回叩くと 2 件届く。重複ガードは Edge Function 側に委ねる設計。
 * - `USAGE_WEBHOOK_URL` 未設定時は即 no-op（ローカル開発で .env が無くても動く）。
 */

import { randomUUID } from "crypto";
import { logger } from "../utils/logger";

const WEBHOOK_URL = process.env.USAGE_WEBHOOK_URL || process.env.CREDIT_API_URL || "";
const WEBHOOK_SECRET = process.env.DIVISION_WEBHOOK_SECRET || process.env.DIVISION_API_KEY || "";
const WEBHOOK_TIMEOUT_MS = Number(process.env.USAGE_WEBHOOK_TIMEOUT_MS ?? 5_000);

export interface ApiInvocationEvent {
  event: "api.invoked";
  requestId: string;
  method: string;
  path: string;
  userId?: string;
  authenticated: boolean;
  userAgent?: string;
  ip?: string;
  statusCode?: number;
  timestamp: string;
}

export interface ApiInvocationInput {
  method: string;
  path: string;
  userId?: string;
  authenticated: boolean;
  userAgent?: string;
  ip?: string;
  statusCode?: number;
}

/**
 * Edge Function なら URL をそのまま、ベース URL なら `/api/webhook/usage` を補う。
 * `recordUsage` 側と同じ判定で揃える。
 */
function resolveWebhookUrl(): string | null {
  if (!WEBHOOK_URL) return null;
  return WEBHOOK_URL.includes("/functions/") ? WEBHOOK_URL : `${WEBHOOK_URL}/api/webhook/usage`;
}

/**
 * 1 回だけ POST する。await しないため呼び出し側はブロックされない。
 * エラーは logger.warn に出すだけで投げ直さない。
 */
export function fireApiInvocationWebhook(input: ApiInvocationInput): void {
  const url = resolveWebhookUrl();
  if (!url) return;

  const payload: ApiInvocationEvent = {
    event: "api.invoked",
    requestId: randomUUID(),
    method: input.method,
    path: input.path,
    userId: input.userId,
    authenticated: input.authenticated,
    userAgent: input.userAgent,
    ip: input.ip,
    statusCode: input.statusCode,
    timestamp: new Date().toISOString(),
  };

  void fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": payload.requestId,
      ...(WEBHOOK_SECRET ? { Authorization: `Bearer ${WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  })
    .then((res) => {
      if (!res.ok) {
        logger.warn(
          `[Webhook] api.invoked → ${res.status} for ${payload.method} ${payload.path}`
        );
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Webhook] api.invoked failed for ${payload.method} ${payload.path}: ${msg}`);
    });
}
