/**
 * Provider Resolver
 *
 * `/api/generate` や orchestrator の `overrides` で指定される `provider` 引数は、
 * 旧実装では `Provider.name` の完全一致でしか解決されなかったため、
 * 実際のモデル ID（例: `claude-haiku-4.5`, `gpt-5.4-mini`）を渡すと
 * 404 "Provider not found" で即エラーになっていた。
 *
 * このユーティリティは以下の順で解決を試みる:
 *   1. `Provider.name` の完全一致
 *   2. `Model.modelId` の完全一致（同期された Model 行を経由して Provider を引く）
 *   3. `.` → `-` に正規化した上で 2. を再試行（ユーザーが `claude-haiku-4.5` と書いた場合の救済）
 *   4. 名前の接頭辞から apiType を推定し、同じ apiType の既存 Provider 行を流用して
 *      `modelId` だけ上書きした仮想 Provider を返す
 *
 * どれにもヒットしない場合は `null`。
 */

import { prisma } from "../db";

export type DbProvider = {
  id: string;
  name: string;
  displayName: string;
  apiBaseUrl: string;
  apiType: string;
  apiEndpoint: string;
  modelsEndpoint: string;
  modelId: string;
  description: string | null;
  toolMap: unknown;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * モデル ID の接頭辞から apiType を推定する。DB に対応する Provider 行が無い
 * 新しいモデル名にもフォールバックで対応できるようにするためのマップ。
 */
export function inferApiTypeFromName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (
    lower.startsWith("gpt") ||
    lower.startsWith("chatgpt") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  )
    return "openai";
  if (lower.startsWith("gemini")) return "google";
  if (lower.startsWith("grok")) return "xai";
  if (lower.startsWith("sonar")) return "perplexity";
  if (lower.startsWith("deepseek")) return "deepseek";
  if (lower.startsWith("llama") || lower.startsWith("meta-")) return "meta";
  if (lower.startsWith("qwen")) return "qwen";
  if (lower.startsWith("mistral") || lower.startsWith("codestral")) return "mistral";
  if (lower.startsWith("command")) return "cohere";
  if (lower.startsWith("kimi") || lower.startsWith("moonshot")) return "moonshot";
  return undefined;
}

export async function resolveProvider(rawName: string): Promise<DbProvider | null> {
  const name = (rawName ?? "").trim();
  if (!name) return null;

  const direct = (await prisma.provider.findUnique({ where: { name } })) as DbProvider | null;
  if (direct) return direct;

  const tryModelId = async (modelId: string): Promise<DbProvider | null> => {
    const model = await prisma.model.findFirst({
      where: { modelId, isEnabled: true },
      include: { provider: true },
    });
    if (model?.provider) {
      return { ...(model.provider as unknown as DbProvider), modelId: model.modelId };
    }
    return null;
  };

  /**
   * `claude-haiku-4-5` のような「日付接尾辞なしの alias」を、日付つき実モデル
   * （例: `claude-haiku-4-5-20251001`）にフォールバックさせる。
   * ISO 日付なので modelId の降順ソートで最新版が先頭に来る。
   */
  const tryModelIdPrefix = async (prefix: string): Promise<DbProvider | null> => {
    const model = await prisma.model.findFirst({
      where: { modelId: { startsWith: `${prefix}-` }, isEnabled: true },
      include: { provider: true },
      orderBy: { modelId: "desc" },
    });
    if (model?.provider) {
      return { ...(model.provider as unknown as DbProvider), modelId: model.modelId };
    }
    return null;
  };

  const hit = await tryModelId(name);
  if (hit) return hit;

  const normalized = name.replace(/\./g, "-");
  if (normalized !== name) {
    const hit2 = await tryModelId(normalized);
    if (hit2) return hit2;
  }

  const prefixHit = await tryModelIdPrefix(normalized);
  if (prefixHit) return prefixHit;

  const apiType = inferApiTypeFromName(name);
  if (apiType) {
    const base = (await prisma.provider.findFirst({
      where: { apiType, isEnabled: true },
      orderBy: { createdAt: "asc" },
    })) as DbProvider | null;
    if (base) {
      return { ...base, modelId: normalized };
    }
  }

  return null;
}
