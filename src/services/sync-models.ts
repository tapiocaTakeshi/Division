/**
 * Model Sync Service
 *
 * Fetches available models from each AI provider's List Models API
 * and upserts them into the Division database. This keeps the model
 * registry up-to-date automatically.
 *
 * Supported providers (with List Models API):
 *   - OpenAI:    GET https://api.openai.com/v1/models
 *   - Anthropic: GET https://api.anthropic.com/v1/models
 *   - Google:    GET https://generativelanguage.googleapis.com/v1beta/models
 *   - xAI:      GET https://api.x.ai/v1/models
 *   - DeepSeek:  GET https://api.deepseek.com/models
 *   - Mistral:   GET https://api.mistral.ai/v1/models
 *
 * Providers without a List Models API (Perplexity, Meta, Qwen, Cohere, Moonshot)
 * are managed via the static seed.ts file.
 */

import { prisma } from "../db";

// ===== Types =====

export interface DiscoveredModel {
  /** Internal Division name, e.g. "claude-opus-4.6" */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** API base URL for this provider */
  apiBaseUrl: string;
  /** API type key (openai, anthropic, google, xai, deepseek, mistral) */
  apiType: string;
  /** The model ID to pass to the provider API */
  modelId: string;
  /** Auto-generated description */
  description: string;
}

export interface ProviderSyncResult {
  provider: string;
  discovered: number;
  added: number;
  updated: number;
  skipped: number;
  error?: string;
}

export interface SyncResult {
  timestamp: string;
  totalDiscovered: number;
  totalAdded: number;
  totalUpdated: number;
  providers: ProviderSyncResult[];
}

// ===== Helpers =====

/** Convert model ID to a Division-friendly name.
 *  e.g. "claude-opus-4-6" → "claude-opus-4.6"
 *       "gpt-5.2" → "gpt-5.2" (unchanged)
 *       "models/gemini-2.5-flash" → "gemini-2.5-flash"
 */
function modelIdToName(modelId: string): string {
  // Strip Google's "models/" prefix
  let name = modelId.replace(/^models\//, "");
  // Normalize whitespace/special chars
  name = name.toLowerCase().trim();
  return name;
}

/** Safely fetch JSON from a URL with timeout */
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

// ===== OpenAI Fetcher =====

/** Blacklisted prefixes/substrings for OpenAI models */
const OPENAI_BLACKLIST = [
  "dall-e",
  "tts-",
  "whisper",
  "text-embedding",
  "text-moderation",
  "babbage",
  "davinci",
  "ada",
  "curie",
  "ft:",
  "canary",
  "realtime",
  "audio",
  "computer-use",
  "codex-mini", // internal codex variants
];

function isOpenAIChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  // Must start with known prefixes
  const validPrefixes = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];
  if (!validPrefixes.some((p) => lower.startsWith(p))) return false;
  // Must not match blacklist
  if (OPENAI_BLACKLIST.some((b) => lower.includes(b))) return false;
  return true;
}

export async function fetchOpenAIModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface OpenAIModel {
    id: string;
    owned_by: string;
    created: number;
  }
  interface OpenAIResponse {
    data: OpenAIModel[];
  }

  const data = await fetchJson<OpenAIResponse>("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  return data.data
    .filter((m) => isOpenAIChatModel(m.id))
    .map((m) => ({
      name: modelIdToName(m.id),
      displayName: `${m.id} (OpenAI)`,
      apiBaseUrl: "https://api.openai.com",
      apiType: "openai",
      modelId: m.id,
      description: `OpenAI model — owned by ${m.owned_by}`,
    }));
}

// ===== Anthropic Fetcher =====

export async function fetchAnthropicModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface AnthropicModel {
    id: string;
    display_name: string;
    created_at: string;
    type: string;
  }
  interface AnthropicResponse {
    data: AnthropicModel[];
    has_more: boolean;
    last_id: string;
  }

  const allModels: AnthropicModel[] = [];
  let afterId: string | undefined;

  // Paginate through all models
  do {
    const url = afterId
      ? `https://api.anthropic.com/v1/models?limit=100&after_id=${afterId}`
      : "https://api.anthropic.com/v1/models?limit=100";

    const data = await fetchJson<AnthropicResponse>(url, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    allModels.push(...data.data);
    if (data.has_more && data.last_id) {
      afterId = data.last_id;
    } else {
      break;
    }
  } while (true);

  return allModels
    .filter((m) => m.id.startsWith("claude-"))
    .map((m) => {
      // Convert model ID like "claude-opus-4-6" to friendly name "claude-opus-4.6"
      // Pattern: detect version numbers like X-Y at the end and convert to X.Y
      const friendlyName = m.id.replace(
        /(\d+)-(\d+)(?:-(\d{8}))?$/,
        (_, major, minor, date) => (date ? `${major}.${minor}` : `${major}.${minor}`)
      );

      return {
        name: friendlyName,
        displayName: `${m.display_name} (Anthropic)`,
        apiBaseUrl: "https://api.anthropic.com",
        apiType: "anthropic",
        modelId: m.id,
        description: `${m.display_name} — released ${m.created_at.split("T")[0]}`,
      };
    });
}

// ===== Google (Gemini) Fetcher =====

export async function fetchGoogleModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface GoogleModel {
    name: string; // "models/gemini-2.5-flash"
    baseModelId: string;
    displayName: string;
    description: string;
    inputTokenLimit: number;
    outputTokenLimit: number;
    supportedGenerationMethods: string[];
  }
  interface GoogleResponse {
    models: GoogleModel[];
    nextPageToken?: string;
  }

  const allModels: GoogleModel[] = [];
  let pageToken: string | undefined;

  do {
    const url = pageToken
      ? `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100&pageToken=${pageToken}`
      : `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`;

    const data = await fetchJson<GoogleResponse>(url, {});
    allModels.push(...data.models);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allModels
    .filter(
      (m) =>
        // Only models that support generateContent (chat/reasoning)
        m.supportedGenerationMethods?.includes("generateContent") &&
        // Filter out embedding-only, PaLM, and legacy models
        !m.name.includes("embedding") &&
        !m.name.includes("aqa") &&
        !m.name.includes("text-") &&
        !m.name.includes("chat-bison") &&
        !m.name.includes("codechat-bison")
    )
    .map((m) => {
      const modelId = m.name.replace("models/", "");
      return {
        name: modelIdToName(m.name),
        displayName: `${m.displayName} (Google)`,
        apiBaseUrl: "https://generativelanguage.googleapis.com",
        apiType: "google",
        modelId,
        description: m.description
          ? m.description.slice(0, 120)
          : `Google ${m.displayName} — ${m.inputTokenLimit} input tokens`,
      };
    });
}

// ===== xAI (Grok) Fetcher =====

export async function fetchXAIModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface XAIModel {
    id: string;
    owned_by: string;
    created: number;
  }
  interface XAIResponse {
    data: XAIModel[];
  }

  const data = await fetchJson<XAIResponse>("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  return data.data
    .filter((m) => m.id.startsWith("grok-"))
    .map((m) => ({
      name: modelIdToName(m.id),
      displayName: `${m.id} (xAI)`,
      apiBaseUrl: "https://api.x.ai",
      apiType: "xai",
      modelId: m.id,
      description: `xAI Grok model`,
    }));
}

// ===== DeepSeek Fetcher =====

export async function fetchDeepSeekModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface DeepSeekModel {
    id: string;
    owned_by: string;
  }
  interface DeepSeekResponse {
    data: DeepSeekModel[];
  }

  const data = await fetchJson<DeepSeekResponse>("https://api.deepseek.com/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  return data.data
    .filter((m) => m.id.startsWith("deepseek-"))
    .map((m) => ({
      name: modelIdToName(m.id),
      displayName: `${m.id} (DeepSeek)`,
      apiBaseUrl: "https://api.deepseek.com",
      apiType: "deepseek",
      modelId: m.id,
      description: `DeepSeek model`,
    }));
}

// ===== Mistral Fetcher =====

export async function fetchMistralModels(apiKey: string): Promise<DiscoveredModel[]> {
  interface MistralModel {
    id: string;
    owned_by: string;
    created: number;
    name?: string;
    description?: string;
  }
  interface MistralResponse {
    data: MistralModel[];
  }

  const data = await fetchJson<MistralResponse>("https://api.mistral.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  return data.data
    .filter(
      (m) =>
        // Filter out embedding and moderation models
        !m.id.includes("embed") && !m.id.includes("moderation")
    )
    .map((m) => ({
      name: modelIdToName(m.id),
      displayName: `${m.name || m.id} (Mistral AI)`,
      apiBaseUrl: "https://api.mistral.ai",
      apiType: "mistral",
      modelId: m.id,
      description: m.description?.slice(0, 120) || `Mistral AI model`,
    }));
}

// ===== Main Sync Function =====

interface ProviderFetchConfig {
  name: string;
  apiType: string;
  envKey: string;
  fetcher: (apiKey: string) => Promise<DiscoveredModel[]>;
}

const PROVIDER_CONFIGS: ProviderFetchConfig[] = [
  { name: "OpenAI", apiType: "openai", envKey: "OPENAI_API_KEY", fetcher: fetchOpenAIModels },
  {
    name: "Anthropic",
    apiType: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    fetcher: fetchAnthropicModels,
  },
  { name: "Google", apiType: "google", envKey: "GOOGLE_API_KEY", fetcher: fetchGoogleModels },
  { name: "xAI", apiType: "xai", envKey: "XAI_API_KEY", fetcher: fetchXAIModels },
  {
    name: "DeepSeek",
    apiType: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    fetcher: fetchDeepSeekModels,
  },
  {
    name: "Mistral",
    apiType: "mistral",
    envKey: "MISTRAL_API_KEY",
    fetcher: fetchMistralModels,
  },
];

export async function syncModels(): Promise<SyncResult> {
  const results: ProviderSyncResult[] = [];
  let totalDiscovered = 0;
  let totalAdded = 0;
  let totalUpdated = 0;

  for (const config of PROVIDER_CONFIGS) {
    const apiKey = process.env[config.envKey];
    if (!apiKey) {
      results.push({
        provider: config.name,
        discovered: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        error: `${config.envKey} not set — skipped`,
      });
      continue;
    }

    try {
      console.log(`[sync-models] Fetching models from ${config.name}...`);
      const models = await config.fetcher(apiKey);
      let added = 0;
      let updated = 0;
      let skipped = 0;

      for (const model of models) {
        // Check if this model already exists (by name or modelId)
        const existing = await prisma.provider.findFirst({
          where: {
            OR: [{ name: model.name }, { modelId: model.modelId, apiType: model.apiType }],
          },
        });

        if (existing) {
          // Only update modelId if it changed (preserve displayName, description)
          if (existing.modelId !== model.modelId) {
            await prisma.provider.update({
              where: { id: existing.id },
              data: { modelId: model.modelId },
            });
            updated++;
          } else {
            skipped++;
          }
        } else {
          // New model — insert
          await prisma.provider.create({
            data: {
              name: model.name,
              displayName: model.displayName,
              apiBaseUrl: model.apiBaseUrl,
              apiType: model.apiType,
              modelId: model.modelId,
              description: model.description,
            },
          });
          added++;
        }
      }

      totalDiscovered += models.length;
      totalAdded += added;
      totalUpdated += updated;

      results.push({
        provider: config.name,
        discovered: models.length,
        added,
        updated,
        skipped,
      });

      console.log(
        `[sync-models] ${config.name}: ${models.length} discovered, ${added} added, ${updated} updated, ${skipped} unchanged`
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-models] ${config.name} failed: ${errorMsg}`);
      results.push({
        provider: config.name,
        discovered: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        error: errorMsg,
      });
    }
  }

  clearModelCache();

  console.log(
    `[sync-models] Sync complete: ${totalDiscovered} discovered, ${totalAdded} added, ${totalUpdated} updated`
  );

  return {
    timestamp: new Date().toISOString(),
    totalDiscovered,
    totalAdded,
    totalUpdated,
    providers: results,
  };
}

/**
 * Run sync in the background (non-blocking).
 * Logs results but doesn't throw on failure.
 */
export function syncModelsBackground(): void {
  syncModels().catch((err) => {
    console.error("[sync-models] Background sync failed:", err);
  });
}

// ===== In-Memory Cache =====

interface CacheEntry {
  data: ProviderModels;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const modelCache = new Map<string, CacheEntry>();

/** Clear the entire model cache (called after sync) */
export function clearModelCache(): void {
  modelCache.clear();
  console.log("[sync-models] Model cache cleared");
}

// ===== List Available Models (read-only, no DB writes) =====

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
  cached?: boolean;
}

async function fetchProviderModels(config: ProviderFetchConfig): Promise<ProviderModels> {
  const now = Date.now();
  const cached = modelCache.get(config.apiType);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const apiKey = process.env[config.envKey];
  if (!apiKey) {
    return {
      provider: config.name,
      apiType: config.apiType,
      models: [],
      error: `${config.envKey} not set`,
    };
  }

  try {
    const models = await config.fetcher(apiKey);
    const result: ProviderModels = {
      provider: config.name,
      apiType: config.apiType,
      models: models.sort((a, b) => a.name.localeCompare(b.name)),
    };
    modelCache.set(config.apiType, { data: result, expiresAt: now + CACHE_TTL_MS });
    return result;
  } catch (err) {
    return {
      provider: config.name,
      apiType: config.apiType,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Queries all provider APIs and returns the discovered models,
 * grouped by provider. Results are cached per-provider for 1 hour.
 * This is a **read-only** operation — it does NOT write to the database.
 *
 * @param providerFilter - Optional provider name/apiType to fetch from a single provider only
 */
export async function listAvailableModels(
  providerFilter?: string
): Promise<ListModelsResult> {
  const targets = providerFilter
    ? PROVIDER_CONFIGS.filter(
        (c) => c.name.toLowerCase() === providerFilter.toLowerCase() || c.apiType === providerFilter
      )
    : PROVIDER_CONFIGS;

  const providerResults = await Promise.all(targets.map(fetchProviderModels));
  const totalModels = providerResults.reduce((sum, p) => sum + p.models.length, 0);

  return {
    timestamp: new Date().toISOString(),
    totalModels,
    providers: providerResults,
  };
}

/**
 * Get available models for a single provider by apiType.
 * Uses cache, fast for repeated calls.
 */
export async function listModelsForProvider(
  apiType: string
): Promise<ProviderModels | null> {
  const config = PROVIDER_CONFIGS.find(
    (c) => c.apiType === apiType || c.name.toLowerCase() === apiType.toLowerCase()
  );
  if (!config) return null;
  return fetchProviderModels(config);
}
