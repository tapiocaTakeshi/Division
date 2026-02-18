/**
 * API Key Resolver
 *
 * Centralised logic for resolving provider API keys.
 * Used by generate, orchestrator, and task-create routes to avoid
 * duplicated (and divergent) ENV_KEY_MAP / alias definitions.
 */

/** Maps provider apiType to the corresponding environment variable name. */
export const ENV_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  meta: "META_API_KEY",
  qwen: "QWEN_API_KEY",
  cohere: "COHERE_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
};

/**
 * Common aliases users might use when passing API keys in the request body.
 * e.g. { "claude": "sk-ant-..." } should resolve for apiType "anthropic".
 */
export const API_KEY_ALIASES: Record<string, string[]> = {
  anthropic: ["anthropic", "claude", "ANTHROPIC_API_KEY"],
  google: ["google", "gemini", "GOOGLE_API_KEY"],
  openai: ["openai", "gpt", "OPENAI_API_KEY"],
  perplexity: ["perplexity", "PERPLEXITY_API_KEY"],
  xai: ["xai", "grok", "XAI_API_KEY"],
  deepseek: ["deepseek", "DEEPSEEK_API_KEY"],
  mistral: ["mistral", "MISTRAL_API_KEY"],
  meta: ["meta", "llama", "META_API_KEY"],
  qwen: ["qwen", "QWEN_API_KEY"],
  cohere: ["cohere", "COHERE_API_KEY"],
  moonshot: ["moonshot", "MOONSHOT_API_KEY"],
};

/**
 * Resolve the API key for a given provider.
 *
 * Resolution order:
 *   1. When `authenticated` is true (valid Division API key or Clerk session),
 *      check server-side environment variables first.
 *   2. Fall back to user-supplied `apiKeys` from the request body, matched by:
 *      a) provider name (e.g. "claude-sonnet-4-20250514")
 *      b) apiType aliases (e.g. "claude", "anthropic", "ANTHROPIC_API_KEY")
 *
 * @param providerName  The provider's unique name (from DB)
 * @param apiType       The provider's apiType (e.g. "anthropic", "openai")
 * @param apiKeys       User-supplied API keys from the request body
 * @param authenticated Whether the request is authenticated
 */
export function resolveApiKey(
  providerName: string,
  apiType: string,
  apiKeys?: Record<string, string>,
  authenticated?: boolean
): string | undefined {
  // 1. Check environment variables only when authenticated
  if (authenticated) {
    const envVar = ENV_KEY_MAP[apiType];
    if (envVar && process.env[envVar]) {
      return process.env[envVar];
    }
  }

  // 2. Fall back to user-supplied apiKeys from request
  if (apiKeys) {
    // Direct match by provider name
    if (apiKeys[providerName]) return apiKeys[providerName];

    // Direct match by apiType
    if (apiKeys[apiType]) return apiKeys[apiType];

    // Look up by apiType aliases
    const aliases = API_KEY_ALIASES[apiType] || [];
    for (const alias of aliases) {
      if (apiKeys[alias]) return apiKeys[alias];
    }

    // Last resort: match by env var name key (e.g. apiKeys["ANTHROPIC_API_KEY"])
    const envVar = ENV_KEY_MAP[apiType];
    if (envVar && apiKeys[envVar]) return apiKeys[envVar];
  }

  return undefined;
}
