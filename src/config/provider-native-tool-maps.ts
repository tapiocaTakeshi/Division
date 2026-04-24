import type { Prisma } from "@prisma/client";
import { NATIVE_TOOLS } from "../services/agent-tools";

/**
 * DB `Provider.toolMap` の正規化:
 * キーは executeNativeTool 名（read_file 等）に揃え、値は各プロバイダ API が要求する生の定義。
 *
 * - OpenAI Responses: https://platform.openai.com/docs/guides/function-calling (api-mode=responses)
 *   各要素: { type: "function", name, description, parameters }
 * - Anthropic Messages: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
 *   各要素: { name, description, input_schema }
 * - Google Gemini generateContent: https://ai.google.dev/gemini-api/docs/function-calling
 *   1 キーにまとめ、function_declarations 配列（REST: snake_case）
 * - Perplexity / xAI / DeepSeek 等 Chat Completions 互換:
 *   各要素: { type: "function", function: { name, description, parameters } }（NATIVE_TOOLS と同形）
 */

function buildOpenAIResponsesMap(): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const t of NATIVE_TOOLS) {
    const f = t.function;
    map[f.name] = {
      type: "function",
      name: f.name,
      description: f.description,
      parameters: f.parameters,
    };
  }
  return map;
}

function buildAnthropicMap(): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const t of NATIVE_TOOLS) {
    const f = t.function;
    map[f.name] = {
      name: f.name,
      description: f.description,
      input_schema: f.parameters,
    };
  }
  return map;
}

/** 単一の Tool ブロック: generateContent の tools 配列にそのまま入る 1 要素 */
function buildGoogleToolBlock(): { function_declarations: unknown[] } {
  return {
    function_declarations: NATIVE_TOOLS.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  };
}

/**
 * キー 1 つ分だけに全宣言を格納。Object.values 後 = [{ function_declarations: [...] }] → body.tools にそのまま使用可能
 */
function buildGoogleMap(): Record<string, unknown> {
  return {
    division_native_file_tools: buildGoogleToolBlock(),
  };
}

function buildOpenAIChatCompletionsMap(): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const t of NATIVE_TOOLS) {
    const f = t.function;
    map[f.name] = {
      type: "function" as const,
      function: {
        name: f.name,
        description: f.description,
        parameters: f.parameters,
      },
    };
  }
  return map;
}

export const openAIResponsesToolMap: Record<string, unknown> = buildOpenAIResponsesMap();
export const anthropicToolMap: Record<string, unknown> = buildAnthropicMap();
export const googleToolMap: Record<string, unknown> = buildGoogleMap();
export const openAIChatCompletionsToolMap: Record<string, unknown> = buildOpenAIChatCompletionsMap();

export function defaultProviderToolMapForApiType(
  apiType: string
): Prisma.InputJsonValue {
  switch (apiType) {
    case "openai":
      return openAIResponsesToolMap as Prisma.InputJsonValue;
    case "anthropic":
      return anthropicToolMap as Prisma.InputJsonValue;
    case "google":
      return googleToolMap as Prisma.InputJsonValue;
    case "perplexity":
    case "xai":
    case "deepseek":
    case "mistral":
    case "meta":
    case "qwen":
    case "cohere":
    case "moonshot":
      return openAIChatCompletionsToolMap as Prisma.InputJsonValue;
    default:
      return openAIChatCompletionsToolMap as Prisma.InputJsonValue;
  }
}
