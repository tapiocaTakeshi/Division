/**
 * Map Supabase–Vercel integration environment variables to the names
 * expected by Prisma and the application code.
 *
 * The Vercel Supabase integration prefixes all variables with the project
 * name (e.g. "division_POSTGRES_URL" instead of "DATABASE_URL").
 * This module bridges the gap so the rest of the codebase can use the
 * standard names.
 *
 * Must be imported before any database or Supabase client usage.
 */

function setIfMissing(target: string, ...sources: string[]) {
  if (process.env[target]) return;
  for (const source of sources) {
    if (process.env[source]) {
      process.env[target] = process.env[source];
      return;
    }
  }
}

// Prisma database URLs
setIfMissing("DATABASE_URL", "division_POSTGRES_PRISMA_URL", "division_POSTGRES_URL");
setIfMissing("DIRECT_URL", "division_POSTGRES_URL_NON_POOLING", "division_POSTGRES_URL");

// Supabase client
setIfMissing("SUPABASE_URL", "division_SUPABASE_URL");
setIfMissing("SUPABASE_SERVICE_ROLE_KEY", "division_SUPABASE_SERVICE_ROLE_KEY");
setIfMissing("SUPABASE_ANON_KEY", "division_SUPABASE_ANON_KEY");

// AI provider API keys (Vercel may store them prefixed with the project name)
setIfMissing("ANTHROPIC_API_KEY", "division_ANTHROPIC_API_KEY");
setIfMissing("OPENAI_API_KEY", "division_OPENAI_API_KEY");
setIfMissing("GOOGLE_API_KEY", "division_GOOGLE_API_KEY");
setIfMissing("PERPLEXITY_API_KEY", "division_PERPLEXITY_API_KEY");
setIfMissing("XAI_API_KEY", "division_XAI_API_KEY");
setIfMissing("DEEPSEEK_API_KEY", "division_DEEPSEEK_API_KEY");
setIfMissing("MISTRAL_API_KEY", "division_MISTRAL_API_KEY");
setIfMissing("META_API_KEY", "division_META_API_KEY");
setIfMissing("QWEN_API_KEY", "division_QWEN_API_KEY");
setIfMissing("COHERE_API_KEY", "division_COHERE_API_KEY");
setIfMissing("MOONSHOT_API_KEY", "division_MOONSHOT_API_KEY");

// Division-specific keys
setIfMissing("DIVISION_API_KEY", "division_DIVISION_API_KEY");
setIfMissing("DIVISION_WEBHOOK_SECRET", "division_DIVISION_WEBHOOK_SECRET");
