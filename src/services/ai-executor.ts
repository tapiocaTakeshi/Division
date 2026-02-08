/**
 * AI Executor Service
 *
 * Abstraction layer that dispatches requests to different AI providers
 * based on their apiType. In production, each provider type would call
 * the actual API. Here we provide the structure and a mock implementation.
 */

export interface ExecutionRequest {
  provider: {
    name: string;
    apiBaseUrl: string;
    apiType: string;
    modelId: string;
  };
  config?: Record<string, unknown>;
  input: string;
  role: {
    slug: string;
    name: string;
  };
}

export interface ExecutionResult {
  output: string;
  durationMs: number;
  status: "success" | "error";
  errorMsg?: string;
}

/**
 * Build the request body for each API type
 */
function buildRequestBody(
  apiType: string,
  modelId: string,
  input: string,
  roleContext: string,
  config?: Record<string, unknown>
): { url: string; headers: Record<string, string>; body: unknown } | null {
  const apiKey = config?.apiKey as string | undefined;

  switch (apiType) {
    case "anthropic":
      return {
        url: "/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey || "",
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: modelId,
          max_tokens: (config?.maxTokens as number) || 4096,
          system: `You are acting as the ${roleContext} role.`,
          messages: [{ role: "user", content: input }],
        },
      };

    case "openai":
      return {
        url: "/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey || ""}`,
        },
        body: {
          model: modelId,
          max_tokens: (config?.maxTokens as number) || 4096,
          messages: [
            { role: "system", content: `You are acting as the ${roleContext} role.` },
            { role: "user", content: input },
          ],
        },
      };

    case "google":
      return {
        url: `/v1beta/models/${modelId}:generateContent?key=${apiKey || ""}`,
        headers: { "Content-Type": "application/json" },
        body: {
          systemInstruction: {
            parts: [{ text: `You are acting as the ${roleContext} role.` }],
          },
          contents: [{ parts: [{ text: input }] }],
          generationConfig: {
            maxOutputTokens: (config?.maxTokens as number) || 4096,
          },
        },
      };

    case "perplexity":
      return {
        url: "/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey || ""}`,
        },
        body: {
          model: modelId,
          max_tokens: (config?.maxTokens as number) || 4096,
          messages: [
            { role: "system", content: `You are acting as the ${roleContext} role.` },
            { role: "user", content: input },
          ],
        },
      };

    default:
      return null;
  }
}

/**
 * Parse the response from each API type
 */
function parseResponse(apiType: string, data: unknown): string {
  const d = data as Record<string, unknown>;

  switch (apiType) {
    case "anthropic": {
      const content = d.content as Array<{ type: string; text: string }>;
      return content?.map((c) => c.text).join("") || JSON.stringify(data);
    }
    case "openai":
    case "perplexity": {
      const choices = d.choices as Array<{ message: { content: string } }>;
      return choices?.[0]?.message?.content || JSON.stringify(data);
    }
    case "google": {
      const candidates = d.candidates as Array<{
        content: { parts: Array<{ text: string }> };
      }>;
      return candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || JSON.stringify(data);
    }
    default:
      return JSON.stringify(data);
  }
}

/**
 * Execute a task by calling the assigned AI provider's API
 */
export async function executeTask(req: ExecutionRequest): Promise<ExecutionResult> {
  const start = Date.now();

  const requestSpec = buildRequestBody(
    req.provider.apiType,
    req.provider.modelId,
    req.input,
    `${req.role.name} (${req.role.slug})`,
    req.config || undefined
  );

  if (!requestSpec) {
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: `Unsupported API type: ${req.provider.apiType}`,
    };
  }

  const apiKey = (req.config?.apiKey as string) || "";
  if (!apiKey) {
    // Dry-run mode: return the request that would be sent
    return {
      output: JSON.stringify(
        {
          dryRun: true,
          message: "No API key configured. Showing the request that would be sent.",
          provider: req.provider.name,
          model: req.provider.modelId,
          role: req.role.name,
          endpoint: `${req.provider.apiBaseUrl}${requestSpec.url}`,
          requestBody: requestSpec.body,
        },
        null,
        2
      ),
      durationMs: Date.now() - start,
      status: "success",
    };
  }

  try {
    const fullUrl = `${req.provider.apiBaseUrl}${requestSpec.url}`;
    const response = await fetch(fullUrl, {
      method: "POST",
      headers: requestSpec.headers,
      body: JSON.stringify(requestSpec.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        output: "",
        durationMs: Date.now() - start,
        status: "error",
        errorMsg: `API error ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    const output = parseResponse(req.provider.apiType, data);

    return {
      output,
      durationMs: Date.now() - start,
      status: "success",
    };
  } catch (err: unknown) {
    return {
      output: "",
      durationMs: Date.now() - start,
      status: "error",
      errorMsg: err instanceof Error ? err.message : String(err),
    };
  }
}
