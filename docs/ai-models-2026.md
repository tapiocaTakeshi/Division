# AI Models List 2026

2026年2月時点でよく言及されている主要AIモデル（LLM）の網羅的な一覧です。

---

## 主要商用・一般向けモデル

### OpenAI 系

| モデル | 備考 |
| --- | --- |
| GPT-5.3 Codex | 最新エージェントコーディングモデル、フロンティアコーディング+推論 |
| GPT-5.2 | フラグシップ、deep reasoning、configurable thinking |
| GPT-5.2 Codex | エージェントコーディング、SWE-Bench Pro 56.4% |
| GPT-5.1 | フラグシップ推論、400Kコンテキスト、コーディング&エージェント |
| GPT-5 | 第5世代フラグシップ |
| GPT-4.1 | 1Mコンテキスト、GPT-4oの改良版 |
| GPT-4.1 Mini | バランス型、コスト効率 |
| GPT-4.1 Nano | 超高速、大量処理向け |
| GPT-4o | マルチモーダルフラグシップ（旧世代） |
| GPT-4o Mini | 高速・低コスト（旧世代） |
| o3 | 高度推論モデル |
| o3 Pro | 最大推論コンピュート、高精度 |
| o3 Mini | 高速推論モデル |
| o4-mini | 高速推論、コーディング・数学・視覚、AIME 2025 99.5% |

### Anthropic 系

| モデル | 備考 |
| --- | --- |
| Claude Opus 4.6 | 最新・最高性能、エージェント&深い推論（2026年2月） |
| Claude Opus 4.5 | コーディング・エージェント・コンピュータ利用、$5/$25 per 1M（2025年11月） |
| Claude Opus 4.1 | マルチステップ推論、real-worldコーディング（2025年8月） |
| Claude Sonnet 4.5 | バランス型、コーディング&ライティング、SWE-bench 77.2% |
| Claude Sonnet 4 | 堅実なコーディング&ライティング |
| Claude Opus 4 | 強力な深い推論 |
| Claude Haiku 4.5 | 最速Claude、ニアフロンティア知能 |
| Claude Haiku 3 | 高速・軽量 |

### Google / Gemini 系

| モデル | 備考 |
| --- | --- |
| Gemini 3 Pro | フラグシップ、LMArena Elo 1501達成、複雑なエージェントワークフロー |
| Gemini 3 Flash | 高速フロンティアクラス、2.5 Proを超える性能で3倍高速 |
| Gemini 3 Deep Think | 最大推論深度、科学・数学・物理オリンピックレベル |
| Gemini 2.5 Pro | 安定版、高度推論&1Mコンテキスト |
| Gemini 2.5 Flash | バランス型、制御可能なthinking |
| Gemini 2.0 Flash | 高速・効率的な汎用モデル |

### xAI / Grok 系

| モデル | 備考 |
| --- | --- |
| Grok 5 | 次世代6Tパラメータ、マルチモーダルエージェント |
| Grok 4.1 Fast | ツールコール最強、2Mコンテキスト、低ハルシネーション |
| Grok 4.1 Thinking | 深い推論、LMArena Elo 1483で#1 |
| Grok 4 | フラグシップ、256Kコンテキスト、リアルタイムX/Web検索 |
| Grok 3 | エンタープライズ、データ抽出・コーディング |
| Grok 3 Mini | コスト効率の高い高速モデル |

---

## オープンソース/研究向けモデル

### Meta / LLaMA 系

| モデル | 備考 |
| --- | --- |
| Llama 4 Scout | MoE — 17B active、16 experts、10Mコンテキスト |
| Llama 4 Maverick | MoE — 17B active、128 experts、1Mコンテキスト |
| Llama 3.1 系 | 様々なサイズ（8B/70B/405B） |

### Alibaba / Qwen 系

| モデル | 備考 |
| --- | --- |
| Qwen3-235B | フラグシップMoE — 235B total、22B active、100+言語 |
| Qwen3-32B | Dense 32B、大型モデルに匹敵する推論力 |
| Qwen3-4B | 軽量4B、モバイル&エッジ向け |
| Qwen3-Coder | コーディング特化 |
| Qwen3-Coder-Next | コーディングエージェント — 80B MoE（3B active）、256Kコンテキスト、SWE-Bench 70.6 |
| Qwen-VL | マルチモーダル（ビジョン&言語） |

100以上の言語に対応。HuggingFaceダウンロード数でLlamaを超え首位。

### DeepSeek 系

| モデル | 備考 |
| --- | --- |
| DeepSeek V4 | ハイブリッド推論/非推論、コーディング特化、1M+コンテキスト、Engram記憶（2026年2月） |
| DeepSeek V3.2 | 685B MoE（37B active）、GPT-5レベル推論 |
| DeepSeek R1 / R1-0528 | Chain-of-thought推論スペシャリスト |
| DeepSeek-Coder-V2 | コーディング特化 |

### Mistral 系（フランス発）

| モデル | 備考 |
| --- | --- |
| Mistral 3 | 最新MoEフラグシップ、Apache 2.0、DeepSeek V3アーキテクチャ |
| Mistral Large 3 | フラグシップ大規模モデル、128Kコンテキスト |
| Mixtral 系 | Mixture of Experts アーキテクチャ |
| Mistral 7B | 汎用7Bモデル |
| Mistral NeMo 12B | NVIDIA共同開発12B |
| Pixtral 12B | マルチモーダル12B |
| Codestral Mamba | コーディング特化、Mambaアーキテクチャ |
| Mathstral 7B | 数学特化7B |
| Ministral 3B | 超軽量3B |
| Ministral 8B | Dense 8B、マルチモーダル、ビジョンエンコーダ内蔵 |
| Ministral 14B | Dense 14B、コスト対性能比に優れる |

---

## その他・特徴特化モデル

### エッジ/軽量系

| モデル | 備考 |
| --- | --- |
| Gemma 2 系 | Google製オープン（2B/9B/27B） |
| Phi-4-mini | Microsoft製軽量モデル |
| Phi-3.5 系 | Microsoft製小規模モデル |
| StableLM 2 | Stability AI製 |
| Vicuna-13B | LMSys製、チャット特化 |
| SmolLM3-3B | Hugging Face製超軽量 |
| MiniCPM | 清華大学製超軽量 |

### 検索特化系

| モデル | 備考 |
| --- | --- |
| Perplexity Deep Research | エキスパートレベルの詳細検索&レポート |
| Perplexity Reasoning Pro | マルチステップ推論 with Chain of Thought |
| Perplexity Sonar Pro | 高度検索、引用付き |
| Perplexity Sonar | 軽量高速検索 |

### 特殊用途/ニッチ系

| モデル | 備考 |
| --- | --- |
| Kimi K2 | Moonshot AI、1T MoE、エージェント&コーディング |
| Command R+ | Cohere製、企業RAG最適化 |

---

## まとめ

| カテゴリ | 代表モデル |
| --- | --- |
| 最新商用AI | GPT-5.3 Codex、Claude Opus 4.6、Gemini 3 Pro、Grok 5 |
| オープンソースLLM | DeepSeek V4、Qwen3 系、Mistral 3、Llama 4 系 |
| 推論特化 | o4-mini、o3 Pro、Gemini 3 Deep Think、Grok 4.1 Thinking |
| コーディング特化 | GPT-5.3 Codex、Qwen3-Coder-Next、DeepSeek V4 |
| 軽量・特化モデル | Gemma 2、Phi、Ministral、SmolLM3、MiniCPM |

---

## Division API 対応状況

Division API では現在以下の **85+ モデル / 11プロバイダー** に対応しています。

| プロバイダー | 対応モデル |
| --- | --- |
| **Anthropic** | Claude Opus 4.6, **Opus 4.5**, **Opus 4.1**, Sonnet 4.5, Haiku 4.5, Sonnet 4, Opus 4, Haiku 3 |
| **Google** | Gemini 3 Pro/Flash, **3 Deep Think**, 2.5 Pro/Flash, 2.0 Flash, Gemma 2 (27B/9B/2B) |
| **OpenAI** | **GPT-5.3 Codex**, GPT-5.2, **5.2 Codex**, 5.1, 5, 4.1/Mini/Nano, 4o/Mini, **o4-mini**, **o3 Pro**, o3/Mini |
| **Perplexity** | Deep Research, Reasoning Pro, Sonar Pro, Sonar |
| **xAI** | **Grok 5**, Grok 4.1 Fast, **4.1 Thinking**, 4, 3, 3 Mini |
| **DeepSeek** | **V4**, V3.2, R1, R1-0528, Coder-V2 |
| **Meta** | Llama 4 Scout/Maverick, 3.1 (405B/70B/8B) |
| **Alibaba** | Qwen3-235B, 32B, 4B, Coder, **Coder-Next**, VL |
| **Mistral** | **Mistral 3**, Large 3, Mixtral 8x22B, 7B, NeMo 12B, Pixtral, Codestral, Mathstral, Ministral 3B/**8B**/**14B** |
| **Moonshot** | Kimi K2 |
| **Cohere** | Command R+ |

**太字** は今回新規追加されたモデルです。
