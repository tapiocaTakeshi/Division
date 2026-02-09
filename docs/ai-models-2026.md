# AI Models List 2026

2026年時点でよく言及されている主要AIモデル（LLM）の網羅的な一覧です。

---

## 主要商用・一般向けモデル

### OpenAI 系

| モデル | 備考 |
| --- | --- |
| GPT-5.2 | 最新フラグシップ、deep reasoning、configurable thinking |
| GPT-5.1 | フラグシップ推論、400Kコンテキスト、コーディング&エージェント |
| GPT-5 | 第5世代フラグシップ |
| GPT-4.1 | 1Mコンテキスト、GPT-4oの改良版 |
| GPT-4.1 Mini | バランス型、コスト効率 |
| GPT-4.1 Nano | 超高速、大量処理向け |
| GPT-4o | マルチモーダルフラグシップ（旧世代） |
| GPT-4o Mini | 高速・低コスト（旧世代） |
| o3 | 高度推論モデル |
| o3 Mini | 高速推論モデル |

### Anthropic 系

| モデル | 備考 |
| --- | --- |
| Claude Opus 4.6 | 最新・最高性能、エージェント&深い推論 |
| Claude Opus 4.5 | 前世代Opus |
| Claude Sonnet 4.5 | バランス型、コーディング&ライティング |
| Claude Sonnet 4 | 堅実なコーディング&ライティング |
| Claude Opus 4 | 強力な深い推論 |
| Claude Haiku 4.5 | 最速Claude、ニアフロンティア知能 |
| Claude Haiku 3 | 高速・軽量 |

### Google / Gemini 系

| モデル | 備考 |
| --- | --- |
| Gemini 3 Pro | 最新フラグシップ、複雑なエージェントワークフロー |
| Gemini 3 Flash | 高速フロンティアクラス、視覚・空間推論 |
| Gemini 2.5 Pro | 安定版、高度推論&1Mコンテキスト |
| Gemini 2.5 Flash | バランス型、制御可能なthinking |
| Gemini 2.0 Flash | 高速・効率的な汎用モデル |
| Gemini 3 Deep Think | 深い思考バリエーション |
| Gemini 3 Flash-Lite | 軽量バリエーション |

---

## オープンソース/研究向けモデル

### Meta / LLaMA 系

| モデル | 備考 |
| --- | --- |
| Llama 4 Scout | Llama 4世代、スカウトモデル |
| Llama 4 Maverick | Llama 4世代、マーベリックモデル |
| Llama 3.1 系 | 様々なサイズ（8B/70B/405B） |

### Alibaba / Qwen 系

| モデル | 備考 |
| --- | --- |
| Qwen3-235B | 最大パラメータモデル |
| Qwen3-32B | 中規模モデル |
| Qwen3-4B | 軽量モデル |
| Qwen3-Coder | コーディング特化 |
| Qwen-VL | マルチモーダル（ビジョン&言語） |

100以上の言語に対応。

### DeepSeek 系

| モデル | 備考 |
| --- | --- |
| DeepSeek R1-0528 | Chain-of-thought推論スペシャリスト |
| DeepSeek V3.2 | 推論ファースト、エージェントワークフロー |
| DeepSeek-Coder-V2 | コーディング特化 |

### Mistral 系（フランス発）

| モデル | 備考 |
| --- | --- |
| Mistral Large 3 | フラグシップ大規模モデル |
| Mixtral 系 | Mixture of Experts アーキテクチャ |
| Mistral 7B | 汎用7Bモデル |
| Mistral NeMo 12B | NVIDIA共同開発12B |
| Pixtral 12B | マルチモーダル12B |
| Codestral Mamba | コーディング特化、Mambaアーキテクチャ |
| Mathstral 7B | 数学特化7B |
| Ministral 3B | 超軽量3B |

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

### 特殊用途/ニッチ系

| モデル | 備考 |
| --- | --- |
| Grok 3 / Grok 4.1 | xAI提供、リアルタイムX/Web検索 |
| Kimi 系 | Moonshot AI、大規模MoE |
| Command R+ | Cohere製、企業向け最適化 |

---

## まとめ

| カテゴリ | 代表モデル |
| --- | --- |
| 最新商用AI | GPT-5.2、Claude Opus 4.6、Gemini 3 Pro |
| オープンソースLLM | Llama 4 系、Qwen3 系、Mistral 系 |
| 軽量・特化モデル | Gemma 2、Phi、StableLM、Vicuna、DeepSeek-Coder |

---

## Division API 対応状況

Division API では現在以下の **38モデル / 6プロバイダー** に対応しています。

| プロバイダー | 対応モデル |
| --- | --- |
| **Anthropic** | Claude Opus 4.6, Sonnet 4.5, Haiku 4.5, Sonnet 4, Opus 4, Haiku 3 |
| **Google** | Gemini 3 Pro/Flash, 2.5 Pro/Flash, 2.0 Flash |
| **OpenAI** | GPT-5.2, 5.1, 4.1/Mini/Nano, 4o/Mini, o3/Mini |
| **Perplexity** | Deep Research, Reasoning Pro, Sonar Pro, Sonar |
| **xAI** | Grok 4.1 Fast, 4, 3, 3 Mini |
| **DeepSeek** | V3.2, R1 |

### 今後の追加候補

上記の網羅リストから、以下のモデルが今後の対応候補です:

- **Meta Llama 4** (Scout / Maverick) - オープンソース最大手
- **Alibaba Qwen3** (235B / 32B / Coder) - 多言語対応
- **Mistral Large 3** / Mixtral - ヨーロッパ発のオープン系
- **Kimi** (Moonshot AI) - 大規模MoEモデル
