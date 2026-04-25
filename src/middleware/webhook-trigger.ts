/**
 * Webhook Trigger Middleware
 *
 * 全 API 呼び出しに対して Supabase webhook (`USAGE_WEBHOOK_URL`) を非同期で叩く。
 *
 * - `res.on("finish")` で発火するので、`divisionAuth` が `res.locals.userId` を
 *   セットした後・レスポンス送信完了後に走る。リクエストの遅延ゼロ。
 * - `/health` と `/debug/*` は監視ノイズになるので除外。
 * - 例外は捕まえてログのみ。webhook 障害で API を落とさない。
 */

import { Request, Response, NextFunction } from "express";
import { fireApiInvocationWebhook } from "../services/webhook-trigger";

/**
 * `/api/webhook` 自体は Supabase からの inbound 受信口なので発火しない。
 * 鳴らすと（webhook が同一 URL を指す環境では）自己ループになる。
 */
const SKIP_PATH_PREFIXES = ["/health", "/debug", "/api/webhook"];

function shouldSkip(path: string): boolean {
  return SKIP_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function webhookTrigger(req: Request, res: Response, next: NextFunction) {
  if (shouldSkip(req.path)) {
    next();
    return;
  }

  res.on("finish", () => {
    try {
      fireApiInvocationWebhook({
        method: req.method,
        path: req.path,
        userId: res.locals.userId,
        authenticated: !!res.locals.authenticated,
        userAgent: req.headers["user-agent"],
        ip: req.ip,
        statusCode: res.statusCode,
      });
    } catch {
      // fire-and-forget: never propagate
    }
  });

  next();
}
