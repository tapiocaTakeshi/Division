/**
 * Model Discovery Test
 *
 * Lists all available models from each provider API in real-time.
 *
 * Usage:
 *   OPENAI_API_KEY=xxx ANTHROPIC_API_KEY=xxx npx ts-node tests/test-sync.ts
 *   GOOGLE_API_KEY=xxx npx ts-node tests/test-sync.ts google
 */

import { listAvailableModels } from "../src/services/sync-models";

async function main() {
  const filterProvider = process.argv[2]?.toLowerCase();

  console.log("🔍 Division — Model Discovery\n");

  const result = await listAvailableModels(filterProvider);

  for (const p of result.providers) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${p.provider.toUpperCase()} (${p.apiType}) — ${p.models.length} models`);
    console.log(`${"═".repeat(60)}`);

    if (p.error) {
      console.log(`  ⚠️  ${p.error}`);
      continue;
    }

    for (const m of p.models) {
      console.log(`  ${m.modelId.padEnd(45)} ${m.displayName}`);
    }
  }

  console.log(`\n📊 Total: ${result.totalModels} models discovered\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
