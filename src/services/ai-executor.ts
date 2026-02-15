/**
 * AI Executor Service
 *
 * Abstraction layer that dispatches requests to different AI providers
 * based on their apiType. Calls the actual AI provider APIs using
 * configured API keys (from request or environment variables).
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ExecutionRequest {
  provider: {
    name: string;
    displayName: string;
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
  /** Chat history to provide context to the AI (previous user/assistant messages) */
  chatHistory?: ChatMessage[];
}

export interface ExecutionResult {
  output: string;
  durationMs: number;
  status: "success" | "error";
  errorMsg?: string;
  /** Extended thinking / reasoning content from the model (e.g. Claude thinking blocks, Gemini thinking) */
  thinking?: string;
  /** Search citations returned by search-capable models (e.g. Perplexity) */
  citations?: string[];
}

// --- API Logging Helpers ---

function maskApiKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "x-goog-api-key") {
      masked[k] = maskApiKey(v);
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

function truncate(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `... (${text.length} chars)`;
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

import { logger } from "../utils/logger";

/**
 * Build the request body for each API type
 */
function buildRequestBody(
  apiType: string,
  modelId: string,
  input: string,
  systemPrompt: string,
  config?: Record<string, unknown>,
  chatHistory?: ChatMessage[]
): { url: string; headers: Record<string, string>; body: unknown } | null {
  const apiKey = config?.apiKey as string | undefined;
  const maxTokens = (config?.maxTokens as number) || 4096;

  if (apiType === "anthropic") {
    const messages: Array<{ role: string; content: string }> = [];
    if (chatHistory?.length) {
      for (const msg of chatHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: input });
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
        messages,
        thinking: {
          type: "enabled",
          budget_tokens: Math.min(Math.max(Math.floor(maxTokens * 0.6), 1024), 10000),
        },
      },
    };
  }

  if (apiType === "google") {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    if (chatHistory?.length) {
      for (const msg of chatHistory) {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
    }
    contents.push({ role: "user", parts: [{ text: input }] });
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
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingBudget: Math.min(Math.floor(maxTokens * 0.6), 8192) },
        },
      },
    };
  }

  // OpenAI-compatible providers (openai, perplexity, xai, deepseek)
  const endpoint = OPENAI_COMPATIBLE_TYPES[apiType];
  if (endpoint) {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ];
    if (chatHistory?.length) {
      for (const msg of chatHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: input });
    return {
      url: endpoint,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey || ""}`,
      },
      body: {
        model: modelId,
        max_tokens: maxTokens,
        messages,
      },
    };
  }

  return null;
}

interface ParsedResponse {
  output: string;
  thinking?: string;
  citations?: string[];
}

/**
 * Parse the response from each API type, extracting thinking and citations
 */
function parseResponse(apiType: string, data: unknown): ParsedResponse {
  const d = data as Record<string, unknown>;

  if (apiType === "anthropic") {
    const content = d.content as Array<{ type: string; text?: string; thinking?: string }>;
    const thinkingParts = content?.filter((c) => c.type === "thinking").map((c) => c.thinking ?? "");
    const textParts = content?.filter((c) => c.type === "text").map((c) => c.text ?? "");
    return {
      output: textParts?.join("") || JSON.stringify(data),
      thinking: thinkingParts?.length ? thinkingParts.join("") : undefined,
    };
  }

  if (apiType === "google") {
    const candidates = d.candidates as Array<{
      content: { parts: Array<{ text: string; thought?: boolean }> };
    }>;
    const parts = candidates?.[0]?.content?.parts ?? [];
    const thinkingParts = parts.filter((p) => p.thought === true).map((p) => p.text);
    const textParts = parts.filter((p) => p.thought !== true).map((p) => p.text);
    return {
      output: textParts.join("") || JSON.stringify(data),
      thinking: thinkingParts.length ? thinkingParts.join("") : undefined,
    };
  }

  // OpenAI-compatible providers (Perplexity returns citations)
  if (OPENAI_COMPATIBLE_TYPES[apiType]) {
    const choices = d.choices as Array<{ message: { content: string } }>;
    const output = choices?.[0]?.message?.content || JSON.stringify(data);
    const citations = d.citations as string[] | undefined;
    return { output, citations: citations?.length ? citations : undefined };
  }

  return { output: JSON.stringify(data) };
}

/**
 * Enable streaming on the request body for a given API type.
 * Returns the modified body and the SSE endpoint URL (for Google).
 */
function enableStreaming(
  apiType: string,
  url: string,
  body: unknown
): { url: string; body: unknown } {
  if (apiType === "google") {
    // Google uses a different endpoint for streaming
    const streamUrl = url.replace(":generateContent", ":streamGenerateContent") + "?alt=sse";
    return { url: streamUrl, body };
  }
  // Anthropic & OpenAI-compatible: just add stream: true
  return { url, body: { ...(body as Record<string, unknown>), stream: true } };
}

interface StreamChunkResult {
  text: string | null;
  thinking: string | null;
  citations: string[] | null;
}

/**
 * Parse a single SSE chunk and extract the text delta, thinking delta, and citations.
 */
function parseStreamChunk(apiType: string, data: string): StreamChunkResult {
  try {
    const parsed = JSON.parse(data);

    if (apiType === "anthropic") {
      // Anthropic: content_block_delta with delta.text or thinking delta
      if (parsed.type === "content_block_delta") {
        if (parsed.delta?.type === "thinking_delta" && parsed.delta?.thinking) {
          return { text: null, thinking: parsed.delta.thinking, citations: null };
        }
        if (parsed.delta?.text) {
          return { text: parsed.delta.text, thinking: null, citations: null };
        }
      }
      return { text: null, thinking: null, citations: null };
    }

    if (apiType === "google") {
      // Google: candidates[0].content.parts[0].text (with optional thought flag)
      const part = parsed.candidates?.[0]?.content?.parts?.[0];
      if (part?.thought === true) {
        return { text: null, thinking: part.text || null, citations: null };
      }
      return { text: part?.text || null, thinking: null, citations: null };
    }

    // OpenAI-compatible: choices[0].delta.content + citations
    const content = parsed.choices?.[0]?.delta?.content;
    const citations = parsed.citations as string[] | undefined;
    return {
      text: content || null,
      thinking: null,
      citations: citations?.length ? citations : null,
    };
  } catch {
    return { text: null, thinking: null, citations: null };
  }
}

/**
 * Execute a task with streaming, calling onChunk for each text fragment.
 * Optionally calls onThinkingChunk for thinking/reasoning fragments.
 * Returns the full accumulated output when complete.
 */
export async function executeTaskStream(
  req: ExecutionRequest,
  onChunk: (text: string) => void,
  onThinkingChunk?: (text: string) => void
): Promise<ExecutionResult> {
  const start = Date.now();

  const systemPrompt =
    req.systemPrompt || `You are acting as the ${req.role.name} (${req.role.slug}) role.`;

  const requestSpec = buildRequestBody(
    req.provider.apiType,
    req.provider.modelId,
    req.input,
    systemPrompt,
    req.config || undefined,
    req.chatHistory
  );

  if (!requestSpec) {
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `Unsupported API type: ${req.provider.apiType}`,
    };
  }

  // Resolve API key
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

  // Enable streaming
  const { url: streamUrl, body: streamBody } = enableStreaming(
    req.provider.apiType,
    requestSpec.url,
    requestSpec.body
  );

  try {
    const fullUrl = `${req.provider.apiBaseUrl}${streamUrl}`;

    console.log(`\n[API] ──── Stream Request ────`);
    console.log(`[API]  POST ${fullUrl}`);
    console.log(`[API]  Provider: ${req.provider.name} (${req.provider.modelId})`);
    console.log(`[API]  Role: ${req.role.name} (${req.role.slug})`);
    console.log(`[API]  Headers: ${JSON.stringify(maskHeaders(requestSpec.headers))}`);
    console.log(`[API]  Body: ${truncate(JSON.stringify(streamBody), 300)}`);

    const response = await fetch(fullUrl, {
      method: "POST",
      headers: requestSpec.headers,
      body: JSON.stringify(streamBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const durationMs = Date.now() - start;
      console.log(`[API] ──── Stream Response (ERROR) ────`);
      console.log(`[API]  Status: ${response.status} ${response.statusText}`);
      console.log(`[API]  Duration: ${durationMs}ms`);
      console.log(`[API]  Error: ${truncate(errorText, 500)}`);
      return {
        output: "",
        durationMs,
        status: "error",
        errorMsg: `API error ${response.status}: ${errorText}`,
      };
    }

    console.log(`[API]  Stream connected: ${response.status}`);

    if (!response.body) {
      const durationMs = Date.now() - start;
      console.log(`[API]  Stream error: No response body`);
      return {
        output: "",
        durationMs,
        status: "error",
        errorMsg: "No response body for streaming",
      };
    }

    // Read SSE stream
    let accumulated = "";
    let accumulatedThinking = "";
    let lastCitations: string[] | null = null;
    let chunkCount = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        const chunk = parseStreamChunk(req.provider.apiType, data);
        if (chunk.text) {
          accumulated += chunk.text;
          chunkCount++;
          onChunk(chunk.text);
        }
        if (chunk.thinking) {
          accumulatedThinking += chunk.thinking;
          onThinkingChunk?.(chunk.thinking);
        }
        if (chunk.citations) {
          lastCitations = chunk.citations;
        }
      }
    }

    const durationMs = Date.now() - start;
    console.log(`[API] ──── Stream Complete ────`);
    console.log(`[API]  Duration: ${durationMs}ms`);
    console.log(`[API]  Chunks: ${chunkCount}`);
    console.log(`[API]  Output: ${truncate(accumulated, 300)}`);
    if (accumulatedThinking) {
      console.log(`[API]  Thinking: ${truncate(accumulatedThinking, 200)}`);
    }
    if (lastCitations) {
      console.log(`[API]  Citations: ${lastCitations.length} sources`);
    }

    return {
      output: accumulated,
      durationMs,
      status: "success",
      thinking: accumulatedThinking || undefined,
      citations: lastCitations ?? undefined,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    console.log(`[API] ──── Stream (EXCEPTION) ────`);
    console.log(`[API]  Duration: ${durationMs}ms`);
    console.log(`[API]  Error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      output: "",
      durationMs,
      status: "error",
      errorMsg: err instanceof Error ? err.message : String(err),
    };
  }
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
    req.config || undefined,
    req.chatHistory
  );

  if (!requestSpec) {
    logger.error(`[AI Executor] Unsupported API type: ${req.provider.apiType}`, { provider: req.provider.name });
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

    console.log(`\n[API] ──── Request ────`);
    console.log(`[API]  POST ${fullUrl}`);
    console.log(`[API]  Provider: ${req.provider.name} (${req.provider.modelId})`);
    console.log(`[API]  Role: ${req.role.name} (${req.role.slug})`);
    console.log(`[API]  Headers: ${JSON.stringify(maskHeaders(requestSpec.headers))}`);
    console.log(`[API]  Body: ${truncate(JSON.stringify(requestSpec.body), 300)}`);

    const response = await fetch(fullUrl, {
      method: "POST",
      headers: requestSpec.headers,
      body: JSON.stringify(requestSpec.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const durationMs = Date.now() - start;
      console.log(`[API] ──── Response (ERROR) ────`);
      console.log(`[API]  Status: ${response.status} ${response.statusText}`);
      console.log(`[API]  Duration: ${durationMs}ms`);
      console.log(`[API]  Error: ${truncate(errorText, 500)}`);
      return {
        output: "",
        durationMs,
        status: "error",
        errorMsg: `API error ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    const parsed = parseResponse(req.provider.apiType, data);
    const durationMs = Date.now() - start;

    logger.info(`[AI Executor] Success: ${req.provider.displayName} (${durationMs}ms)`, {
      role: req.role.slug,
      provider: req.provider.name,
      durationMs,
    });

    console.log(`[API] ──── Response (OK) ────`);
    console.log(`[API]  Status: ${response.status}`);
    console.log(`[API]  Duration: ${durationMs}ms`);
    console.log(`[API]  Output: ${truncate(parsed.output, 300)}`);
    if (parsed.thinking) {
      console.log(`[API]  Thinking: ${truncate(parsed.thinking, 200)}`);
    }
    if (parsed.citations) {
      console.log(`[API]  Citations: ${parsed.citations.length} sources`);
    }

    return {
      output: parsed.output,
      durationMs,
      status: "success",
      thinking: parsed.thinking,
      citations: parsed.citations,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[AI Executor] Error: ${req.provider.displayName} (${durationMs}ms)`, {
      role: req.role.slug,
      provider: req.provider.name,
      error: errorMsg,
    });
    console.log(`[API] ──── Response (EXCEPTION) ────`);
    console.log(`[API]  Duration: ${durationMs}ms`);
    console.log(`[API]  Error: ${errorMsg}`);
    return {
      output: "",
      durationMs,
      status: "error",
      errorMsg,
    };
  }
}
