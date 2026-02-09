import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function upsertProvider(data: {
  name: string;
  displayName: string;
  apiBaseUrl: string;
  apiType: string;
  modelId: string;
  description: string;
}) {
  return prisma.provider.upsert({
    where: { name: data.name },
    update: { modelId: data.modelId, displayName: data.displayName, description: data.description },
    create: data,
  });
}

async function main() {
  // ===== PROVIDERS (model-level granularity) =====

  // --- Anthropic (Claude) ---
  const claudeOpus46 = await upsertProvider({
    name: "claude-opus-4.6",
    displayName: "Claude Opus 4.6 (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-opus-4-20260205",
    description: "Latest & most intelligent Claude — agents & deep reasoning",
  });

  const claudeSonnet45 = await upsertProvider({
    name: "claude-sonnet-4.5",
    displayName: "Claude Sonnet 4.5 (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    description: "Balanced speed & intelligence for coding & writing",
  });

  const claudeHaiku45 = await upsertProvider({
    name: "claude-haiku-4.5",
    displayName: "Claude Haiku 4.5 (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-haiku-4-5-20251015",
    description: "Fastest Claude — near-frontier intelligence, low cost",
  });

  const claudeSonnet = await upsertProvider({
    name: "claude-sonnet",
    displayName: "Claude Sonnet 4 (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    description: "Claude Sonnet 4 — solid coding & writing",
  });

  const claudeOpus = await upsertProvider({
    name: "claude-opus",
    displayName: "Claude Opus 4 (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-opus-4-20250514",
    description: "Claude Opus 4 — powerful deep reasoning",
  });

  const claudeHaiku = await upsertProvider({
    name: "claude-haiku",
    displayName: "Claude Haiku 3 (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-haiku-3-20250414",
    description: "Claude Haiku 3 — fast & lightweight",
  });

  // --- Google (Gemini) ---
  const gemini3Pro = await upsertProvider({
    name: "gemini-3-pro",
    displayName: "Gemini 3 Pro Preview (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-3-pro-preview",
    description: "Latest flagship — complex agentic workflows & coding",
  });

  const gemini3Flash = await upsertProvider({
    name: "gemini-3-flash",
    displayName: "Gemini 3 Flash Preview (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-3-flash-preview",
    description: "Fast frontier-class — visual & spatial reasoning",
  });

  const gemini25Pro = await upsertProvider({
    name: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-2.5-pro",
    description: "Stable — advanced reasoning & 1M context",
  });

  const gemini25Flash = await upsertProvider({
    name: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-2.5-flash",
    description: "Balanced intelligence & latency, controllable thinking",
  });

  const gemini20Flash = await upsertProvider({
    name: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-2.0-flash",
    description: "Fast & efficient general purpose",
  });

  // --- OpenAI (GPT / o-series) ---
  const gpt52 = await upsertProvider({
    name: "gpt-5.2",
    displayName: "GPT-5.2 (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-5.2",
    description: "Latest flagship — deep reasoning, configurable thinking",
  });

  const gpt51 = await upsertProvider({
    name: "gpt-5.1",
    displayName: "GPT-5.1 (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-5.1",
    description: "Flagship reasoning — 400K context, coding & agents",
  });

  const gpt41 = await upsertProvider({
    name: "gpt-4.1",
    displayName: "GPT-4.1 (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-4.1",
    description: "1M context window, improved over GPT-4o",
  });

  const gpt41Mini = await upsertProvider({
    name: "gpt-4.1-mini",
    displayName: "GPT-4.1 Mini (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-4.1-mini",
    description: "Balanced performance, cost-effective",
  });

  const gpt41Nano = await upsertProvider({
    name: "gpt-4.1-nano",
    displayName: "GPT-4.1 Nano (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-4.1-nano",
    description: "Ultra-fast, high-volume, latency-sensitive tasks",
  });

  const gpt4o = await upsertProvider({
    name: "gpt-4o",
    displayName: "GPT-4o (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-4o",
    description: "Multimodal flagship (legacy)",
  });

  const gpt4oMini = await upsertProvider({
    name: "gpt-4o-mini",
    displayName: "GPT-4o Mini (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-4o-mini",
    description: "Fast & affordable (legacy)",
  });

  const o3 = await upsertProvider({
    name: "o3",
    displayName: "o3 (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "o3",
    description: "Advanced reasoning model",
  });

  const o3Mini = await upsertProvider({
    name: "o3-mini",
    displayName: "o3 Mini (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "o3-mini",
    description: "Fast reasoning",
  });

  // --- Perplexity ---
  const perplexityDeepResearch = await upsertProvider({
    name: "perplexity-deep-research",
    displayName: "Perplexity Deep Research",
    apiBaseUrl: "https://api.perplexity.ai",
    apiType: "perplexity",
    modelId: "sonar-deep-research",
    description: "Expert-level exhaustive search & comprehensive reports",
  });

  const perplexityReasoningPro = await upsertProvider({
    name: "perplexity-reasoning-pro",
    displayName: "Perplexity Reasoning Pro",
    apiBaseUrl: "https://api.perplexity.ai",
    apiType: "perplexity",
    modelId: "sonar-reasoning-pro",
    description: "Multi-step reasoning with Chain of Thought",
  });

  const perplexitySonarPro = await upsertProvider({
    name: "perplexity-sonar-pro",
    displayName: "Perplexity Sonar Pro",
    apiBaseUrl: "https://api.perplexity.ai",
    apiType: "perplexity",
    modelId: "sonar-pro",
    description: "Advanced search — complex queries with citations",
  });

  const perplexitySonar = await upsertProvider({
    name: "perplexity-sonar",
    displayName: "Perplexity Sonar",
    apiBaseUrl: "https://api.perplexity.ai",
    apiType: "perplexity",
    modelId: "sonar",
    description: "Lightweight fast search with grounding",
  });

  // --- xAI (Grok) ---
  const grok41Fast = await upsertProvider({
    name: "grok-4.1-fast",
    displayName: "Grok 4.1 Fast (xAI)",
    apiBaseUrl: "https://api.x.ai",
    apiType: "xai",
    modelId: "grok-4.1-fast",
    description: "Best agentic tool-calling — 2M context, low hallucination",
  });

  const grok4 = await upsertProvider({
    name: "grok-4",
    displayName: "Grok 4 (xAI)",
    apiBaseUrl: "https://api.x.ai",
    apiType: "xai",
    modelId: "grok-4",
    description: "Flagship — 256K context, real-time X/web search",
  });

  const grok3 = await upsertProvider({
    name: "grok-3",
    displayName: "Grok 3 (xAI)",
    apiBaseUrl: "https://api.x.ai",
    apiType: "xai",
    modelId: "grok-3",
    description: "Enterprise — data extraction, coding, summarization",
  });

  const grok3Mini = await upsertProvider({
    name: "grok-3-mini",
    displayName: "Grok 3 Mini (xAI)",
    apiBaseUrl: "https://api.x.ai",
    apiType: "xai",
    modelId: "grok-3-mini",
    description: "Cost-efficient fast completions",
  });

  // --- DeepSeek ---
  const deepseekV32 = await upsertProvider({
    name: "deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    apiBaseUrl: "https://api.deepseek.com",
    apiType: "deepseek",
    modelId: "deepseek-chat",
    description: "Reasoning-first — agentic workflows, GPT-5 level",
  });

  const deepseekR1 = await upsertProvider({
    name: "deepseek-r1",
    displayName: "DeepSeek R1",
    apiBaseUrl: "https://api.deepseek.com",
    apiType: "deepseek",
    modelId: "deepseek-reasoner",
    description: "Chain-of-thought reasoning specialist",
  });

  // --- Legacy aliases (backward compatibility) ---
  const claude = await upsertProvider({
    name: "claude",
    displayName: "Claude (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    description: "Alias → Claude Sonnet 4.5",
  });

  const gemini = await upsertProvider({
    name: "gemini",
    displayName: "Gemini (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-2.5-flash",
    description: "Alias → Gemini 2.5 Flash",
  });

  const perplexity = await upsertProvider({
    name: "perplexity",
    displayName: "Perplexity",
    apiBaseUrl: "https://api.perplexity.ai",
    apiType: "perplexity",
    modelId: "sonar-pro",
    description: "Alias → Perplexity Sonar Pro",
  });

  const gpt = await upsertProvider({
    name: "gpt",
    displayName: "GPT (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-4.1",
    description: "Alias → GPT-4.1",
  });

  const grok = await upsertProvider({
    name: "grok",
    displayName: "Grok (xAI)",
    apiBaseUrl: "https://api.x.ai",
    apiType: "xai",
    modelId: "grok-4",
    description: "Alias → Grok 4",
  });

  const deepseek = await upsertProvider({
    name: "deepseek",
    displayName: "DeepSeek",
    apiBaseUrl: "https://api.deepseek.com",
    apiType: "deepseek",
    modelId: "deepseek-chat",
    description: "Alias → DeepSeek V3.2",
  });

  // Also keep old model-level names for backward compat
  await upsertProvider({
    name: "gemini-flash",
    displayName: "Gemini Flash (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-2.5-flash",
    description: "Alias → Gemini 2.5 Flash",
  });

  await upsertProvider({
    name: "gemini-pro",
    displayName: "Gemini Pro (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-2.5-pro",
    description: "Alias → Gemini 2.5 Pro",
  });

  console.log("Providers seeded (30+ models)");

  // ===== ROLES =====
  const coding = await prisma.role.upsert({
    where: { slug: "coding" },
    update: {},
    create: { slug: "coding", name: "Coding", description: "Code generation, debugging, and review" },
  });

  const search = await prisma.role.upsert({
    where: { slug: "search" },
    update: {},
    create: { slug: "search", name: "Search", description: "Web search, research, and information retrieval" },
  });

  const planning = await prisma.role.upsert({
    where: { slug: "planning" },
    update: {},
    create: { slug: "planning", name: "Planning", description: "Project planning, architecture design, and strategy" },
  });

  const writing = await prisma.role.upsert({
    where: { slug: "writing" },
    update: {},
    create: { slug: "writing", name: "Writing", description: "Technical writing, documentation, and content creation" },
  });

  const review = await prisma.role.upsert({
    where: { slug: "review" },
    update: {},
    create: { slug: "review", name: "Review", description: "Code review, quality assurance, and analysis" },
  });

  const leader = await prisma.role.upsert({
    where: { slug: "leader" },
    update: {},
    create: { slug: "leader", name: "Leader", description: "Task decomposition, delegation, and orchestration" },
  });

  console.log("Roles seeded:", [coding, search, planning, writing, review, leader].map((r) => r.slug));

  // ===== DEMO PROJECT =====
  const project = await prisma.project.upsert({
    where: { id: "demo-project-001" },
    update: {},
    create: {
      id: "demo-project-001",
      name: "Demo Project",
      description: "Example project showing AI role assignments",
    },
  });

  console.log("Project seeded:", project.name);

  // ===== ASSIGNMENTS (optimized defaults) =====
  // Clear existing assignments for this project to avoid stale entries
  await prisma.roleAssignment.deleteMany({
    where: { projectId: project.id },
  });

  const assignments = [
    { role: coding, provider: claudeSonnet45, label: "Coding    -> Claude Sonnet 4.5" },
    { role: search, provider: perplexitySonarPro, label: "Search    -> Perplexity Sonar Pro" },
    { role: planning, provider: gemini25Flash, label: "Planning  -> Gemini 2.5 Flash" },
    { role: writing, provider: claudeSonnet45, label: "Writing   -> Claude Sonnet 4.5" },
    { role: review, provider: gpt41, label: "Review    -> GPT-4.1" },
    { role: leader, provider: gemini25Flash, label: "Leader    -> Gemini 2.5 Flash" },
  ];

  for (const a of assignments) {
    await prisma.roleAssignment.create({
      data: {
        projectId: project.id,
        roleId: a.role.id,
        providerId: a.provider.id,
        priority: 10,
      },
    });
  }

  console.log("Assignments seeded for demo project:");
  assignments.forEach((a) => console.log(`  ${a.label}`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
