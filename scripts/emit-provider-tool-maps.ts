/**
 * DB 更新用: npx ts-node --transpile-only scripts/emit-provider-tool-maps.ts
 * 出た JSON を Supabase / psql の jsonb 更新に使う
 */
import {
  openAIResponsesToolMap,
  anthropicToolMap,
  googleToolMap,
  openAIChatCompletionsToolMap,
} from "../src/config/provider-native-tool-maps";

const rows: Array<{ id: string; toolMap: object }> = [
  { id: "openai", toolMap: openAIResponsesToolMap },
  { id: "anthropic", toolMap: anthropicToolMap },
  { id: "google", toolMap: googleToolMap },
  { id: "perplexity", toolMap: openAIChatCompletionsToolMap },
  { id: "xai", toolMap: openAIChatCompletionsToolMap },
  { id: "deepseek", toolMap: openAIChatCompletionsToolMap },
];

const TAG = "toolmapjson";

for (const { id, toolMap } of rows) {
  const json = JSON.stringify(toolMap);
  // eslint-disable-next-line no-console
  console.log(`-- ${id}`);
  // eslint-disable-next-line no-console
  console.log(
    `UPDATE "Provider" SET "toolMap" = $${TAG}$${json}$${TAG}$::jsonb, "updatedAt" = NOW() WHERE id = '${id}';`
  );
}
