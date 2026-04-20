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
 * Resolve API key: prefer config, then fall back to environment variable.
 */
function resolveApiKeyFromConfig(
  config: Record<string, unknown> | undefined,
  apiType: string
): string {
  const fromConfig = (config?.apiKey as string) || "";
  if (fromConfig) return fromConfig;
  const envVar = ENV_KEY_MAP[apiType];
  if (envVar) return process.env[envVar] || "";
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
 * Build the request body for each API type
 */
function buildRequestBody(
  apiType: string,
  modelId: string,
  input: string,
  systemPrompt: string,
  config?: Record<string, unknown>,
  chatHistory?: ChatMessage[],
  apiEndpoint?: string
): { url: string; headers: Record<string, string>; body: unknown } | null {
  const apiKey = config?.apiKey as string | undefined;
  const maxTokens = (config?.maxTokens as number) || 16384;

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
  const resolvedEndpoint = apiEndpoint || FALLBACK_ENDPOINTS[apiType] || "";

  // OpenAI Responses API (/v1/responses)
  if (apiType === "openai") {
    const inputItems: Array<{ role: string; content: string }> = [];
    if (chatHistory?.length) {
      for (const msg of chatHistory) {
        inputItems.push({ role: msg.role, content: msg.content });
      }
    }
    inputItems.push({ role: "user", content: input });
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
        thinking: {
          type: "enabled",
          budget_tokens: Math.min(Math.max(Math.floor(maxTokens * 0.5), 1024), 32768),
        },
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
      },
    };
  }

  // OpenAI-compatible providers (perplexity, xai, deepseek, etc.)
  if (OPENAI_COMPATIBLE_TYPES[apiType] || resolvedEndpoint) {
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
      url: resolvedEndpoint || OPENAI_COMPATIBLE_TYPES[apiType],
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey || ""}`,
      },
      body: {
        model: resolvedModelId,
        max_completion_tokens: maxTokens,
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

// --- Tool loop system prompts ---

// file-search role: read-only tools for exploring the codebase
const FILE_SEARCH_AGENT_PROMPT = `You are a file search and code analysis agent.
Your goal is to explore the codebase, find relevant files, read code, and gather context.

Available tools:
1. read_file: {"path": "...", "startLine": N, "endLine": N} — Read a file with optional line range
2. search_files: {"query": "...", "directory": ".", "include": "*.ts"} — Search for a pattern in files
3. list_directory: {"path": "..."} — List directory contents

Output format — always output a single JSON block:
\`\`\`json
{
  "tool": "read_file",
  "args": { "path": "src/main.ts" }
}
\`\`\`

When you have gathered enough information, output:
\`\`\`json
{ "done": true }
\`\`\`
DO NOT output the final answer. Only output tool JSON or done JSON.`;

const FILE_SEARCH_TOOLS = new Set(["read_file", "search_files", "list_directory"]);

// coder role: file editing and command execution tools
const CODER_AGENT_PROMPT = `You are an expert software engineer. You implement code changes and run commands.

Available tools:
1. edit_file: {"path": "...", "old_string": "...", "new_string": "..."} — Replace exact text in a file (old_string must be unique in the file)
2. write_file: {"path": "...", "content": "..."} — Create a new file or overwrite an existing file
3. execute_command: {"command": "...", "timeout": 30000} — Run a shell command (npm, tsc, git, etc.)
4. read_file: {"path": "...", "startLine": N, "endLine": N} — Read a file to understand current code before editing

Workflow:
1. Read the relevant file(s) to understand current code
2. Use edit_file to make precise changes (preferred over write_file)
3. Run execute_command to verify (e.g. "npx tsc --noEmit", "npm test")
4. Fix any errors and re-verify

Rules:
- Use edit_file for modifying existing files. old_string must be an EXACT unique match (including whitespace/indentation)
- Use write_file ONLY for creating new files
- Always verify changes with execute_command after editing
- If edit_file fails (not unique), include more surrounding context in old_string

Output format — always output a single JSON block:
\`\`\`json
{
  "tool": "edit_file",
  "args": { "path": "src/index.ts", "old_string": "const x = 1;", "new_string": "const x = 2;" }
}
\`\`\`

When ALL changes are complete and verified, output:
\`\`\`json
{ "done": true, "summary": "Brief description of what was changed" }
\`\`\``;

const CODER_TOOLS = new Set(["read_file", "write_file", "edit_file", "execute_command"]);

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

async function gatherToolContext(req: ExecutionRequest): Promise<string> {
  let contextAdded = false;
  let currentInput = req.input;
  let toolContext = "## Tool Results (Context gathered automatically before your generation)\n\n";

  let loopCount = 0;
  const chatHistory = [...(req.chatHistory || [])];

  while (loopCount < 10) {
    loopCount++;
    const result = await executeTask({
      provider: req.provider,
      config: req.config,
      input: currentInput,
      role: req.role,
      systemPrompt: FILE_SEARCH_AGENT_PROMPT,
      chatHistory: chatHistory,
    });

    if (result.status === "error") {
      logger.error("[FileSearch] Provider error: " + (result.errorMsg || "unknown error"));
      break;
    }

    const parsed = extractToolJson(result.output);
    if (!parsed) {
      logger.warn(`[FileSearch] Failed to parse tool call: ${result.output.slice(0, 200)}`);
      break;
    }

    if (parsed.done) break;

    if (parsed.tool && parsed.args) {
      const toolName = parsed.tool as string;

      if (!FILE_SEARCH_TOOLS.has(toolName)) {
        logger.warn(`[FileSearch] Tool "${toolName}" not allowed for file-search role`);
        chatHistory.push({ role: "user", content: currentInput });
        chatHistory.push({ role: "assistant", content: result.output });
        currentInput = `Error: Tool "${toolName}" is not available. You can only use: ${[...FILE_SEARCH_TOOLS].join(", ")}. Try again.`;
        continue;
      }

      logger.info(`[FileSearch] Executing tool ${toolName}`);
      const toolResult = await executeNativeTool(toolName, parsed.args as Record<string, unknown>);

      toolContext += `### Tool: ${toolName}\nArgs: ${JSON.stringify(parsed.args)}\nResult:\n${toolResult}\n\n`;
      contextAdded = true;

      chatHistory.push({ role: "user", content: currentInput });
      chatHistory.push({ role: "assistant", content: result.output });
      currentInput = `Tool Result for ${toolName}:\n${toolResult.slice(0, 15000)}\n\nWhat other tool do you need? (Or output {"done": true})`;
    } else {
      break;
    }
  }

  if (contextAdded) {
    return `${toolContext}\n\n## User Request:\n${req.input}`;
  }
  return req.input;
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

  log(`Starting coder loop for: ${req.input.slice(0, 100)}...`);

  const chatHistory: ChatMessage[] = [...(req.chatHistory || [])];
  let currentInput = req.input;
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
      systemPrompt: req.systemPrompt || CODER_AGENT_PROMPT,
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
        log(`Tool "${toolName}" not allowed for coder role. Allowed: ${[...CODER_TOOLS].join(", ")}`);
        chatHistory.push({ role: "user", content: currentInput });
        chatHistory.push({ role: "assistant", content: result.output });
        currentInput = `Error: Tool "${toolName}" is not available. You can only use: ${[...CODER_TOOLS].join(", ")}. Try again.`;
        continue;
      }

      log(`Tool: ${toolName} → ${JSON.stringify(toolArgs).slice(0, 200)}`);

      const toolResult = await executeNativeTool(toolName, toolArgs);
      const truncatedResult = toolResult.length > 15000 ? toolResult.slice(0, 15000) + "\n...[truncated]" : toolResult;
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

  // For function_calling mode, perform an implicit multi-turn tool calling loop to gather file context
  // before running the final streaming generation.
  let enrichedInput = req.input;
  if (req.mode === "function_calling" || req.role.slug === "search" || req.role.slug === "file-search") {
    try {
      enrichedInput = await gatherToolContext(req);
    } catch (err) {
      logger.error("[AI Executor] Error in gatherToolContext", err);
      // Fallback to original input if tool gathering fails
    }
  }

  const systemPrompt =
    req.systemPrompt || `You are acting as the ${req.role.name} (${req.role.slug}) role.`;

  const modelId = (req.config?.model as string) || req.provider.modelId;
  const requestSpec = buildRequestBody(
    req.provider.apiType,
    modelId,
    enrichedInput,
    systemPrompt,
    req.config || undefined,
    req.chatHistory,
    req.provider.apiEndpoint
  );

  if (!requestSpec) {
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `Unsupported API type: ${req.provider.apiType}`,
    };
  }

  const apiKey = resolveApiKeyFromConfig(req.config, req.provider.apiType);
  if (!apiKey) {
    const envVar = ENV_KEY_MAP[req.provider.apiType];
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `No API key found for ${req.provider.name} (${req.provider.apiType}). Set ${envVar || "the API key"} environment variable or authenticate with a valid Division API key.`,
    };
  }

  // Update headers with the resolved API key
  if (req.provider.apiType === "openai") {
    requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (req.provider.apiType === "anthropic") {
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
    const baseUrl = req.provider.apiBaseUrl || DEFAULT_BASE_URLS[req.provider.apiType] || "";
    const fullUrl = `${baseUrl}${streamUrl}`;

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

  const modelId = (req.config?.model as string) || req.provider.modelId;
  const requestSpec = buildRequestBody(
    req.provider.apiType,
    modelId,
    req.input,
    systemPrompt,
    req.config || undefined,
    req.chatHistory,
    req.provider.apiEndpoint
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

  const apiKey = resolveApiKeyFromConfig(req.config, req.provider.apiType);
  if (!apiKey) {
    const envVar = ENV_KEY_MAP[req.provider.apiType];
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `No API key found for ${req.provider.name} (${req.provider.apiType}). Set ${envVar || "the API key"} environment variable or authenticate with a valid Division API key.`,
    };
  }

  // Update headers with the resolved API key
  if (req.provider.apiType === "openai") {
    requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (req.provider.apiType === "anthropic") {
    requestSpec.headers["x-api-key"] = apiKey;
  } else if (req.provider.apiType === "google") {
    requestSpec.headers["x-goog-api-key"] = apiKey;
  } else if (OPENAI_COMPATIBLE_TYPES[req.provider.apiType]) {
    requestSpec.headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const baseUrl = req.provider.apiBaseUrl || DEFAULT_BASE_URLS[req.provider.apiType] || "";
    const fullUrl = `${baseUrl}${requestSpec.url}`;

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
