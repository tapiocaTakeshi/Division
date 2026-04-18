/**
 * Model Resolver Service
 *
 * Dynamically resolves the "latest" or "best" model for each provider/apiType
 * by querying the Provider table (populated by sync-models). Replaces hardcoded
 * DEFAULT_MODELS with a live, DB-backed lookup.
 *
 * Ranking heuristic: highest-version flagship model per apiType.
 */

import { prisma } from "../db";

export interface LatestModel {
  apiType: string;
  modelId: string;
  providerName: string;
  displayName: string;
}

// Flagship model name patterns per apiType, ordered by preference (best first).
// The resolver walks this list and picks the first match found in the DB.
const FLAGSHIP_PATTERNS: Record<string, RegExp[]> = {
  openai: [
    /^gpt-5\.4$/,
    /^gpt-5\.4-\d/,
    /^gpt-5\.3$/,
    /^gpt-5\.2$/,
    /^gpt-5\.1$/,
    /^gpt-5$/,
    /^gpt-4\.1$/,
    /^o4-mini$/,
    /^gpt-4o$/,
  ],
  anthropic: [
    /^claude-opus-4-7$/,
    /^claude-opus-4-6$/,
    /^claude-sonnet-4-6$/,
    /^claude-sonnet-4-5/,
    /^claude-opus-4-5/,
    /^claude-opus-4-1/,
    /^claude-haiku-4-5/,
  ],
  google: [
    /^gemini-3\.1-pro-preview$/,
    /^gemini-3-pro-preview$/,
    /^gemini-2\.5-pro$/,
    /^gemini-2\.5-flash$/,
    /^gemini-2\.0-flash$/,
  ],
  xai: [
    /^grok-4\.20-0309-reasoning$/,
    /^grok-4-1-fast-reasoning$/,
    /^grok-4-fast-reasoning$/,
    /^grok-4-0709$/,
    /^grok-3$/,
  ],
  perplexity: [/^sonar-pro$/, /^sonar-deep-research$/, /^sonar$/],
  deepseek: [/^deepseek-reasoner$/, /^deepseek-chat$/],
  mistral: [/^mistral-large-latest$/, /^mistral-medium-latest$/],
};

// In-memory cache: apiType → LatestModel
let latestCache: Map<string, LatestModel> | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearLatestModelCache(): void {
  latestCache = null;
  cacheExpiresAt = 0;
}

/**
 * Resolve the best (latest flagship) model for every apiType.
 * Results are cached in-memory for 5 minutes.
 */
export async function resolveLatestModels(): Promise<Map<string, LatestModel>> {
  const now = Date.now();
  if (latestCache && cacheExpiresAt > now) {
    return latestCache;
  }

  const allProviders = await prisma.provider.findMany({
    where: { isEnabled: true },
    select: { name: true, displayName: true, apiType: true, modelId: true },
  });

  const byApiType = new Map<string, typeof allProviders>();
  for (const p of allProviders) {
    if (!byApiType.has(p.apiType)) byApiType.set(p.apiType, []);
    byApiType.get(p.apiType)!.push(p);
  }

  const result = new Map<string, LatestModel>();

  for (const [apiType, providers] of byApiType) {
    const patterns = FLAGSHIP_PATTERNS[apiType];
    let chosen: (typeof allProviders)[0] | undefined;

    if (patterns) {
      for (const pattern of patterns) {
        chosen = providers.find((p) => pattern.test(p.modelId));
        if (chosen) break;
      }
    }

    if (!chosen && providers.length > 0) {
      chosen = providers[0];
    }

    if (chosen) {
      result.set(apiType, {
        apiType,
        modelId: chosen.modelId,
        providerName: chosen.name,
        displayName: chosen.displayName,
      });
    }
  }

  latestCache = result;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return result;
}

/**
 * Get the latest model ID for a single apiType.
 * Returns the fallback if the apiType is unknown.
 */
export async function getLatestModelId(
  apiType: string,
  fallback?: string
): Promise<string> {
  const map = await resolveLatestModels();
  return map.get(apiType)?.modelId ?? fallback ?? "";
}

/**
 * Return a plain object { apiType: modelId } suitable for JSON responses.
 */
export async function getLatestModelsMap(): Promise<Record<string, LatestModel>> {
  const map = await resolveLatestModels();
  const out: Record<string, LatestModel> = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}
