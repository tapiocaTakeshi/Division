/**
 * Quick test script for sync-models service.
 * Usage: DATABASE_URL="file:./dev.db" npx ts-node tests/test-sync.ts
 *
 * Tests the sync function with whatever API keys are available.
 * Providers without keys will be gracefully skipped.
 */

import { syncModels } from "../src/services/sync-models";

async function main() {
  console.log("=== Testing Model Sync ===\n");

  // Show which env vars are set
  const keys = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
  ];
  for (const k of keys) {
    console.log(`  ${k}: ${process.env[k] ? "✅ set" : "❌ not set"}`);
  }
  console.log();

  const result = await syncModels();

  console.log("\n=== Sync Result ===");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
