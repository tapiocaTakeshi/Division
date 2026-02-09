/**
 * AI Executor Service
 *
 * Abstraction layer that dispatches requests to different AI providers
 * based on their apiType. Calls the actual AI provider APIs using
 * configured API keys (from request or environment variables).
 */

export interface ExecutionRequest {
  provider: {
    name: string;
    apiBaseUrl: string;
    apiType: string;
    modelId: string;
  };
  config?: Record<string, unknown>;
  input: string;
  role: {
    slug: string;
    name: string;
  };
  /** Override the default system prompt for this request */
  systemPrompt?: string;
}

export interface ExecutionResult {
  output: string;
  durationMs: number;
  status: "success" | "error";
  errorMsg?: string;
}

/** Maps apiType to the corresponding environment variable name */
const ENV_KEY_MAP: Record<string, string> = {
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

/** API types that use the OpenAI-compatible chat completions format */
const OPENAI_COMPATIBLE_TYPES: Record<string, string> = {
  openai: "/v1/chat/completions",
  perplexity: "/chat/completions",
  xai: "/v1/chat/completions",
  deepseek: "/chat/completions",
  mistral: "/v1/chat/completions",
  meta: "/v1/chat/completions",
  qwen: "/compatible-mode/v1/chat/completions",
  cohere: "/v2/chat",
  moonshot: "/v1/chat/completions",
};

/**
 * Build the request body for each API type
 */
function buildRequestBody(
  apiType: string,
  modelId: string,
  input: string,
  systemPrompt: string,
  config?: Record<string, unknown>
): { url: string; headers: Record<string, string>; body: unknown } | null {
  const apiKey = config?.apiKey as string | undefined;
  const maxTokens = (config?.maxTokens as number) || 4096;

  if (apiType === "anthropic") {
    return {
      url: "/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey || "",
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: modelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: input }],
      },
    };
  }

  if (apiType === "google") {
    return {
      url: `/v1beta/models/${modelId}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey || "",
      },
      body: {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [{ parts: [{ text: input }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      },
    };
  }

  // OpenAI-compatible providers (openai, perplexity, xai, deepseek)
  const endpoint = OPENAI_COMPATIBLE_TYPES[apiType];
  if (endpoint) {
    return {
      url: endpoint,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey || ""}`,
      },
      body: {
        model: modelId,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
      },
    };
  }

  return null;
}

/**
 * Parse the response from each API type
 */
function parseResponse(apiType: string, data: unknown): string {
  const d = data as Record<string, unknown>;

  if (apiType === "anthropic") {
    const content = d.content as Array<{ type: string; text: string }>;
    return content?.map((c) => c.text).join("") || JSON.stringify(data);
  }

  if (apiType === "google") {
    const candidates = d.candidates as Array<{
      content: { parts: Array<{ text: string }> };
    }>;
    return candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || JSON.stringify(data);
  }

  // OpenAI-compatible providers
  if (OPENAI_COMPATIBLE_TYPES[apiType]) {
    const choices = d.choices as Array<{ message: { content: string } }>;
    return choices?.[0]?.message?.content || JSON.stringify(data);
  }

  return JSON.stringify(data);
}

/**
 * Execute a task by calling the assigned AI provider's API
 */
export async function executeTask(req: ExecutionRequest): Promise<ExecutionResult> {
  const start = Date.now();

  const systemPrompt =
    req.systemPrompt || `You are acting as the ${req.role.name} (${req.role.slug}) role.`;

  const requestSpec = buildRequestBody(
    req.provider.apiType,
    req.provider.modelId,
    req.input,
    systemPrompt,
    req.config || undefined
  );

  if (!requestSpec) {
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `Unsupported API type: ${req.provider.apiType}`,
    };
  }

  // Resolve API key: environment variable > config (request)
  const envVar = ENV_KEY_MAP[req.provider.apiType];
  const apiKey = (envVar ? process.env[envVar] : undefined) || (req.config?.apiKey as string) || "";
  if (!apiKey) {
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `No API key found for ${req.provider.name} (${req.provider.apiType}). Set ${envVar || "the API key"} environment variable.`,
    };
  }

  // Update headers with the resolved API key
  if (req.provider.apiType === "anthropic") {
    requestSpec.headers["x-api-key"] = apiKey;
  } else if (req.provider.apiType === "google") {
    requestSpec.headers["x-goog-api-key"] = apiKey;
  } else if (OPENAI_COMPATIBLE_TYPES[req.provider.apiType]) {
    requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const fullUrl = `${req.provider.apiBaseUrl}${requestSpec.url}`;
    const response = await fetch(fullUrl, {
      method: "POST",
      headers: requestSpec.headers,
      body: JSON.stringify(requestSpec.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        output: "",
        durationMs: Date.now() - start,
        status: "error",
        errorMsg: `API error ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    const output = parseResponse(req.provider.apiType, data);

    return {
      output,
      durationMs: Date.now() - start,
      status: "success",
    };
  } catch (err: unknown) {
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: err instanceof Error ? err.message : String(err),
    };
  }
}
