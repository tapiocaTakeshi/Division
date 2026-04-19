/**
 * Model Sync & Discovery Service
 *
 * Fetches available models from each AI provider's API using the
 * provider's apiBaseUrl from DB + models endpoint path.
 *
 * URL construction:  provider.apiBaseUrl + provider.modelsEndpoint (from DB)
 *   - OpenAI:     apiBaseUrl + /v1/models
 *   - Anthropic:  apiBaseUrl + /v1/models
 *   - Google:     apiBaseUrl + /v1beta/models
 *   - xAI:        apiBaseUrl + /v1/models
 *   - DeepSeek:   apiBaseUrl + /models
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
  endpoint?: string;
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

/** DB Provider record (subset) */
export interface ProviderRecord {
  id: string;
  name: string;
  displayName: string;
  apiBaseUrl: string;
  apiType: string;
  modelsEndpoint?: string;
}

// ===== Fallback Models Endpoint Paths (used when DB modelsEndpoint is empty) =====

const FALLBACK_MODELS_PATH: Record<string, string> = {
  openai: "/v1/models",
  anthropic: "/v1/models",
  google: "/v1beta/models",
  xai: "/v1/models",
  deepseek: "/models",
};

// ===== Env Key Mapping (per provider id) =====

const ENV_KEYS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

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

// ===== OpenAI-compatible Parser =====

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

async function fetchOpenAIModels(baseUrl: string, apiKey: string, modelsPath?: string): Promise<DiscoveredModel[]> {
  interface M { id: string; }
  const url = `${baseUrl}${modelsPath || FALLBACK_MODELS_PATH["openai"]}`;
  const data = await fetchJson<{ data: M[] }>(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return data.data
    .filter((m) => isOpenAIChatModel(m.id))
    .map((m) => ({ modelId: m.id, displayName: m.id }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// ===== Anthropic Parser =====

async function fetchAnthropicModels(baseUrl: string, apiKey: string, modelsPath?: string): Promise<DiscoveredModel[]> {
  interface M { id: string; display_name: string; }
  interface R { data: M[]; has_more: boolean; last_id: string; }

  const all: M[] = [];
  let afterId: string | undefined;
  const endpoint = `${baseUrl}${modelsPath || FALLBACK_MODELS_PATH["anthropic"]}`;

  do {
    const url = afterId
      ? `${endpoint}?limit=100&after_id=${afterId}`
      : `${endpoint}?limit=100`;
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

// ===== Google (Gemini) Parser =====

async function fetchGoogleModels(baseUrl: string, apiKey: string, modelsPath?: string): Promise<DiscoveredModel[]> {
  interface M {
    name: string;
    displayName: string;
    supportedGenerationMethods: string[];
  }
  interface R { models: M[]; nextPageToken?: string; }

  const all: M[] = [];
  let pageToken: string | undefined;
  const endpoint = `${baseUrl}${modelsPath || FALLBACK_MODELS_PATH["google"]}`;

  do {
    const url = pageToken
      ? `${endpoint}?key=${apiKey}&pageSize=100&pageToken=${pageToken}`
      : `${endpoint}?key=${apiKey}&pageSize=100`;
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

// ===== xAI (Grok) Parser =====

async function fetchXAIModels(baseUrl: string, apiKey: string, modelsPath?: string): Promise<DiscoveredModel[]> {
  interface M { id: string; }
  const url = `${baseUrl}${modelsPath || FALLBACK_MODELS_PATH["xai"]}`;
  const data = await fetchJson<{ data: M[] }>(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return data.data
    .filter((m) => m.id.startsWith("grok-"))
    .map((m) => ({ modelId: m.id, displayName: m.id }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// ===== DeepSeek Parser =====

async function fetchDeepSeekModels(baseUrl: string, apiKey: string, modelsPath?: string): Promise<DiscoveredModel[]> {
  interface M { id: string; }
  const url = `${baseUrl}${modelsPath || FALLBACK_MODELS_PATH["deepseek"]}`;
  const data = await fetchJson<{ data: M[] }>(url, {
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

// ===== Fetcher Dispatch (provider.id → fetcher) =====

type Fetcher = (baseUrl: string, apiKey: string, modelsPath?: string) => Promise<DiscoveredModel[]>;

const FETCHER_MAP: Record<string, Fetcher> = {
  openai: fetchOpenAIModels,
  anthropic: fetchAnthropicModels,
  google: fetchGoogleModels,
  xai: fetchXAIModels,
  deepseek: fetchDeepSeekModels,
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

// ===== Core: Fetch models using DB provider record =====

/**
 * Fetch models from a single provider using its apiBaseUrl from DB.
 * URL = provider.apiBaseUrl + provider.modelsEndpoint (fallback to FALLBACK_MODELS_PATH)
 * Results are cached in-memory for 1h.
 */
export async function fetchModelsForProvider(provider: ProviderRecord): Promise<ProviderModels> {
  // Perplexity has no models API
  if (provider.id === "perplexity") {
    return { provider: provider.name, apiType: provider.apiType, models: getPerplexityModels() };
  }

  const now = Date.now();
  const cached = modelCache.get(provider.id);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const fetcher = FETCHER_MAP[provider.id];
  const modelsPath = provider.modelsEndpoint || FALLBACK_MODELS_PATH[provider.id];
  if (!fetcher || !modelsPath) {
    return { provider: provider.name, apiType: provider.apiType, models: [], error: `No models fetcher for provider "${provider.id}"` };
  }

  const envKey = ENV_KEYS[provider.id];
  const apiKey = envKey ? process.env[envKey] : undefined;
  if (!apiKey) {
    return { provider: provider.name, apiType: provider.apiType, models: [], error: `${envKey || "API_KEY"} not set` };
  }

  const endpoint = `${provider.apiBaseUrl}${modelsPath}`;

  try {
    const models = await fetcher(provider.apiBaseUrl, apiKey, modelsPath);
    const result: ProviderModels = { provider: provider.name, apiType: provider.apiType, models, endpoint };
    modelCache.set(provider.id, { data: result, expiresAt: now + CACHE_TTL_MS });
    return result;
  } catch (err) {
    return { provider: provider.name, apiType: provider.apiType, models: [], endpoint, error: err instanceof Error ? err.message : String(err) };
  }
}

// ===== Sync: API → DB =====

/**
 * Fetch models from all provider APIs and upsert into the Model table.
 */
export async function syncModelsToDb(): Promise<SyncResult> {
  const providers = await prisma.provider.findMany({ where: { isEnabled: true } });
  const results: SyncResult["providers"] = [];
  let totalSynced = 0;

  for (const provider of providers) {
    if (provider.id === "perplexity") {
      const models = getPerplexityModels();
      for (const m of models) {
        await prisma.model.upsert({
          where: { providerId_modelId: { providerId: provider.id, modelId: m.modelId } },
          update: { displayName: m.displayName, isEnabled: true, updatedAt: new Date() },
          create: { providerId: provider.id, modelId: m.modelId, displayName: m.displayName },
        });
      }
      totalSynced += models.length;
      results.push({ provider: provider.name, synced: models.length, removed: 0 });
      continue;
    }

    const fetcher = FETCHER_MAP[provider.id];
    if (!fetcher) {
      results.push({ provider: provider.name, synced: 0, removed: 0, error: `No fetcher for ${provider.id}` });
      continue;
    }

    const envKey = ENV_KEYS[provider.id];
    const apiKey = envKey ? process.env[envKey] : undefined;
    if (!apiKey) {
      results.push({ provider: provider.name, synced: 0, removed: 0, error: `${envKey || "API_KEY"} not set` });
      continue;
    }

    try {
      const models = await fetcher(provider.apiBaseUrl, apiKey);
      const apiModelIds = new Set(models.map((m) => m.modelId));

      for (const m of models) {
        await prisma.model.upsert({
          where: { providerId_modelId: { providerId: provider.id, modelId: m.modelId } },
          update: { displayName: m.displayName, isEnabled: true, updatedAt: new Date() },
          create: { providerId: provider.id, modelId: m.modelId, displayName: m.displayName },
        });
      }

      const existing = await prisma.model.findMany({
        where: { providerId: provider.id, isEnabled: true },
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
      results.push({ provider: provider.name, synced: models.length, removed: toDisable.length });
      console.log(`[sync-models] ${provider.name}: ${models.length} synced, ${toDisable.length} disabled`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-models] ${provider.name} failed: ${msg}`);
      results.push({ provider: provider.name, synced: 0, removed: 0, error: msg });
    }
  }

  clearModelCache();
  return { timestamp: new Date().toISOString(), totalSynced, providers: results };
}

// ===== Real-time listing (all providers) =====

/**
 * List available models from all provider APIs (real-time, cached 1h).
 */
export async function listAvailableModels(providerFilter?: string): Promise<ListModelsResult> {
  const providers = await prisma.provider.findMany({ where: { isEnabled: true } });

  if (providerFilter) {
    const lower = providerFilter.toLowerCase();
    const provider = providers.find(
      (p) => p.id === lower || p.apiType === lower || p.name.toLowerCase() === lower
    );
    if (!provider) return { timestamp: new Date().toISOString(), totalModels: 0, providers: [] };
    const result = await fetchModelsForProvider(provider);
    return { timestamp: new Date().toISOString(), totalModels: result.models.length, providers: [result] };
  }

  const results = await Promise.all(providers.map((p) => fetchModelsForProvider(p)));
  const totalModels = results.reduce((sum, r) => sum + r.models.length, 0);
  return { timestamp: new Date().toISOString(), totalModels, providers: results };
}

/**
 * Get available models for a single provider by apiType.
 */
export async function listModelsForProvider(apiType: string): Promise<ProviderModels | null> {
  const provider = await prisma.provider.findFirst({
    where: {
      OR: [
        { id: apiType },
        { apiType },
        { name: { equals: apiType, mode: "insensitive" } },
      ],
    },
  });
  if (!provider) return null;
  return fetchModelsForProvider(provider);
}
