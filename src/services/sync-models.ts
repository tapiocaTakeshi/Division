/**
 * Model Sync & Discovery Service
 *
 * Fetches available models from each AI provider's API and stores
 * them in the Model table. Also provides real-time listing with cache.
 *
 * Supported providers:
 *   - OpenAI:     GET https://api.openai.com/v1/models
 *   - Anthropic:  GET https://api.anthropic.com/v1/models
 *   - Google:     GET https://generativelanguage.googleapis.com/v1beta/models
 *   - xAI:       GET https://api.x.ai/v1/models
 *   - DeepSeek:   GET https://api.deepseek.com/models
 *   - Perplexity: (static list — no public List Models API)
 */

import { prisma } from "../db";

// ===== Types =====

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
}

export interface ProviderModels {
  provider: string;
  apiType: string;
  models: DiscoveredModel[];
  error?: string;
}

export interface ListModelsResult {
  timestamp: string;
  totalModels: number;
  providers: ProviderModels[];
}

export interface SyncResult {
  timestamp: string;
  totalSynced: number;
  providers: { provider: string; synced: number; removed: number; error?: string }[];
}

// ===== Helpers =====

async function fetchJson<T>(
  url: string,
  options: RequestInit,
  timeoutMs: number = 15000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ===== OpenAI =====

const OPENAI_BLACKLIST = [
  "dall-e", "tts-", "whisper", "text-embedding", "text-moderation",
  "babbage", "davinci", "ada", "curie", "ft:", "canary", "realtime",
  "audio", "computer-use", "codex-mini",
];

function isOpenAIChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  const validPrefixes = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];
  if (!validPrefixes.some((p) => lower.startsWith(p))) return false;
  if (OPENAI_BLACKLIST.some((b) => lower.includes(b))) return false;
  return true;
}

async function fetchOpenAIModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface M { id: string; owned_by: string; }
  const data = await fetchJson<{ data: M[] }>("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return data.data
    .filter((m) => isOpenAIChatModel(m.id))
    .map((m) => ({ modelId: m.id, displayName: m.id }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// ===== Anthropic =====

async function fetchAnthropicModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface M { id: string; display_name: string; }
  interface R { data: M[]; has_more: boolean; last_id: string; }

  const all: M[] = [];
  let afterId: string | undefined;

  do {
    const url = afterId
      ? `https://api.anthropic.com/v1/models?limit=100&after_id=${afterId}`
      : "https://api.anthropic.com/v1/models?limit=100";
    const data = await fetchJson<R>(url, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    all.push(...data.data);
    afterId = data.has_more && data.last_id ? data.last_id : undefined;
  } while (afterId);

  return all
    .filter((m) => m.id.startsWith("claude-"))
    .map((m) => ({ modelId: m.id, displayName: m.display_name }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// ===== Google (Gemini) =====

async function fetchGoogleModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface M {
    name: string;
    displayName: string;
    supportedGenerationMethods: string[];
  }
  interface R { models: M[]; nextPageToken?: string; }

  const all: M[] = [];
  let pageToken: string | undefined;

  do {
    const url = pageToken
      ? `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100&pageToken=${pageToken}`
      : `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`;
    const data = await fetchJson<R>(url, {});
    all.push(...data.models);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return all
    .filter(
      (m) =>
        m.supportedGenerationMethods?.includes("generateContent") &&
        !m.name.includes("embedding") &&
        !m.name.includes("aqa") &&
        !m.name.includes("text-") &&
        !m.name.includes("chat-bison") &&
        !m.name.includes("codechat-bison")
    )
    .map((m) => ({
      modelId: m.name.replace("models/", ""),
      displayName: m.displayName,
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// ===== xAI (Grok) =====

async function fetchXAIModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface M { id: string; }
  const data = await fetchJson<{ data: M[] }>("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return data.data
    .filter((m) => m.id.startsWith("grok-"))
    .map((m) => ({ modelId: m.id, displayName: m.id }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// ===== DeepSeek =====

async function fetchDeepSeekModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface M { id: string; }
  const data = await fetchJson<{ data: M[] }>("https://api.deepseek.com/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return data.data
    .filter((m) => m.id.startsWith("deepseek-"))
    .map((m) => ({ modelId: m.id, displayName: m.id }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// ===== Perplexity (static — no List Models API) =====

function getPerplexityModels(): DiscoveredModel[] {
  return [
    { modelId: "sonar", displayName: "Sonar" },
    { modelId: "sonar-pro", displayName: "Sonar Pro" },
    { modelId: "sonar-reasoning", displayName: "Sonar Reasoning" },
    { modelId: "sonar-reasoning-pro", displayName: "Sonar Reasoning Pro" },
    { modelId: "sonar-deep-research", displayName: "Sonar Deep Research" },
    { modelId: "r1-1776", displayName: "R1-1776" },
  ];
}

// ===== Provider Configuration =====

interface ProviderFetchConfig {
  name: string;
  apiType: string;
  envKey: string;
  fetcher: (apiKey: string) => Promise<DiscoveredModel[]>;
}

const PROVIDER_CONFIGS: ProviderFetchConfig[] = [
  { name: "OpenAI", apiType: "openai", envKey: "OPENAI_API_KEY", fetcher: fetchOpenAIModels },
  { name: "Anthropic", apiType: "anthropic", envKey: "ANTHROPIC_API_KEY", fetcher: fetchAnthropicModels },
  { name: "Google", apiType: "google", envKey: "GOOGLE_API_KEY", fetcher: fetchGoogleModels },
  { name: "xAI", apiType: "xai", envKey: "XAI_API_KEY", fetcher: fetchXAIModels },
  { name: "DeepSeek", apiType: "deepseek", envKey: "DEEPSEEK_API_KEY", fetcher: fetchDeepSeekModels },
];

// Provider ID mapping (apiType → DB provider ID)
const PROVIDER_ID_MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  perplexity: "perplexity",
  xai: "xai",
  deepseek: "deepseek",
};

// ===== In-Memory Cache =====

interface CacheEntry {
  data: ProviderModels;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const modelCache = new Map<string, CacheEntry>();

export function clearModelCache(): void {
  modelCache.clear();
}

// ===== Sync: API → DB =====

/**
 * Fetch models from all provider APIs and upsert into the Model table.
 * Removes models that are no longer available from the API.
 */
export async function syncModelsToDb(): Promise<SyncResult> {
  const results: SyncResult["providers"] = [];
  let totalSynced = 0;

  // Sync API-based providers
  for (const config of PROVIDER_CONFIGS) {
    const providerId = PROVIDER_ID_MAP[config.apiType];
    if (!providerId) continue;

    const apiKey = process.env[config.envKey];
    if (!apiKey) {
      results.push({ provider: config.name, synced: 0, removed: 0, error: `${config.envKey} not set` });
      continue;
    }

    try {
      const models = await config.fetcher(apiKey);
      const apiModelIds = new Set(models.map((m) => m.modelId));

      // Upsert all discovered models
      for (const m of models) {
        await prisma.model.upsert({
          where: { providerId_modelId: { providerId, modelId: m.modelId } },
          update: { displayName: m.displayName, isEnabled: true, updatedAt: new Date() },
          create: { providerId, modelId: m.modelId, displayName: m.displayName },
        });
      }

      // Disable models no longer returned by the API
      const existing = await prisma.model.findMany({
        where: { providerId, isEnabled: true },
        select: { id: true, modelId: true },
      });
      const toDisable = existing.filter((e) => !apiModelIds.has(e.modelId));
      if (toDisable.length > 0) {
        await prisma.model.updateMany({
          where: { id: { in: toDisable.map((d) => d.id) } },
          data: { isEnabled: false },
        });
      }

      totalSynced += models.length;
      results.push({ provider: config.name, synced: models.length, removed: toDisable.length });
      console.log(`[sync-models] ${config.name}: ${models.length} synced, ${toDisable.length} disabled`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-models] ${config.name} failed: ${msg}`);
      results.push({ provider: config.name, synced: 0, removed: 0, error: msg });
    }
  }

  // Sync Perplexity (static)
  const perplexityId = PROVIDER_ID_MAP["perplexity"];
  if (perplexityId) {
    const models = getPerplexityModels();
    for (const m of models) {
      await prisma.model.upsert({
        where: { providerId_modelId: { providerId: perplexityId, modelId: m.modelId } },
        update: { displayName: m.displayName, isEnabled: true, updatedAt: new Date() },
        create: { providerId: perplexityId, modelId: m.modelId, displayName: m.displayName },
      });
    }
    totalSynced += models.length;
    results.push({ provider: "Perplexity", synced: models.length, removed: 0 });
  }

  clearModelCache();

  return { timestamp: new Date().toISOString(), totalSynced, providers: results };
}

// ===== Real-time Fetch (with cache) =====

async function fetchProviderModels(config: ProviderFetchConfig): Promise<ProviderModels> {
  const now = Date.now();
  const cached = modelCache.get(config.apiType);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const apiKey = process.env[config.envKey];
  if (!apiKey) {
    return { provider: config.name, apiType: config.apiType, models: [], error: `${config.envKey} not set` };
  }

  try {
    const models = await config.fetcher(apiKey);
    const result: ProviderModels = { provider: config.name, apiType: config.apiType, models };
    modelCache.set(config.apiType, { data: result, expiresAt: now + CACHE_TTL_MS });
    return result;
  } catch (err) {
    return { provider: config.name, apiType: config.apiType, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List available models from all provider APIs (real-time, cached 1h).
 */
export async function listAvailableModels(providerFilter?: string): Promise<ListModelsResult> {
  const perplexityResult: ProviderModels = { provider: "Perplexity", apiType: "perplexity", models: getPerplexityModels() };

  if (providerFilter) {
    const lower = providerFilter.toLowerCase();
    if (lower === "perplexity") {
      return { timestamp: new Date().toISOString(), totalModels: perplexityResult.models.length, providers: [perplexityResult] };
    }
    const config = PROVIDER_CONFIGS.find((c) => c.name.toLowerCase() === lower || c.apiType === lower);
    if (!config) return { timestamp: new Date().toISOString(), totalModels: 0, providers: [] };
    const result = await fetchProviderModels(config);
    return { timestamp: new Date().toISOString(), totalModels: result.models.length, providers: [result] };
  }

  const apiResults = await Promise.all(PROVIDER_CONFIGS.map(fetchProviderModels));
  const allProviders = [...apiResults, perplexityResult];
  const totalModels = allProviders.reduce((sum, p) => sum + p.models.length, 0);
  return { timestamp: new Date().toISOString(), totalModels, providers: allProviders };
}

/**
 * Get available models for a single provider by apiType.
 */
export async function listModelsForProvider(apiType: string): Promise<ProviderModels | null> {
  if (apiType.toLowerCase() === "perplexity") {
    return { provider: "Perplexity", apiType: "perplexity", models: getPerplexityModels() };
  }
  const config = PROVIDER_CONFIGS.find((c) => c.apiType === apiType || c.name.toLowerCase() === apiType.toLowerCase());
  if (!config) return null;
  return fetchProviderModels(config);
}
