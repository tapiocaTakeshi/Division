import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // --- Providers (model-level granularity) ---

  // Anthropic models
  const claudeSonnet = await prisma.provider.upsert({
    where: { name: "claude-sonnet" },
    update: {},
    create: {
      name: "claude-sonnet",
      displayName: "Claude Sonnet (Anthropic)",
      apiBaseUrl: "https://api.anthropic.com",
      apiType: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      description: "Anthropic Claude Sonnet - balanced coding & writing",
    },
  });

  const claudeHaiku = await prisma.provider.upsert({
    where: { name: "claude-haiku" },
    update: {},
    create: {
      name: "claude-haiku",
      displayName: "Claude Haiku (Anthropic)",
      apiBaseUrl: "https://api.anthropic.com",
      apiType: "anthropic",
      modelId: "claude-haiku-3-20250414",
      description: "Anthropic Claude Haiku - fast & lightweight",
    },
  });

  const claudeOpus = await prisma.provider.upsert({
    where: { name: "claude-opus" },
    update: {},
    create: {
      name: "claude-opus",
      displayName: "Claude Opus (Anthropic)",
      apiBaseUrl: "https://api.anthropic.com",
      apiType: "anthropic",
      modelId: "claude-opus-4-20250514",
      description: "Anthropic Claude Opus - most powerful, deep reasoning",
    },
  });

  // Google models
  const geminiFlash = await prisma.provider.upsert({
    where: { name: "gemini-flash" },
    update: {},
    create: {
      name: "gemini-flash",
      displayName: "Gemini 2.0 Flash (Google)",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      apiType: "google",
      modelId: "gemini-2.0-flash",
      description: "Google Gemini 2.0 Flash - fast & efficient",
    },
  });

  const geminiPro = await prisma.provider.upsert({
    where: { name: "gemini-pro" },
    update: {},
    create: {
      name: "gemini-pro",
      displayName: "Gemini 2.5 Pro (Google)",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      apiType: "google",
      modelId: "gemini-2.5-pro-preview-06-05",
      description: "Google Gemini 2.5 Pro - advanced reasoning & planning",
    },
  });

  // Perplexity models
  const perplexitySonar = await prisma.provider.upsert({
    where: { name: "perplexity-sonar" },
    update: {},
    create: {
      name: "perplexity-sonar",
      displayName: "Perplexity Sonar",
      apiBaseUrl: "https://api.perplexity.ai",
      apiType: "perplexity",
      modelId: "sonar",
      description: "Perplexity Sonar - fast search",
    },
  });

  const perplexitySonarPro = await prisma.provider.upsert({
    where: { name: "perplexity-sonar-pro" },
    update: {},
    create: {
      name: "perplexity-sonar-pro",
      displayName: "Perplexity Sonar Pro",
      apiBaseUrl: "https://api.perplexity.ai",
      apiType: "perplexity",
      modelId: "sonar-pro",
      description: "Perplexity Sonar Pro - deep research with citations",
    },
  });

  // OpenAI models
  const gpt4o = await prisma.provider.upsert({
    where: { name: "gpt-4o" },
    update: {},
    create: {
      name: "gpt-4o",
      displayName: "GPT-4o (OpenAI)",
      apiBaseUrl: "https://api.openai.com",
      apiType: "openai",
      modelId: "gpt-4o",
      description: "OpenAI GPT-4o - flagship multimodal model",
    },
  });

  const gpt4oMini = await prisma.provider.upsert({
    where: { name: "gpt-4o-mini" },
    update: {},
    create: {
      name: "gpt-4o-mini",
      displayName: "GPT-4o Mini (OpenAI)",
      apiBaseUrl: "https://api.openai.com",
      apiType: "openai",
      modelId: "gpt-4o-mini",
      description: "OpenAI GPT-4o Mini - fast & affordable",
    },
  });

  const o3 = await prisma.provider.upsert({
    where: { name: "o3" },
    update: {},
    create: {
      name: "o3",
      displayName: "o3 (OpenAI)",
      apiBaseUrl: "https://api.openai.com",
      apiType: "openai",
      modelId: "o3",
      description: "OpenAI o3 - advanced reasoning model",
    },
  });

  const o3Mini = await prisma.provider.upsert({
    where: { name: "o3-mini" },
    update: {},
    create: {
      name: "o3-mini",
      displayName: "o3 Mini (OpenAI)",
      apiBaseUrl: "https://api.openai.com",
      apiType: "openai",
      modelId: "o3-mini",
      description: "OpenAI o3 Mini - fast reasoning",
    },
  });

  // Legacy aliases (point to default models)
  const claude = await prisma.provider.upsert({
    where: { name: "claude" },
    update: { modelId: "claude-sonnet-4-20250514" },
    create: {
      name: "claude",
      displayName: "Claude (Anthropic)",
      apiBaseUrl: "https://api.anthropic.com",
      apiType: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      description: "Alias → Claude Sonnet",
    },
  });

  const gemini = await prisma.provider.upsert({
    where: { name: "gemini" },
    update: { modelId: "gemini-2.0-flash" },
    create: {
      name: "gemini",
      displayName: "Gemini (Google)",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      apiType: "google",
      modelId: "gemini-2.0-flash",
      description: "Alias → Gemini 2.0 Flash",
    },
  });

  const perplexity = await prisma.provider.upsert({
    where: { name: "perplexity" },
    update: { modelId: "sonar-pro" },
    create: {
      name: "perplexity",
      displayName: "Perplexity",
      apiBaseUrl: "https://api.perplexity.ai",
      apiType: "perplexity",
      modelId: "sonar-pro",
      description: "Alias → Perplexity Sonar Pro",
    },
  });

  const gpt = await prisma.provider.upsert({
    where: { name: "gpt" },
    update: { modelId: "gpt-4o" },
    create: {
      name: "gpt",
      displayName: "GPT (OpenAI)",
      apiBaseUrl: "https://api.openai.com",
      apiType: "openai",
      modelId: "gpt-4o",
      description: "Alias → GPT-4o",
    },
  });

  const allProviders = [
    claudeSonnet, claudeHaiku, claudeOpus,
    geminiFlash, geminiPro,
    perplexitySonar, perplexitySonarPro,
    gpt4o, gpt4oMini, o3, o3Mini,
    claude, gemini, perplexity, gpt,
  ];
  console.log("Providers seeded:", allProviders.map((p) => p.name));

  // --- Roles ---
  const coding = await prisma.role.upsert({
    where: { slug: "coding" },
    update: {},
    create: {
      slug: "coding",
      name: "Coding",
      description: "Code generation, debugging, and review",
    },
  });

  const search = await prisma.role.upsert({
    where: { slug: "search" },
    update: {},
    create: {
      slug: "search",
      name: "Search",
      description: "Web search, research, and information retrieval",
    },
  });

  const planning = await prisma.role.upsert({
    where: { slug: "planning" },
    update: {},
    create: {
      slug: "planning",
      name: "Planning",
      description: "Project planning, architecture design, and strategy",
    },
  });

  const writing = await prisma.role.upsert({
    where: { slug: "writing" },
    update: {},
    create: {
      slug: "writing",
      name: "Writing",
      description: "Technical writing, documentation, and content creation",
    },
  });

  const review = await prisma.role.upsert({
    where: { slug: "review" },
    update: {},
    create: {
      slug: "review",
      name: "Review",
      description: "Code review, quality assurance, and analysis",
    },
  });

  const leader = await prisma.role.upsert({
    where: { slug: "leader" },
    update: {},
    create: {
      slug: "leader",
      name: "Leader",
      description: "Task decomposition, delegation, and orchestration",
    },
  });

  console.log("Roles seeded:", [coding, search, planning, writing, review, leader].map((r) => r.slug));

  // --- Demo Project ---
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

  // --- Assignments (user's example configuration) ---
  // Coding -> Claude
  await prisma.roleAssignment.upsert({
    where: {
      projectId_roleId_providerId: {
        projectId: project.id,
        roleId: coding.id,
        providerId: claude.id,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      roleId: coding.id,
      providerId: claude.id,
      priority: 10,
    },
  });

  // Search -> Perplexity
  await prisma.roleAssignment.upsert({
    where: {
      projectId_roleId_providerId: {
        projectId: project.id,
        roleId: search.id,
        providerId: perplexity.id,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      roleId: search.id,
      providerId: perplexity.id,
      priority: 10,
    },
  });

  // Planning -> Gemini
  await prisma.roleAssignment.upsert({
    where: {
      projectId_roleId_providerId: {
        projectId: project.id,
        roleId: planning.id,
        providerId: gemini.id,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      roleId: planning.id,
      providerId: gemini.id,
      priority: 10,
    },
  });

  // Writing -> Claude
  await prisma.roleAssignment.upsert({
    where: {
      projectId_roleId_providerId: {
        projectId: project.id,
        roleId: writing.id,
        providerId: claude.id,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      roleId: writing.id,
      providerId: claude.id,
      priority: 10,
    },
  });

  // Review -> GPT
  await prisma.roleAssignment.upsert({
    where: {
      projectId_roleId_providerId: {
        projectId: project.id,
        roleId: review.id,
        providerId: gpt.id,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      roleId: review.id,
      providerId: gpt.id,
      priority: 10,
    },
  });

  // Leader -> Gemini
  await prisma.roleAssignment.upsert({
    where: {
      projectId_roleId_providerId: {
        projectId: project.id,
        roleId: leader.id,
        providerId: gemini.id,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      roleId: leader.id,
      providerId: gemini.id,
      priority: 10,
    },
  });

  console.log("Assignments seeded for demo project");
  console.log("  Coding    -> Claude");
  console.log("  Search    -> Perplexity");
  console.log("  Planning  -> Gemini");
  console.log("  Writing   -> Claude");
  console.log("  Review    -> GPT");
  console.log("  Leader    -> Gemini");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
