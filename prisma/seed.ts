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

  const claudeOpus45 = await upsertProvider({
    name: "claude-opus-4.5",
    displayName: "Claude Opus 4.5 (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-opus-4-5-20251101",
    description: "World-class coding, agents & computer use — $5/$25 per 1M tokens",
  });

  const claudeOpus41 = await upsertProvider({
    name: "claude-opus-4.1",
    displayName: "Claude Opus 4.1 (Anthropic)",
    apiBaseUrl: "https://api.anthropic.com",
    apiType: "anthropic",
    modelId: "claude-opus-4-1-20250805",
    description: "Multi-step reasoning, real-world coding & agentic tasks",
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

  await upsertProvider({
    name: "gemini-3-deep-think",
    displayName: "Gemini 3 Deep Think (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemini-3-deep-think",
    description: "Maximum reasoning — ARC-AGI-2 84.6%, Physics/Chemistry Olympiad gold, HLE 48.4%",
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

  const gpt5 = await upsertProvider({
    name: "gpt-5",
    displayName: "GPT-5 (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-5",
    description: "Major generational leap — deep reasoning & multimodal",
  });

  await upsertProvider({
    name: "o4-mini",
    displayName: "o4-mini (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "o4-mini",
    description: "Fast reasoning — coding, math, visual tasks, 99.5% AIME 2025",
  });

  await upsertProvider({
    name: "o3-pro",
    displayName: "o3 Pro (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "o3-pro",
    description: "Maximum reasoning compute — hard problems, better consistency",
  });

  await upsertProvider({
    name: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-5.2-codex",
    description: "Agentic coding — context compaction, SWE-Bench Pro 56.4%",
  });

  await upsertProvider({
    name: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-5.3-codex",
    description: "Latest agentic coding model — frontier coding + reasoning, 25% faster",
  });

  await upsertProvider({
    name: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-5.3-codex-spark",
    description: "Real-time coding — 1000+ tok/s, first OpenAI model on Cerebras WSE3",
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

  await upsertProvider({
    name: "grok-4.1-thinking",
    displayName: "Grok 4.1 Thinking (xAI)",
    apiBaseUrl: "https://api.x.ai",
    apiType: "xai",
    modelId: "grok-4-1-fast-reasoning",
    description: "Deep reasoning with thinking tokens — #1 LMArena Elo 1483",
  });

  await upsertProvider({
    name: "grok-5",
    displayName: "Grok 5 (xAI)",
    apiBaseUrl: "https://api.x.ai",
    apiType: "xai",
    modelId: "grok-5",
    description: "Next-gen 6T params — multimodal agentic system, Colossus 2 trained",
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

  await upsertProvider({
    name: "deepseek-r1-0528",
    displayName: "DeepSeek R1-0528",
    apiBaseUrl: "https://api.deepseek.com",
    apiType: "deepseek",
    modelId: "deepseek-r1-0528",
    description: "Updated reasoning model — improved chain-of-thought",
  });

  await upsertProvider({
    name: "deepseek-v4",
    displayName: "DeepSeek V4",
    apiBaseUrl: "https://api.deepseek.com",
    apiType: "deepseek",
    modelId: "deepseek-v4",
    description: "Hybrid reasoning/non-reasoning — coding dominance, 1M+ context, Engram memory",
  });

  await upsertProvider({
    name: "deepseek-v3.2-speciale",
    displayName: "DeepSeek V3.2-Speciale",
    apiBaseUrl: "https://api.deepseek.com",
    apiType: "deepseek",
    modelId: "deepseek-v3.2-speciale",
    description: "Competition-grade reasoning — IMO 2025 & ICPC World Finals gold medals",
  });

  await upsertProvider({
    name: "deepseek-coder-v2",
    displayName: "DeepSeek-Coder-V2",
    apiBaseUrl: "https://api.deepseek.com",
    apiType: "deepseek",
    modelId: "deepseek-coder-v2",
    description: "Specialized coding model — code generation & analysis",
  });

  // --- Meta (Llama) ---
  const llama4Scout = await upsertProvider({
    name: "llama-4-scout",
    displayName: "Llama 4 Scout (Meta)",
    apiBaseUrl: "https://api.llama.com",
    apiType: "meta",
    modelId: "Llama-4-Scout-17B-16E",
    description: "Efficient MoE — 17B active params, 16 experts, 10M context",
  });

  const llama4Maverick = await upsertProvider({
    name: "llama-4-maverick",
    displayName: "Llama 4 Maverick (Meta)",
    apiBaseUrl: "https://api.llama.com",
    apiType: "meta",
    modelId: "Llama-4-Maverick-17B-128E",
    description: "Large MoE — 17B active params, 128 experts, 1M context",
  });

  await upsertProvider({
    name: "llama-3.1-405b",
    displayName: "Llama 3.1 405B (Meta)",
    apiBaseUrl: "https://api.llama.com",
    apiType: "meta",
    modelId: "Llama-3.1-405B",
    description: "Largest open-weight dense model — 405B parameters",
  });

  await upsertProvider({
    name: "llama-3.1-70b",
    displayName: "Llama 3.1 70B (Meta)",
    apiBaseUrl: "https://api.llama.com",
    apiType: "meta",
    modelId: "Llama-3.1-70B",
    description: "Balanced open-weight model — 70B parameters",
  });

  await upsertProvider({
    name: "llama-3.1-8b",
    displayName: "Llama 3.1 8B (Meta)",
    apiBaseUrl: "https://api.llama.com",
    apiType: "meta",
    modelId: "Llama-3.1-8B",
    description: "Compact open-weight model — 8B parameters",
  });

  // --- Alibaba (Qwen) ---
  const qwen3235B = await upsertProvider({
    name: "qwen3-235b",
    displayName: "Qwen3-235B (Alibaba)",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com",
    apiType: "qwen",
    modelId: "qwen3-235b-a22b",
    description: "Flagship MoE — 235B total, 22B active, 100+ languages",
  });

  await upsertProvider({
    name: "qwen3-32b",
    displayName: "Qwen3-32B (Alibaba)",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com",
    apiType: "qwen",
    modelId: "qwen3-32b",
    description: "Dense 32B — strong reasoning, matches larger models",
  });

  await upsertProvider({
    name: "qwen3-4b",
    displayName: "Qwen3-4B (Alibaba)",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com",
    apiType: "qwen",
    modelId: "qwen3-4b",
    description: "Lightweight 4B — mobile & edge deployment",
  });

  await upsertProvider({
    name: "qwen3-coder",
    displayName: "Qwen3-Coder (Alibaba)",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com",
    apiType: "qwen",
    modelId: "qwen3-coder",
    description: "Code-specialized — generation, debugging, review",
  });

  await upsertProvider({
    name: "qwen3-coder-next",
    displayName: "Qwen3-Coder-Next (Alibaba)",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com",
    apiType: "qwen",
    modelId: "qwen3-coder-next",
    description: "Coding agent — 80B MoE (3B active), 256K context, SWE-Bench 70.6",
  });

  await upsertProvider({
    name: "qwen-vl",
    displayName: "Qwen-VL (Alibaba)",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com",
    apiType: "qwen",
    modelId: "qwen-vl-max",
    description: "Vision-language model — image understanding & OCR",
  });

  // --- Mistral ---
  const mistralLarge3 = await upsertProvider({
    name: "mistral-large-3",
    displayName: "Mistral Large 3 (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "mistral-large-latest",
    description: "Flagship — 128K context, top-tier reasoning & coding",
  });

  await upsertProvider({
    name: "mistral-3",
    displayName: "Mistral 3 (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "mistral-3-large-latest",
    description: "Latest MoE flagship — Apache 2.0, DeepSeek V3 architecture",
  });

  await upsertProvider({
    name: "ministral-8b",
    displayName: "Ministral 8B (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "ministral-8b-latest",
    description: "Dense 8B — multilingual, multimodal, vision encoder built-in",
  });

  await upsertProvider({
    name: "ministral-14b",
    displayName: "Ministral 14B (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "ministral-14b-latest",
    description: "Dense 14B — strong cost-to-performance, vision capable",
  });

  await upsertProvider({
    name: "mixtral-8x22b",
    displayName: "Mixtral 8x22B (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "open-mixtral-8x22b",
    description: "Open MoE — 8 experts x 22B, strong multilingual",
  });

  await upsertProvider({
    name: "mistral-7b",
    displayName: "Mistral 7B (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "open-mistral-7b",
    description: "Compact open model — efficient general purpose",
  });

  await upsertProvider({
    name: "mistral-nemo-12b",
    displayName: "Mistral NeMo 12B (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "open-mistral-nemo",
    description: "12B co-developed with NVIDIA — 128K context",
  });

  await upsertProvider({
    name: "pixtral-12b",
    displayName: "Pixtral 12B (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "pixtral-12b-2409",
    description: "Multimodal — vision + language, image understanding",
  });

  await upsertProvider({
    name: "codestral-mamba",
    displayName: "Codestral Mamba (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "codestral-mamba-latest",
    description: "Code-specialized Mamba architecture — fast inference",
  });

  await upsertProvider({
    name: "mathstral-7b",
    displayName: "Mathstral 7B (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "mathstral-7b",
    description: "Math-specialized — scientific & mathematical reasoning",
  });

  await upsertProvider({
    name: "ministral-3b",
    displayName: "Ministral 3B (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "ministral-3b-latest",
    description: "Ultra-compact 3B — edge & on-device inference",
  });

  // --- Edge / Lightweight ---
  await upsertProvider({
    name: "gemma-2-27b",
    displayName: "Gemma 2 27B (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemma-2-27b",
    description: "Google open model — 27B, research & fine-tuning",
  });

  await upsertProvider({
    name: "gemma-2-9b",
    displayName: "Gemma 2 9B (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemma-2-9b",
    description: "Google open model — 9B, balanced performance",
  });

  await upsertProvider({
    name: "gemma-2-2b",
    displayName: "Gemma 2 2B (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "gemma-2-2b",
    description: "Google open model — 2B, ultra-lightweight",
  });

  await upsertProvider({
    name: "phi-4-mini",
    displayName: "Phi-4-mini (Microsoft)",
    apiBaseUrl: "https://models.inference.ai.azure.com",
    apiType: "openai",
    modelId: "Phi-4-mini",
    description: "Microsoft SLM — strong reasoning for its size",
  });

  await upsertProvider({
    name: "phi-3.5-mini",
    displayName: "Phi-3.5-mini (Microsoft)",
    apiBaseUrl: "https://models.inference.ai.azure.com",
    apiType: "openai",
    modelId: "Phi-3.5-mini-instruct",
    description: "Microsoft SLM — 3.8B, 128K context, multilingual",
  });

  await upsertProvider({
    name: "stablelm-2",
    displayName: "StableLM 2 (Stability AI)",
    apiBaseUrl: "https://api.stability.ai",
    apiType: "openai",
    modelId: "stablelm-2-12b",
    description: "Stability AI — 12B, open-weight, efficient",
  });

  await upsertProvider({
    name: "vicuna-13b",
    displayName: "Vicuna-13B (LMSYS)",
    apiBaseUrl: "http://localhost:11434",
    apiType: "openai",
    modelId: "vicuna-13b",
    description: "Open-source chatbot — fine-tuned LLaMA, self-hosted",
  });

  await upsertProvider({
    name: "smollm3-3b",
    displayName: "SmolLM3-3B (Hugging Face)",
    apiBaseUrl: "https://api-inference.huggingface.co",
    apiType: "openai",
    modelId: "SmolLM3-3B",
    description: "Hugging Face compact model — 3B, edge-optimized",
  });

  await upsertProvider({
    name: "minicpm",
    displayName: "MiniCPM (OpenBMB)",
    apiBaseUrl: "http://localhost:11434",
    apiType: "openai",
    modelId: "minicpm-latest",
    description: "Ultra-compact — on-device, multimodal capable",
  });

  // --- Special / Niche ---
  await upsertProvider({
    name: "kimi-k2",
    displayName: "Kimi K2 (Moonshot AI)",
    apiBaseUrl: "https://api.moonshot.cn",
    apiType: "moonshot",
    modelId: "kimi-k2",
    description: "Massive MoE — 1T total params, agentic & coding",
  });

  await upsertProvider({
    name: "command-r-plus",
    displayName: "Command R+ (Cohere)",
    apiBaseUrl: "https://api.cohere.com",
    apiType: "cohere",
    modelId: "command-r-plus",
    description: "Enterprise RAG-optimized — retrieval & tool use",
  });

  // --- Image Generation ---
  const gptImage1 = await upsertProvider({
    name: "gpt-image-1",
    displayName: "GPT Image 1 (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "gpt-image-1",
    description: "Native image generation — high quality, prompt-faithful output",
  });

  await upsertProvider({
    name: "dall-e-3",
    displayName: "DALL-E 3 (OpenAI)",
    apiBaseUrl: "https://api.openai.com",
    apiType: "openai",
    modelId: "dall-e-3",
    description: "Advanced image generation — detailed, creative visuals",
  });

  await upsertProvider({
    name: "imagen-3",
    displayName: "Imagen 3 (Google)",
    apiBaseUrl: "https://generativelanguage.googleapis.com",
    apiType: "google",
    modelId: "imagen-3.0-generate-002",
    description: "Google's highest quality image generation model",
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
    modelId: "gpt-5.2",
    description: "Alias → GPT-5.2",
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
    modelId: "deepseek-v4",
    description: "Alias → DeepSeek V4",
  });

  await upsertProvider({
    name: "llama",
    displayName: "Llama (Meta)",
    apiBaseUrl: "https://api.llama.com",
    apiType: "meta",
    modelId: "Llama-4-Maverick-17B-128E",
    description: "Alias → Llama 4 Maverick",
  });

  await upsertProvider({
    name: "qwen",
    displayName: "Qwen (Alibaba)",
    apiBaseUrl: "https://dashscope-intl.aliyuncs.com",
    apiType: "qwen",
    modelId: "qwen3-235b-a22b",
    description: "Alias → Qwen3-235B",
  });

  await upsertProvider({
    name: "mistral",
    displayName: "Mistral (Mistral AI)",
    apiBaseUrl: "https://api.mistral.ai",
    apiType: "mistral",
    modelId: "mistral-3-large-latest",
    description: "Alias → Mistral 3",
  });

  await upsertProvider({
    name: "kimi",
    displayName: "Kimi (Moonshot AI)",
    apiBaseUrl: "https://api.moonshot.cn",
    apiType: "moonshot",
    modelId: "kimi-k2",
    description: "Alias → Kimi K2",
  });

  await upsertProvider({
    name: "cohere",
    displayName: "Cohere",
    apiBaseUrl: "https://api.cohere.com",
    apiType: "cohere",
    modelId: "command-r-plus",
    description: "Alias → Command R+",
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

  console.log("Providers seeded (87+ models)");

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

  const deepResearch = await prisma.role.upsert({
    where: { slug: "deep-research" },
    update: {},
    create: { slug: "deep-research", name: "Deep Research", description: "Exhaustive multi-source research, comprehensive analysis, and detailed reports" },
  });

  const image = await prisma.role.upsert({
    where: { slug: "image" },
    update: {},
    create: { slug: "image", name: "Image", description: "Image generation, visual content creation, and illustration" },
  });

  console.log("Roles seeded:", [coding, search, planning, writing, review, leader, deepResearch, image].map((r) => r.slug));

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
  const assignments = [
    { role: coding, provider: claudeSonnet45, label: "Coding         -> Claude Sonnet 4.5" },
    { role: search, provider: perplexitySonarPro, label: "Search         -> Perplexity Sonar Pro" },
    { role: planning, provider: gemini25Pro, label: "Planning       -> Gemini 2.5 Pro" },
    { role: writing, provider: claudeSonnet45, label: "Writing        -> Claude Sonnet 4.5" },
    { role: review, provider: gpt41, label: "Review         -> GPT-4.1" },
    { role: leader, provider: gemini25Flash, label: "Leader         -> Gemini 2.5 Flash" },
    { role: deepResearch, provider: perplexityDeepResearch, label: "Deep Research  -> Perplexity Deep Research" },
    { role: image, provider: gptImage1, label: "Image          -> GPT Image 1" },
  ];

  for (const a of assignments) {
    await prisma.roleAssignment.upsert({
      where: {
        projectId_roleId_providerId: {
          projectId: project.id,
          roleId: a.role.id,
          providerId: a.provider.id,
        },
      },
      update: {},
      create: {
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
