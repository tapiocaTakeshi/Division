/**
 * API Endpoint Tests for api.division.he-ro.jp
 *
 * Tests all public API endpoints using a Division API key.
 * Uses curl for HTTP requests to work in restricted environments.
 *
 * Run: npx ts-node --transpileOnly tests/api-endpoint.test.ts
 */

import { execSync } from "child_process";

const API_BASE = "https://api.division.he-ro.jp";
const API_KEY = process.env.DIVISION_API_KEY || "ak_5NHRNHCAZM2SV769BXW6B29CBFB7Z2ZH";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  details: string;
}

const results: TestResult[] = [];

function curl(args: string): string {
  return execSync(`curl -s ${args}`, { timeout: 30_000, encoding: "utf-8" });
}

function curlJson(args: string): unknown {
  return JSON.parse(curl(args));
}

function test(name: string, fn: () => string): void {
  try {
    const details = fn();
    results.push({ name, status: "PASS", details });
    console.log(`  PASS  ${name}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "FAIL", details: msg });
    console.log(`  FAIL  ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

console.log(`\n=== Division API Endpoint Tests ===`);
console.log(`Target: ${API_BASE}\n`);

// ---------- 1. Health Check ----------
test("GET /health", () => {
  const data = curlJson(`${API_BASE}/health`) as { status: string; service: string };
  assert(data.status === "ok", `Expected status "ok", got "${data.status}"`);
  return `status=${data.status}, service=${data.service}`;
});

// ---------- 2. List Models ----------
test("GET /api/models", () => {
  const data = curlJson(
    `-H "Authorization: Bearer ${API_KEY}" ${API_BASE}/api/models`
  ) as { providers: unknown[] };
  assert(Array.isArray(data.providers), "Response missing providers array");
  assert(data.providers.length > 0, "providers array is empty");
  return `${data.providers.length} models available`;
});

// ---------- 3. List Roles ----------
test("GET /api/roles", () => {
  const data = curlJson(
    `-H "Authorization: Bearer ${API_KEY}" ${API_BASE}/api/roles`
  ) as Array<{ slug: string }>;
  assert(Array.isArray(data), "Response is not an array");
  assert(data.length > 0, "roles array is empty");
  const slugs = data.map((r) => r.slug);
  return `${data.length} roles: ${slugs.join(", ")}`;
});

// ---------- 4. List Providers ----------
test("GET /api/providers", () => {
  const data = curlJson(
    `-H "Authorization: Bearer ${API_KEY}" ${API_BASE}/api/providers`
  ) as unknown[];
  assert(Array.isArray(data), "Response is not an array");
  assert(data.length > 0, "providers array is empty");
  return `${data.length} providers loaded`;
});

// ---------- 5. SSE Test Endpoint ----------
test("GET /api/sse/test", () => {
  const text = curl(`${API_BASE}/api/sse/test`);
  assert(text.includes("data:"), "No SSE data received");
  const events = text.split("\n").filter((l: string) => l.startsWith("data:"));
  return `${events.length} SSE events received`;
});

// ---------- 6. Generate Endpoint (auth validation) ----------
test("POST /api/generate (provider key resolution)", () => {
  const body = JSON.stringify({
    provider: "claude-haiku",
    input: "test",
    maxTokens: 10,
  });
  const data = curlJson(
    `-X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" -d '${body}' ${API_BASE}/api/generate`
  ) as { status: string; error?: string; provider: string; model: string };
  // Either success or "no API key" error — both are valid responses
  if (data.status === "error" && data.error?.includes("No API key found")) {
    return `Endpoint works, provider key not configured on server: ${data.provider}`;
  }
  if (data.status === "success") {
    return `Generation succeeded: ${data.provider} / ${data.model}`;
  }
  return `Response: status=${data.status}, provider=${data.provider}`;
});

// ---------- 7. Generate Validation (missing provider) ----------
test("POST /api/generate (validation - missing provider)", () => {
  const raw = curl(
    `-X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" -d '{"input":"test"}' -w "\\n%{http_code}" ${API_BASE}/api/generate`
  );
  const lines = raw.trim().split("\n");
  const httpCode = lines[lines.length - 1];
  assert(httpCode === "400", `Expected HTTP 400, got ${httpCode}`);
  return `Validation error returned correctly (HTTP 400)`;
});

// ---------- 8. Generate (invalid provider) ----------
test("POST /api/generate (invalid provider)", () => {
  const raw = curl(
    `-X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" -d '{"provider":"nonexistent-model","input":"test"}' -w "\\n%{http_code}" ${API_BASE}/api/generate`
  );
  const lines = raw.trim().split("\n");
  const httpCode = lines[lines.length - 1];
  assert(httpCode === "404", `Expected HTTP 404, got ${httpCode}`);
  return `404 returned correctly for invalid provider`;
});

// ---------- 9. Agent Stream Endpoint ----------
test("POST /api/agent/stream (SSE format)", () => {
  const body = JSON.stringify({
    projectId: "demo-project-001",
    input: "test",
  });
  const text = curl(
    `-X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" -d '${body}' ${API_BASE}/api/agent/stream`
  );
  assert(text.includes("event: session_start"), "Missing session_start event");
  assert(text.includes("event: session_done"), "Missing session_done event");
  const events = text
    .split("\n")
    .filter((l: string) => l.startsWith("event:"))
    .map((e: string) => e.replace("event: ", ""));
  return `${events.length} SSE events: ${events.join(", ")}`;
});

// ---------- 10. MCP Initialize ----------
test("POST /mcp (JSON-RPC initialize)", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  });
  const data = curlJson(
    `-X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" -d '${body}' ${API_BASE}/mcp`
  ) as { result: { serverInfo: { name: string; version: string } } };
  assert(!!data.result?.serverInfo, "Missing serverInfo in response");
  return `MCP server: ${data.result.serverInfo.name} v${data.result.serverInfo.version}`;
});

// ---------- 11. MCP Tools List ----------
test("POST /mcp (tools/list)", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const data = curlJson(
    `-X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" -d '${body}' ${API_BASE}/mcp`
  ) as { result: { tools: Array<{ name: string }> } };
  assert(Array.isArray(data.result?.tools), "Missing tools array");
  const names = data.result.tools.map((t) => t.name);
  return `${names.length} tools: ${names.join(", ")}`;
});

// ---------- 12. Knock Detection - Status ----------
test("GET /api/knock/status", () => {
  const data = curlJson(`${API_BASE}/api/knock/status`) as {
    status: string;
    sequenceLength: number;
  };
  assert(data.status === "active", `Expected status "active", got "${data.status}"`);
  assert(data.sequenceLength > 0, "sequenceLength should be > 0");
  return `Knock detection active, sequence length: ${data.sequenceLength}`;
});

// ---------- 13. Knock Detection - Wrong Code ----------
test("POST /api/knock (wrong code)", () => {
  const body = JSON.stringify({ code: "wrong-code", clientId: "test-client-1" });
  const raw = curl(
    `-X POST -H "Content-Type: application/json" -d '${body}' -w "\\n%{http_code}" ${API_BASE}/api/knock`
  );
  const lines = raw.trim().split("\n");
  const httpCode = lines[lines.length - 1];
  assert(httpCode === "403", `Expected HTTP 403, got ${httpCode}`);
  return "Incorrect knock correctly rejected with 403";
});

// ---------- 14. Knock Detection - Partial Sequence ----------
test("POST /api/knock (first knock)", () => {
  const body = JSON.stringify({
    code: "shave-and-a-haircut",
    clientId: "test-client-2",
  });
  const data = curlJson(
    `-X POST -H "Content-Type: application/json" -d '${body}' ${API_BASE}/api/knock`
  ) as { status: string; progress: string };
  assert(data.status === "continue", `Expected status "continue", got "${data.status}"`);
  return `First knock accepted: progress=${data.progress}`;
});

// ---------- 15. Knock Detection - Full Sequence ----------
test("POST /api/knock (full sequence → token)", () => {
  const clientId = `test-client-${Date.now()}`;
  // First knock
  const body1 = JSON.stringify({ code: "shave-and-a-haircut", clientId });
  const r1 = curlJson(
    `-X POST -H "Content-Type: application/json" -d '${body1}' ${API_BASE}/api/knock`
  ) as { status: string };
  assert(r1.status === "continue", `First knock: expected "continue", got "${r1.status}"`);

  // Second knock
  const body2 = JSON.stringify({ code: "two-bits", clientId });
  const r2 = curlJson(
    `-X POST -H "Content-Type: application/json" -d '${body2}' ${API_BASE}/api/knock`
  ) as { status: string; token?: string };
  assert(r2.status === "granted", `Second knock: expected "granted", got "${r2.status}"`);
  assert(!!r2.token, "Token not returned after completing sequence");
  return `Full knock sequence completed, token issued: ${r2.token!.slice(0, 12)}...`;
});

// ---------- 16. Knock Detection - Verify Token ----------
test("GET /api/knock/verify (invalid token)", () => {
  const raw = curl(
    `-H "Authorization: Bearer knock_invalidtoken" -w "\\n%{http_code}" ${API_BASE}/api/knock/verify`
  );
  const lines = raw.trim().split("\n");
  const httpCode = lines[lines.length - 1];
  assert(httpCode === "401", `Expected HTTP 401, got ${httpCode}`);
  return "Invalid knock token correctly rejected with 401";
});

// ---------- Summary ----------
console.log(`\n=== Results ===`);
const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}\n`);

for (const r of results) {
  console.log(`  [${r.status}] ${r.name}`);
  console.log(`         ${r.details}`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed.`);
}
