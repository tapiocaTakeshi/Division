/**
 * Model Discovery & Sync Test
 *
 * Lists all available models from each provider API, then optionally syncs to DB.
 *
 * Usage:
 *   # List models from all providers with available API keys
 *   DATABASE_URL="file:./dev.db" GOOGLE_API_KEY=xxx OPENAI_API_KEY=xxx npx ts-node tests/test-sync.ts
 *
 *   # List models from a specific provider only
 *   DATABASE_URL="file:./dev.db" GOOGLE_API_KEY=xxx npx ts-node tests/test-sync.ts google
 *
 *   # List + sync to DB
 *   DATABASE_URL="file:./dev.db" GOOGLE_API_KEY=xxx npx ts-node tests/test-sync.ts --sync
 */

import {
  fetchOpenAIModels,
  fetchAnthropicModels,
  fetchGoogleModels,
  fetchXAIModels,
  fetchDeepSeekModels,
  fetchMistralModels,
  syncModels,
  type DiscoveredModel,
} from "../src/services/sync-models";

// ===== Provider configs =====

interface ProviderConfig {
  name: string;
  envKey: string;
  fetcher: (apiKey: string) => Promise<DiscoveredModel[]>;
}

const PROVIDERS: ProviderConfig[] = [
  { name: "openai", envKey: "OPENAI_API_KEY", fetcher: fetchOpenAIModels },
  { name: "anthropic", envKey: "ANTHROPIC_API_KEY", fetcher: fetchAnthropicModels },
  { name: "google", envKey: "GOOGLE_API_KEY", fetcher: fetchGoogleModels },
  { name: "xai", envKey: "XAI_API_KEY", fetcher: fetchXAIModels },
  { name: "deepseek", envKey: "DEEPSEEK_API_KEY", fetcher: fetchDeepSeekModels },
  { name: "mistral", envKey: "MISTRAL_API_KEY", fetcher: fetchMistralModels },
];

// ===== Formatting helpers =====

function printModels(providerName: string, models: DiscoveredModel[]) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${providerName.toUpperCase()} — ${models.length} models found`);
  console.log(`${"═".repeat(60)}`);

  if (models.length === 0) {
    console.log("  (no models returned)");
    return;
  }

  // Calculate column widths
  const nameWidth = Math.max(30, ...models.map((m) => m.name.length + 2));
  const idWidth = Math.max(30, ...models.map((m) => m.modelId.length + 2));

  // Header
  console.log(
    `  ${"Name".padEnd(nameWidth)} ${"Model ID".padEnd(idWidth)} Description`
  );
  console.log(`  ${"─".repeat(nameWidth)} ${"─".repeat(idWidth)} ${"─".repeat(40)}`);

  // Sort by name
  const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));
  for (const m of sorted) {
    const desc = m.description.length > 60 ? m.description.slice(0, 57) + "..." : m.description;
    console.log(`  ${m.name.padEnd(nameWidth)} ${m.modelId.padEnd(idWidth)} ${desc}`);
  }
}

function printApiKeyStatus() {
  console.log("\n📋 API Key Status:");
  for (const p of PROVIDERS) {
    const key = process.env[p.envKey];
    const status = key ? `✅ set (${key.slice(0, 6)}...)` : "❌ not set";
    console.log(`  ${p.name.padEnd(12)} ${p.envKey.padEnd(22)} ${status}`);
  }
}

// ===== Main =====

async function main() {
  const args = process.argv.slice(2);
  const doSync = args.includes("--sync");
  const filterProvider = args.find((a) => !a.startsWith("--"))?.toLowerCase();

  console.log("🔍 Division — Model Discovery Tool\n");
  printApiKeyStatus();

  // Determine which providers to query
  const targets = filterProvider
    ? PROVIDERS.filter((p) => p.name === filterProvider)
    : PROVIDERS;

  if (filterProvider && targets.length === 0) {
    console.error(
      `\n❌ Unknown provider: "${filterProvider}". Available: ${PROVIDERS.map((p) => p.name).join(", ")}`
    );
    process.exit(1);
  }

  let totalModels = 0;

  for (const provider of targets) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) {
      console.log(`\n⏭️  ${provider.name}: skipped (${provider.envKey} not set)`);
      continue;
    }

    try {
      const models = await provider.fetcher(apiKey);
      printModels(provider.name, models);
      totalModels += models.length;
    } catch (err) {
      console.error(
        `\n❌ ${provider.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  console.log(`\n📊 Total: ${totalModels} models discovered\n`);

  // Optionally sync to DB
  if (doSync) {
    console.log("🔄 Syncing to database...\n");
    const result = await syncModels();
    console.log(`✅ Sync complete:`);
    console.log(`   Discovered: ${result.totalDiscovered}`);
    console.log(`   Added:      ${result.totalAdded}`);
    console.log(`   Updated:    ${result.totalUpdated}`);
    console.log();
    for (const p of result.providers) {
      if (p.error) {
        console.log(`   ⚠️  ${p.provider}: ${p.error}`);
      } else {
        console.log(
          `   ✅ ${p.provider}: ${p.discovered} found, ${p.added} new, ${p.updated} updated`
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
