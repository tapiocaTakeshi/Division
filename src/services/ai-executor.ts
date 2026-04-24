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
    apiEndpoint?: string;
    modelId: string;
    /** Map of tool name -> provider-specific tool definition (passed through to API) */
    toolMap?: unknown;
  };
  config?: Record<string, unknown>;
  input: string;
  role: {
    slug: string;
    name: string;
  };
  mode?: string; // "chat" | "computer_use" | "function_calling"
  /** Override the default system prompt for this request */
  systemPrompt?: string;
  /** Chat history to provide context to the AI (previous user/assistant messages) */
  chatHistory?: ChatMessage[];
  /** Override workspace root for file-search / coder tools (absolute path on the host) */
  workspacePath?: string;
  /**
   * IDE / CLI がローカルで読んだワークスペースのスナップショット（Markdown 等）。
   * 指定時は本番 API はユーザーのディスクを読まず、この内容を一次資料にする（Cursor 系の流れ）。
   */
  localWorkspaceContext?: string;
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

/**
 * If Provider.apiType is wrongly left as "openai" while apiBaseUrl points at another vendor,
 * we would POST OpenAI /v1/responses + body to e.g. api.anthropic.com (404) or perplexity (401).
 * Infer the wire protocol from the host when declared type is openai.
 */
function effectiveApiType(provider: ExecutionRequest["provider"]): string {
  const declared = provider.apiType;
  if (declared !== "openai") return declared;
  const base = (provider.apiBaseUrl || "").toLowerCase();
  if (base.includes("api.anthropic.com") || base.includes("anthropic.com")) return "anthropic";
  if (base.includes("api.perplexity.ai") || base.includes("perplexity.ai")) return "perplexity";
  if (base.includes("generativelanguage.googleapis.com")) return "google";
  if (base.includes("api.x.ai")) return "xai";
  if (base.includes("deepseek.com")) return "deepseek";
  if (base.includes("mistral.ai")) return "mistral";
  if (base.includes("llama.com")) return "meta";
  if (base.includes("dashscope")) return "qwen";
  if (base.includes("cohere.com")) return "cohere";
  if (base.includes("moonshot")) return "moonshot";
  return declared;
}

/** Trim keys so .env / copy-paste whitespace does not break provider auth. */
function normalizeApiKeySegment(raw: string | undefined): string {
  if (raw == null) return "";
  return raw.trim();
}

/**
 * Resolve API key: prefer config, then fall back to environment variable.
 */
function resolveApiKeyFromConfig(
  config: Record<string, unknown> | undefined,
  apiType: string
): string {
  const fromConfig = normalizeApiKeySegment(config?.apiKey as string | undefined);
  if (fromConfig) return fromConfig;
  const envVar = ENV_KEY_MAP[apiType];
  if (envVar) return normalizeApiKeySegment(process.env[envVar]);
  return "";
}

/** Default model IDs per apiType, used when provider.modelId is empty or not set */
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-4-7",
  google: "gemini-2.5-pro",
  openai: "gpt-5.4",
  perplexity: "sonar-pro",
  xai: "grok-4.20-reasoning",
  deepseek: "deepseek-chat",
  mistral: "mistral-3-large-latest",
  meta: "Llama-4-Maverick-17B-128E",
  qwen: "qwen3-235b-a22b",
  cohere: "command-r-plus",
  moonshot: "kimi-k2",
};

/** Default base URLs when provider.apiBaseUrl is empty */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  perplexity: "https://api.perplexity.ai",
  xai: "https://api.x.ai",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai",
  meta: "https://api.llama.com",
  qwen: "https://dashscope-intl.aliyuncs.com",
  cohere: "https://api.cohere.com",
  moonshot: "https://api.moonshot.cn",
};

/** API types that use the OpenAI-compatible chat completions format */
const OPENAI_COMPATIBLE_TYPES: Record<string, string> = {
  /**
   * Perplexity: OpenAI SDK uses POST /chat/completions; Perplexity documents this as an alias
   * of /v1/sonar. Using /chat/completions avoids edge cases with direct /v1/sonar calls.
   */
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
import { executeNativeTool } from "./agent-tools";

/**
 * Convert a provider's toolMap (name -> definition) into the array shape
 * expected by the provider's API. Values are passed through verbatim, so the
 * caller is responsible for storing definitions in the format the target
 * provider expects.
 */
function toolsFromMap(toolMap?: unknown): unknown[] | undefined {
  if (!toolMap || typeof toolMap !== "object" || Array.isArray(toolMap)) {
    return undefined;
  }
  const tools = Object.values(toolMap as Record<string, unknown>).filter(
    (v) => v != null
  );
  return tools.length > 0 ? tools : undefined;
}

/** OpenAI / Gemini: tool `parameters` は JSON Object（JSON Schema）必須。 */
const MINIMAL_PARAMETER_SCHEMA = {
  type: "object" as const,
  properties: {} as Record<string, unknown>,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function ensureJsonObjectParameters(params: unknown): Record<string, unknown> {
  if (isPlainObject(params)) return params as Record<string, unknown>;
  if (typeof params === "string" && params.trim()) {
    try {
      const p = JSON.parse(params) as unknown;
      if (isPlainObject(p)) return p as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return { ...MINIMAL_PARAMETER_SCHEMA };
}

/**
 * Gemini `generateContent`: `tools: [ { function_declarations: [...] } ]`。
 * function_declarations[].parameters も JSON オブジェクト必須。
 */
function normalizeGeminiToolsPayload(tools: unknown[]): unknown[] {
  return tools.map((block) => {
    if (!block || !isPlainObject(block)) return block;
    const b = block as Record<string, unknown>;
    const fd = b.function_declarations;
    if (!Array.isArray(fd)) return block;
    return {
      ...b,
      function_declarations: fd.map((d) => {
        if (!d || !isPlainObject(d)) return d;
        const decl = { ...d } as Record<string, unknown>;
        if (decl.name !== undefined) {
          decl.parameters = ensureJsonObjectParameters(decl.parameters);
        }
        return decl;
      }),
    };
  });
}

function buildGoogleToolsFromMap(toolMap?: unknown): unknown[] | undefined {
  const fromMap = toolsFromMap(toolMap);
  if (!fromMap?.length) return undefined;
  if (
    fromMap.length === 1 &&
    fromMap[0] &&
    typeof fromMap[0] === "object" &&
    !Array.isArray(fromMap[0]) &&
    "function_declarations" in (fromMap[0] as object)
  ) {
    return normalizeGeminiToolsPayload(fromMap);
  }
  const decls: unknown[] = [];
  for (const item of fromMap) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (
      "name" in o &&
      typeof o.name === "string"
    ) {
      decls.push({
        name: o.name,
        description: o.description,
        parameters: o.parameters,
      });
    }
  }
  if (!decls.length) return undefined;
  return normalizeGeminiToolsPayload([{ function_declarations: decls }]);
}

/**
 * OpenAI POST /v1/responses (function tools): flat
 * { type, name, description, parameters }.
 * Chat Completions 形 { type, function: { name, description, parameters } } だと
 * トップに `parameters` が無く 400: "Tool parameters must be a JSON object" になる。
 */
function normalizeOpenAIResponsesTools(tools: unknown[]): unknown[] {
  return tools.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const o = { ...(raw as Record<string, unknown>) };
    if ("kind" in o) {
      if (o.type === undefined && typeof o.kind === "string") {
        o.type = o.kind;
      }
      delete o.kind;
    }
    // ネスト `function: { }`（Chat 互換）を Responses 用フラット形へ
    if (o.type === "function" && o.function && isPlainObject(o.function)) {
      const fn = o.function as Record<string, unknown>;
      if (o.name === undefined) o.name = fn.name;
      if (o.description === undefined) o.description = fn.description;
      o.parameters = o.parameters ?? fn.parameters;
      delete o.function;
    }
    if (o.type === "function") {
      o.parameters = ensureJsonObjectParameters(o.parameters);
    }
    return o;
  });
}

/**
 * Perplexity / xAI / DeepSeek 等: `tools[].function.parameters` も同様に必須。
 */
function normalizeOpenAIChatStyleTools(tools: unknown[]): unknown[] {
  return tools.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const o = { ...(raw as Record<string, unknown>) };
    if (o.type === "function" && o.function && isPlainObject(o.function)) {
      const fn = { ...(o.function as Record<string, unknown>) };
      fn.parameters = ensureJsonObjectParameters(fn.parameters);
      o.function = fn;
    } else if (o.type === "function" && o.name !== undefined) {
      // Responses 用フラット形が混ざった場合は Chat 用に `function` で包む
      o.function = {
        name: o.name,
        description: (o.description as string) ?? "",
        parameters: ensureJsonObjectParameters(o.parameters),
      };
      delete o.name;
      delete o.description;
      delete o.parameters;
    }
    return o;
  });
}

function normalizeAnthropicTools(tools: unknown[]): unknown[] {
  return tools.map((raw) => {
    if (!raw || !isPlainObject(raw)) return raw;
    const o = { ...(raw as Record<string, unknown>) };
    if (o.name !== undefined && typeof o.name === "string") {
      o.input_schema = ensureJsonObjectParameters(
        o.input_schema !== undefined ? o.input_schema : o.parameters
      );
      delete o.parameters;
    }
    return o;
  });
}

/**
 * Build the request body for each API type
 */
function buildRequestBody(
  apiType: string,
  modelId: string,
  input: string,
  systemPrompt: string,
  config?: Record<string, unknown>,
  chatHistory?: ChatMessage[],
  apiEndpoint?: string,
  toolMap?: unknown
): { url: string; headers: Record<string, string>; body: unknown } | null {
  const apiKey = config?.apiKey as string | undefined;
  const maxTokens = (config?.maxTokens as number) || 8192;
  const tools = toolsFromMap(toolMap);

  // Fall back to the default model for this apiType when modelId is not set
  const resolvedModelId = modelId || DEFAULT_MODELS[apiType] || modelId;

  /** Fallback endpoint paths per apiType (used when DB apiEndpoint is empty) */
  const FALLBACK_ENDPOINTS: Record<string, string> = {
    openai: "/v1/responses",
    anthropic: "/v1/messages",
    perplexity: "/chat/completions",
    xai: "/v1/chat/completions",
    deepseek: "/chat/completions",
    mistral: "/v1/chat/completions",
    meta: "/v1/chat/completions",
    qwen: "/compatible-mode/v1/chat/completions",
    cohere: "/v2/chat",
    moonshot: "/v1/chat/completions",
  };

  // Resolve the endpoint: prefer DB value, fall back to hardcoded
  let resolvedEndpoint = apiEndpoint || FALLBACK_ENDPOINTS[apiType] || "";
  if (apiType === "perplexity" && resolvedEndpoint === "/v1/sonar") {
    resolvedEndpoint = "/chat/completions";
  }

  // OpenAI Responses API (/v1/responses)
  if (apiType === "openai") {
    const inputItems: Array<{ role: string; content: string }> = [];
    if (chatHistory?.length) {
      for (const msg of chatHistory) {
        inputItems.push({ role: msg.role, content: msg.content });
      }
    }
    inputItems.push({ role: "user", content: input });
    const openaiTools = tools ? normalizeOpenAIResponsesTools(tools) : undefined;
    return {
      url: resolvedEndpoint,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey || ""}`,
      },
      body: {
        model: resolvedModelId,
        instructions: systemPrompt,
        input: inputItems,
        max_output_tokens: maxTokens,
        ...(openaiTools ? { tools: openaiTools } : {}),
      },
    };
  }

  if (apiType === "anthropic") {
    const messages: Array<{ role: string; content: string }> = [];
    if (chatHistory?.length) {
      for (const msg of chatHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: input });

    /**
     * Extended thinking: adaptive only for Opus 4.7+, Opus 4.6, Sonnet 4.6 (Anthropic docs).
     * Do NOT use /opus-4/ — that matches Opus 4.5 / 4.1 / 4.0 IDs and triggers 400s.
     * Claude Haiku 3.x: omit thinking (not supported like Claude 4 family).
     */
    const omitThinking = /haiku-3-|claude-3-haiku|claude-haiku-3-\d/.test(resolvedModelId);
    const useAdaptive =
      resolvedModelId.startsWith("claude-opus-4-7") ||
      resolvedModelId.startsWith("claude-opus-4-6") ||
      resolvedModelId.startsWith("claude-sonnet-4-6");
    const thinkingConfig = omitThinking
      ? undefined
      : useAdaptive
        ? { type: "adaptive" as const }
        : {
            type: "enabled" as const,
            budget_tokens: Math.min(Math.max(Math.floor(maxTokens * 0.5), 1024), 32768),
          };

    return {
      url: resolvedEndpoint,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey || "",
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: resolvedModelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
        ...(tools ? { tools: normalizeAnthropicTools(tools) } : {}),
      },
    };
  }

  if (apiType === "google") {
    // Google endpoint requires model name interpolation
    const googleEndpoint = resolvedEndpoint.includes("{model}")
      ? resolvedEndpoint.replace("{model}", resolvedModelId)
      : `/v1beta/models/${resolvedModelId}:generateContent`;
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
    const googleTools = buildGoogleToolsFromMap(toolMap);
    return {
      url: googleEndpoint,
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
          thinkingConfig: { thinkingBudget: Math.min(Math.floor(maxTokens * 0.5), 32768) },
        },
        ...(googleTools ? { tools: googleTools } : {}),
      },
    };
  }

  // OpenAI-compatible providers (perplexity, xai, deepseek, etc.)
  if (OPENAI_COMPATIBLE_TYPES[apiType] || resolvedEndpoint) {
    /**
     * Perplexity の /chat/completions は現状 function-calling の `tools` を
     * 受け付けず 400 "Tool parameters must be a JSON object." になる。
     * web 検索は sonar-* モデルが自動で行うため tools 不要 → 送らない。
     */
    const skipTools = apiType === "perplexity";
    const effectiveTools = skipTools ? undefined : tools;
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ];
    if (chatHistory?.length) {
      for (const msg of chatHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: input });
    const tokenField =
      apiType === "perplexity"
        ? { max_tokens: maxTokens }
        : { max_completion_tokens: maxTokens };
    return {
      url: resolvedEndpoint || OPENAI_COMPATIBLE_TYPES[apiType],
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey || ""}`,
      },
      body: {
        model: resolvedModelId,
        ...tokenField,
        messages,
        ...(effectiveTools ? { tools: normalizeOpenAIChatStyleTools(effectiveTools) } : {}),
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

  // OpenAI Responses API: output[].content[].text
  if (apiType === "openai") {
    const output = d.output as Array<{
      type: string;
      content?: Array<{ type: string; text?: string }>;
    }>;
    const textParts: string[] = [];
    if (output) {
      for (const item of output) {
        if (item.type === "message" && item.content) {
          for (const c of item.content) {
            if (c.type === "output_text" && c.text) {
              textParts.push(c.text);
            }
          }
        }
      }
    }
    return {
      output: textParts.join("") || (d as { output_text?: string }).output_text || JSON.stringify(data),
    };
  }

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

    // OpenAI Responses API: event type in "type" field
    if (apiType === "openai") {
      if (parsed.type === "response.output_text.delta" && parsed.delta) {
        return { text: parsed.delta, thinking: null, citations: null };
      }
      return { text: null, thinking: null, citations: null };
    }

    if (apiType === "anthropic") {
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
      const part = parsed.candidates?.[0]?.content?.parts?.[0];
      if (part?.thought === true) {
        return { text: null, thinking: part.text || null, citations: null };
      }
      return { text: part?.text || null, thinking: null, citations: null };
    }

    // OpenAI-compatible (Perplexity, xAI, DeepSeek etc.): choices[0].delta.content
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

// --- Tool permissions per role ---

const FILE_SEARCH_TOOLS = new Set(["read_file", "search_files", "list_directory"]);
const CODER_TOOLS = new Set(["read_file", "write_file", "edit_file", "execute_command", "list_directory", "search_files"]);

// --- Tool loop system prompts ---

const SEARCH_AGENT_PROMPT = `あなたはファイル検索・コード解析エージェントです。
ユーザーのリクエストに答えるため、プロジェクトのファイルシステムから必要な情報を**徹底的に**収集してください。

## 環境
- ユーザーのローカルプロジェクトのファイルシステムにアクセスしています
- TypeScript (.ts/.tsx), JavaScript (.js/.jsx), その他あらゆるソースファイルが存在します
- ワークスペースルートはユーザーのプロジェクトディレクトリです

## 利用可能なツール（読み取り専用）
1. list_directory: {"path": "."} — ディレクトリの内容を一覧表示（まずこれで構造を把握）
2. read_file: {"path": "...", "startLine": N, "endLine": N} — ファイルを読み取り（行範囲指定可。省略時は全行）
3. search_files: {"query": "...", "directory": ".", "include": "*.ts"} — パターンでファイル内を検索

## 手順
1. まず list_directory でプロジェクト構造を把握する
2. 関連しそうなディレクトリを深く掘り下げる（src/, app/, pages/, components/ 等）
3. search_files で関連キーワードを**英語で**検索する（関数名、変数名、import文等）
4. 見つかったファイルを read_file で**全体を**読む（重要なファイルは行範囲を省略して全行読み取る）
5. 関連ファイルが多い場合は、最大ループ回数まで徹底的に調査する
6. 十分な情報が集まったら完了を出力

## 重要
- search_files の query は**英語のコードキーワード**を使ってください（日本語は検索に向きません）
- read_file では可能な限りファイル全体を読んでください（startLine/endLine を省略）
- 1つのファイルだけでなく、関連する複数ファイルを読んでください
- ループ回数に余裕がある限り、できるだけ多くのファイルを調査してください

## 出力形式 — 必ず以下のJSON形式のみ出力:

ツールを使う場合:
\`\`\`json
{
  "tool": "list_directory",
  "args": { "path": "." }
}
\`\`\`

情報収集が完了した場合:
\`\`\`json
{ "done": true }
\`\`\`

ルール:
- 1回のレスポンスで1つのツールのみ
- ツールJSON以外のテキストは出力しない
- まず list_directory で構造を把握してから他のツールを使う`;

const CODER_AGENT_PROMPT_REMOTE = `You are an expert software engineer. You implement code changes and verify them.

## Environment
You are running inside a serverless (Vercel) environment. Key constraints:
- Source files are compiled JavaScript (.js), NOT TypeScript (.ts)
- The filesystem is READ-ONLY except for /tmp/
- Use "ls" instead of "find" to explore directories
- Use write_file to create new files ONLY under /tmp/ (e.g. /tmp/output.html)
- edit_file works only on writable paths (/tmp/)
- For code generation tasks, output the code as your final summary instead of trying to write files to read-only paths

Available tools:
1. read_file: {"path": "...", "startLine": N, "endLine": N} — Read a file to understand the code
2. edit_file: {"path": "...", "old_string": "...", "new_string": "..."} — Replace exact text in a writable file (old_string must be unique)
3. write_file: {"path": "...", "content": "..."} — Create a NEW file (only under /tmp/)
4. execute_command: {"command": "...", "timeout": 30000} — Run a shell command (ls, node, etc.)

Workflow:
1. Read relevant files to understand the existing code
2. Plan your changes
3. Generate the code/changes needed
4. If writing files, use /tmp/ for output
5. Output a clear summary of what was done

Rules:
- ALWAYS read a file before trying to edit it
- old_string must be an EXACT match including whitespace
- Do NOT attempt to write to read-only paths (src/, node_modules/, etc.)
- One tool call per response
- If you cannot modify existing source files, provide the complete code changes in your summary

Output format — always output a single JSON block:
\`\`\`json
{
  "tool": "read_file",
  "args": { "path": "src/index.js" }
}
\`\`\`

When ALL work is complete, output:
\`\`\`json
{ "done": true, "summary": "Brief description of what was done/generated" }
\`\`\``;

const CODER_AGENT_PROMPT_LOCAL = `あなたは優秀なソフトウェアエンジニアです。既存プロジェクトのコードを理解し、修正・追加を行います。

## 重要な原則
- **既存のコードベースを尊重してください**。ゼロからファイルを作り直さないでください。
- まず既存のファイルを読んで構造を理解してから変更を加えてください。
- 他のエージェント（file-searcher等）から提供されたファイル情報を活用してください。

## 利用可能なツール
1. read_file: {"path": "...", "startLine": N, "endLine": N} — ファイルの読み取り
2. edit_file: {"path": "...", "old_string": "...", "new_string": "..."} — 既存ファイルの部分編集（old_stringは一意の完全一致が必要）
3. write_file: {"path": "...", "content": "..."} — 新規ファイルの作成
4. execute_command: {"command": "...", "timeout": 30000} — シェルコマンド実行（ls, npm, node等）
5. list_directory: {"path": "."} — ディレクトリ内容の一覧

## ワークフロー
1. まず list_directory や read_file で既存のプロジェクト構造を把握する
2. 変更対象のファイルを read_file で読む
3. edit_file で既存ファイルを修正する（新規作成より編集を優先）
4. 必要に応じて write_file で新しいファイルを追加する
5. execute_command でビルドやテストを実行して確認する

## ルール
- 編集前に必ず read_file でファイルを読むこと
- old_string は空白やインデントを含めて完全一致させること
- 既存ファイルの編集を優先し、不要な新規作成を避けること
- 1回のレスポンスで1つのツールのみ使用すること

## 出力形式 — 必ず以下のJSON形式のみ出力:

\`\`\`json
{
  "tool": "read_file",
  "args": { "path": "src/app/page.tsx" }
}
\`\`\`

全ての作業が完了したら:
\`\`\`json
{ "done": true, "summary": "変更内容の要約" }
\`\`\``;

function getCoderPrompt(req: ExecutionRequest): string {
  if (req.workspacePath && isWorkspaceAccessible(req.workspacePath)) {
    return CODER_AGENT_PROMPT_LOCAL;
  }
  return CODER_AGENT_PROMPT_REMOTE;
}

function extractToolJson(output: string): Record<string, unknown> | null {
  try {
    const match = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    let jsonStr = match ? match[1].trim() : output.trim();

    if (!jsonStr.startsWith("{")) {
      const firstBrace = jsonStr.indexOf("{");
      const lastBrace = jsonStr.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
      }
    }

    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Check if a workspace path is accessible on this machine.
 */
function isWorkspaceAccessible(ws: string | undefined): boolean {
  if (!ws) return false;
  try {
    const fs = require("fs");
    return fs.existsSync(ws) && fs.statSync(ws).isDirectory();
  } catch {
    return false;
  }
}

async function gatherToolContext(req: ExecutionRequest): Promise<string> {
  const ws = req.workspacePath;
  const canAccessWorkspace = isWorkspaceAccessible(ws);

  // If workspace is not accessible (e.g., API runs on Vercel, path is local),
  // skip tool loop and return the input as-is so the AI responds analytically.
  if (!canAccessWorkspace) {
    logger.info(`[Tool Loop] Workspace not accessible${ws ? ` (${ws})` : " (no workspacePath)"}, skipping tool loop`);
    return req.input;
  }

  let toolContext = `## ファイル検索結果（自動収集）\nワークスペース: ${ws}\n\n`;

  // Step 1: List root directory structure
  logger.info(`[Tool Loop] Auto-listing workspace root (${ws})`);
  const rootListing = await executeNativeTool("list_directory", { path: "." }, ws);
  toolContext += `### ワークスペース構造\n${rootListing}\n\n`;

  const srcListing = await executeNativeTool("list_directory", { path: "src" }, ws);
  if (!srcListing.startsWith("Error:")) {
    toolContext += `### src/ 構造\n${srcListing}\n\n`;
  }

  // Step 2: AI-driven tool loop for deeper exploration
  let loopCount = 0;
  const chatHistory: ChatMessage[] = [];
  let currentInput = `以下のプロジェクト構造を参考に、ユーザーのリクエストに関連するファイルを調査してください。

## プロジェクト構造
${rootListing}
${!srcListing.startsWith("Error:") ? `\n## src/ 構造\n${srcListing}` : ""}

## ユーザーのリクエスト
${req.input}

関連するファイルを list_directory, search_files, read_file で調査してください。
search_files の query にはコード上のキーワード（関数名、変数名、import文等）を英語で指定してください。日本語テキストでの検索は避けてください。`;

  /** Deeper exploration → richer markdown context for file-searcher (was 15). */
  const MAX_LOOPS = 36;
  const apiTypeEff = effectiveApiType(req.provider);

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    const systemPrompt = req.systemPrompt || SEARCH_AGENT_PROMPT;
    const modelId = (req.config?.model as string) || req.provider.modelId;
    const requestSpec = buildRequestBody(
      apiTypeEff,
      modelId,
      currentInput,
      systemPrompt,
      req.config || undefined,
      chatHistory,
      req.provider.apiEndpoint,
      req.provider.toolMap
    );

    if (!requestSpec) break;

    const apiKey = resolveApiKeyFromConfig(req.config, apiTypeEff);
    if (!apiKey) break;

    if (apiTypeEff === "anthropic") {
      requestSpec.headers["x-api-key"] = apiKey;
    } else if (apiTypeEff === "google") {
      requestSpec.headers["x-goog-api-key"] = apiKey;
    } else {
      requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const baseUrl = req.provider.apiBaseUrl || DEFAULT_BASE_URLS[apiTypeEff] || "";
    const fullUrl = `${baseUrl}${requestSpec.url}`;

    let result: { output: string; status: string };
    try {
      const response = await fetch(fullUrl, {
        method: "POST",
        headers: requestSpec.headers,
        body: JSON.stringify(requestSpec.body),
      });
      if (!response.ok) {
        logger.error(`[Tool Loop] API error ${response.status}`);
        break;
      }
      const data = await response.json();
      const parsed = parseResponse(apiTypeEff, data);
      result = { output: parsed.output, status: "success" };
    } catch (err) {
      logger.error("[Tool Loop] Fetch error", err);
      break;
    }

    const parsed = extractToolJson(result.output);
    if (!parsed) {
      logger.warn(`[Tool Loop] Failed to parse tool call (iter ${loopCount}): ${result.output.slice(0, 200)}`);
      break;
    }

    if (parsed.done) break;

    if (parsed.tool && parsed.args) {
      const toolName = parsed.tool as string;

      if (!FILE_SEARCH_TOOLS.has(toolName)) {
        logger.warn(`[Tool Loop] Tool "${toolName}" not allowed`);
        chatHistory.push({ role: "user", content: currentInput });
        chatHistory.push({ role: "assistant", content: result.output });
        currentInput = `Error: Tool "${toolName}" は使えません。使えるツール: ${[...FILE_SEARCH_TOOLS].join(", ")}`;
        continue;
      }

      logger.info(`[Tool Loop] Executing: ${toolName}(${JSON.stringify(parsed.args).slice(0, 100)})`);
      const toolResult = await executeNativeTool(toolName, parsed.args as Record<string, unknown>, ws);

      toolContext += `### ${toolName}\nArgs: ${JSON.stringify(parsed.args)}\nResult:\n${toolResult}\n\n`;

      chatHistory.push({ role: "user", content: currentInput });
      chatHistory.push({ role: "assistant", content: result.output });
      const toolFeedbackCap = 450_000;
      const feedback =
        toolResult.length > toolFeedbackCap ? toolResult.slice(0, toolFeedbackCap) + "\n...[truncated]" : toolResult;
      currentInput = `ツール実行結果 (${toolName}):\n${feedback}\n\n他に調査が必要なら次のツールを指定してください。十分なら {"done": true} を出力してください。`;
    } else {
      break;
    }
  }

  return `${toolContext}\n\n## ユーザーのリクエスト:\n${req.input}`;
}

/**
 * Execute a coder agent loop: read → edit → verify → repeat.
 * Returns the accumulated log of all actions and the final summary.
 */
export async function executeCoderLoop(
  req: ExecutionRequest,
  onLog?: (text: string) => void
): Promise<ExecutionResult> {
  const start = Date.now();
  const MAX_ITERATIONS = 20;
  const logs: string[] = [];

  function log(msg: string) {
    logs.push(msg);
    onLog?.(msg + "\n");
    logger.info(`[Coder] ${msg}`);
  }

  const bundle = (req.localWorkspaceContext || "").trim();
  const chatHistory: ChatMessage[] = [...(req.chatHistory || [])];
  let currentInput = bundle
    ? `## ローカルワークスペーススナップショット（クライアント側で収集・API はディスク非アクセス）\n\n${bundle}\n\n---\n\n${req.input}`
    : req.input;

  log(`Starting coder loop for: ${currentInput.slice(0, 100)}...`);
  let iteration = 0;
  let finalSummary = "";

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    log(`--- Iteration ${iteration}/${MAX_ITERATIONS} ---`);

    const result = await executeTask({
      provider: req.provider,
      config: req.config,
      input: currentInput,
      role: req.role,
      systemPrompt: req.systemPrompt || getCoderPrompt(req),
      chatHistory,
    });

    if (result.status === "error") {
      log(`Error from provider: ${result.errorMsg}`);
      return {
        output: logs.join("\n"),
        durationMs: Date.now() - start,
        status: "error",
        errorMsg: result.errorMsg,
      };
    }

    const parsed = extractToolJson(result.output);
    if (!parsed) {
      log("No tool call detected, treating as final output");
      finalSummary = result.output;
      break;
    }

    if (parsed.done) {
      finalSummary = (parsed.summary as string) || "Changes completed";
      log(`Done: ${finalSummary}`);
      break;
    }

    if (parsed.tool && parsed.args) {
      const toolName = parsed.tool as string;
      const toolArgs = parsed.args as Record<string, unknown>;

      if (!CODER_TOOLS.has(toolName)) {
        log(`Tool "${toolName}" not allowed for coder role`);
        chatHistory.push({ role: "user", content: currentInput });
        chatHistory.push({ role: "assistant", content: result.output });
        currentInput = `Error: Tool "${toolName}" is not available. You can only use: ${[...CODER_TOOLS].join(", ")}. Try again.`;
        continue;
      }

      log(`Tool: ${toolName} → ${JSON.stringify(toolArgs).slice(0, 200)}`);

      const toolResult = await executeNativeTool(toolName, toolArgs, req.workspacePath);
      const truncatedResult = toolResult.length > 40000 ? toolResult.slice(0, 40000) + "\n...[truncated]" : toolResult;
      log(`Result: ${truncatedResult.slice(0, 300)}${truncatedResult.length > 300 ? "..." : ""}`);

      chatHistory.push({ role: "user", content: currentInput });
      chatHistory.push({ role: "assistant", content: result.output });
      currentInput = `Tool "${toolName}" result:\n${truncatedResult}\n\nContinue with the next step. Use another tool or output {"done": true, "summary": "..."} when finished.`;
    } else {
      log("Unrecognized output format, stopping");
      finalSummary = result.output;
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    log(`Reached max iterations (${MAX_ITERATIONS})`);
  }

  const output = `## Coder Agent Results\n\n### Summary\n${finalSummary}\n\n### Execution Log\n${logs.join("\n")}`;

  return {
    output,
    durationMs: Date.now() - start,
    status: "success",
  };
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

  // file-searcher: prefer client-provided snapshot (IDE pattern); else server-side tool loop only if path is on this machine.
  let enrichedInput = req.input;
  if (req.role.slug === "file-searcher") {
    const bundle = (req.localWorkspaceContext || "").trim();
    if (bundle.length > 0) {
      logger.info(
        `[AI Executor] file-searcher: client localWorkspaceContext (${bundle.length} chars), skip server fs`
      );
      enrichedInput = `# ローカルワークスペーススナップショット（IDE / CLI が収集）\n\n${bundle}\n\n---\n\n## 依頼・分析してほしいこと\n\n${req.input}`;
    } else if (isWorkspaceAccessible(req.workspacePath)) {
      logger.info(`[AI Executor] file-searcher: server gatherToolContext, workspacePath=${req.workspacePath}`);
      try {
        enrichedInput = await gatherToolContext(req);
        logger.info(`[AI Executor] gatherToolContext completed, enrichedInput length=${enrichedInput.length}`);
      } catch (err) {
        logger.error("[AI Executor] Error in gatherToolContext", err);
      }
    } else {
      logger.info(
        `[AI Executor] file-searcher: no bundle and no accessible workspacePath; using task input only`
      );
    }
  }

  const systemPrompt =
    req.systemPrompt || `You are acting as the ${req.role.name} (${req.role.slug}) role.`;

  const apiTypeEff = effectiveApiType(req.provider);
  const modelId = (req.config?.model as string) || req.provider.modelId;
  const requestSpec = buildRequestBody(
    apiTypeEff,
    modelId,
    enrichedInput,
    systemPrompt,
    req.config || undefined,
    req.chatHistory,
    req.provider.apiEndpoint,
    req.provider.toolMap
  );

  if (!requestSpec) {
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `Unsupported API type: ${apiTypeEff}`,
    };
  }

  const apiKey = resolveApiKeyFromConfig(req.config, apiTypeEff);
  if (!apiKey) {
    const envVar = ENV_KEY_MAP[apiTypeEff];
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `No API key found for ${req.provider.name} (${apiTypeEff}). Set ${envVar || "the API key"} environment variable or authenticate with a valid Division API key.`,
    };
  }

  // Update headers with the resolved API key
  if (apiTypeEff === "openai") {
    requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (apiTypeEff === "anthropic") {
    requestSpec.headers["x-api-key"] = apiKey;
  } else if (apiTypeEff === "google") {
    requestSpec.headers["x-goog-api-key"] = apiKey;
  } else if (OPENAI_COMPATIBLE_TYPES[apiTypeEff]) {
    requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Enable streaming
  const { url: streamUrl, body: streamBody } = enableStreaming(
    apiTypeEff,
    requestSpec.url,
    requestSpec.body
  );

  try {
    const baseUrl = req.provider.apiBaseUrl || DEFAULT_BASE_URLS[apiTypeEff] || "";
    const fullUrl = `${baseUrl}${streamUrl}`;

    console.log(`\n[API] ──── Stream Request ────`);
    console.log(`[API]  POST ${fullUrl}`);
    console.log(
      `[API]  Provider: ${req.provider.name} (${req.provider.modelId})` +
        (apiTypeEff !== req.provider.apiType ? ` [apiType ${req.provider.apiType}→${apiTypeEff}]` : "")
    );
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

        const chunk = parseStreamChunk(apiTypeEff, data);
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

  let enrichedInput = req.input;
  if (req.role.slug === "file-searcher") {
    const bundle = (req.localWorkspaceContext || "").trim();
    if (bundle.length > 0) {
      logger.info(
        `[AI Executor] file-searcher (non-stream): client localWorkspaceContext (${bundle.length} chars)`
      );
      enrichedInput = `# ローカルワークスペーススナップショット（IDE / CLI が収集）\n\n${bundle}\n\n---\n\n## 依頼・分析してほしいこと\n\n${req.input}`;
    } else if (isWorkspaceAccessible(req.workspacePath)) {
      logger.info(`[AI Executor] file-searcher (non-stream), workspacePath=${req.workspacePath || "(none)"}`);
      try {
        enrichedInput = await gatherToolContext(req);
        logger.info(`[AI Executor] gatherToolContext completed (non-stream), enrichedInput length=${enrichedInput.length}`);
      } catch (err) {
        logger.error("[AI Executor] Error in gatherToolContext (non-stream)", err);
      }
    } else {
      logger.info(`[AI Executor] file-searcher (non-stream): no bundle, no accessible workspace`);
    }
  }

  const systemPrompt =
    req.systemPrompt || `You are acting as the ${req.role.name} (${req.role.slug}) role.`;

  const apiTypeEff = effectiveApiType(req.provider);
  const modelId = (req.config?.model as string) || req.provider.modelId;
  const requestSpec = buildRequestBody(
    apiTypeEff,
    modelId,
    enrichedInput,
    systemPrompt,
    req.config || undefined,
    req.chatHistory,
    req.provider.apiEndpoint,
    req.provider.toolMap
  );

  if (!requestSpec) {
    logger.error(`[AI Executor] Unsupported API type: ${apiTypeEff}`, { provider: req.provider.name });
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `Unsupported API type: ${apiTypeEff}`,
    };
  }

  const apiKey = resolveApiKeyFromConfig(req.config, apiTypeEff);
  if (!apiKey) {
    const envVar = ENV_KEY_MAP[apiTypeEff];
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `No API key found for ${req.provider.name} (${apiTypeEff}). Set ${envVar || "the API key"} environment variable or authenticate with a valid Division API key.`,
    };
  }

  // Update headers with the resolved API key
  if (apiTypeEff === "openai") {
    requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (apiTypeEff === "anthropic") {
    requestSpec.headers["x-api-key"] = apiKey;
  } else if (apiTypeEff === "google") {
    requestSpec.headers["x-goog-api-key"] = apiKey;
  } else if (OPENAI_COMPATIBLE_TYPES[apiTypeEff]) {
    requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const baseUrl = req.provider.apiBaseUrl || DEFAULT_BASE_URLS[apiTypeEff] || "";
    const fullUrl = `${baseUrl}${requestSpec.url}`;

    console.log(`\n[API] ──── Request ────`);
    console.log(`[API]  POST ${fullUrl}`);
    console.log(
      `[API]  Provider: ${req.provider.name} (${req.provider.modelId})` +
        (apiTypeEff !== req.provider.apiType ? ` [apiType ${req.provider.apiType}→${apiTypeEff}]` : "")
    );
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
    const parsed = parseResponse(apiTypeEff, data);
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
