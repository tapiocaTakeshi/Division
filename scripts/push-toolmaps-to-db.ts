/**
 * Prisma 経由で Provider.toolMap を `provider-native-tool-maps` の内容に同期する。
 * 使い方: npx ts-node --transpile-only -r dotenv/config scripts/push-toolmaps-to-db.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  openAIResponsesToolMap,
  anthropicToolMap,
  googleToolMap,
  openAIChatCompletionsToolMap,
} from "../src/config/provider-native-tool-maps";

const prisma = new PrismaClient();

async function main() {
  const rows: Array<{ id: string; toolMap: object }> = [
    { id: "openai", toolMap: openAIResponsesToolMap },
    { id: "anthropic", toolMap: anthropicToolMap },
    { id: "google", toolMap: googleToolMap },
    { id: "perplexity", toolMap: openAIChatCompletionsToolMap },
    { id: "xai", toolMap: openAIChatCompletionsToolMap },
    { id: "deepseek", toolMap: openAIChatCompletionsToolMap },
  ];

  for (const { id, toolMap } of rows) {
    const r = await prisma.provider.updateMany({
      where: { id },
      data: { toolMap, updatedAt: new Date() },
    });
    // eslint-disable-next-line no-console
    console.log(`Provider ${id}: updated ${r.count} row(s)`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
