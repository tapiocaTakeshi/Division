import type { ChatMessage } from "../services/ai-executor";

/**
 * クライアント（IDE / CLI）が送ってくる chatHistory は、OpenAI Chat Completions 互換の
 * `system` / `tool` / `function` / `developer` ロールを含むことがある。
 * 一方サーバ側は `user` / `assistant` の 2 値しか扱わないので、ここで文字列プレフィックス付きの
 * `user` メッセージに落としこむ。情報は落とさないが enum エラーは避けられる。
 */
export interface RawHistoryMessage {
  role: string;
  content: string;
  /** OpenAI legacy tool/function 応答の識別子（あれば本文に残す） */
  name?: string | null;
  tool_call_id?: string | null;
}

export function normalizeChatHistory(
  raw: readonly RawHistoryMessage[] | undefined | null
): ChatMessage[] {
  if (!raw || raw.length === 0) return [];
  const out: ChatMessage[] = [];
  for (const msg of raw) {
    if (!msg || typeof msg.content !== "string") continue;
    const role = (msg.role ?? "").toLowerCase().trim();
    const content = msg.content;
    if (!content) continue;

    if (role === "user" || role === "assistant") {
      out.push({ role, content });
      continue;
    }

    if (role === "system" || role === "developer") {
      out.push({ role: "user", content: `[${role === "developer" ? "Developer" : "System"}]\n${content}` });
      continue;
    }

    if (role === "tool" || role === "function") {
      const label = msg.name ? `Tool: ${msg.name}` : "Tool result";
      const id = msg.tool_call_id ? ` (id=${msg.tool_call_id})` : "";
      out.push({ role: "user", content: `[${label}${id}]\n${content}` });
      continue;
    }
    out.push({ role: "user", content: `[${role || "unknown"}]\n${content}` });
  }
  return out;
}
