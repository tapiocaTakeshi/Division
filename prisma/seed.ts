import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // --- Providers ---
  const claude = await prisma.provider.upsert({
    where: { name: "claude" },
    update: {},
    create: {
      name: "claude",
      displayName: "Claude (Anthropic)",
      apiBaseUrl: "https://api.anthropic.com",
      apiType: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      description: "Anthropic's Claude - excellent for coding and writing",
    },
  });

  const gemini = await prisma.provider.upsert({
    where: { name: "gemini" },
    update: {},
    create: {
      name: "gemini",
      displayName: "Gemini (Google)",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      apiType: "google",
      modelId: "gemini-2.0-flash",
      description: "Google's Gemini - strong at planning and reasoning",
    },
  });

  const perplexity = await prisma.provider.upsert({
    where: { name: "perplexity" },
    update: {},
    create: {
      name: "perplexity",
      displayName: "Perplexity",
      apiBaseUrl: "https://api.perplexity.ai",
      apiType: "perplexity",
      modelId: "sonar-pro",
      description: "Perplexity - specialized in real-time search and research",
    },
  });

  const gpt = await prisma.provider.upsert({
    where: { name: "gpt" },
    update: {},
    create: {
      name: "gpt",
      displayName: "GPT (OpenAI)",
      apiBaseUrl: "https://api.openai.com",
      apiType: "openai",
      modelId: "gpt-4o",
      description: "OpenAI's GPT - general-purpose AI assistant",
    },
  });

  console.log("Providers seeded:", [claude, gemini, perplexity, gpt].map((p) => p.name));

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
