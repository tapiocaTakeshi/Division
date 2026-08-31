/**
 * Context Policy Tests
 *
 * Leader が「誰に何を渡すか」を決め、このレイヤーがルールで制約する。
 * ここで守らせるのは、AI の判断に任せてはいけないものだけ:
 * サイズ上限 / 秘密情報 / ロール権限 / コンテキスト上限 / 循環要求。
 *
 * Run: npx ts-node --transpileOnly tests/context-policy.test.ts
 */

import {
  applyContextPolicy,
  ContextRequestLedger,
  isRoleAllowedPath,
  isSecretFile,
  MAX_PULL_ROUNDS_PER_TASK,
  parseContextRequest,
  redactSecrets,
  renderDecision,
  roleReceivesFileBodies,
} from "../src/services/context-policy";
import { parseProjectContext, type ProjectContext } from "../src/services/project-context";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  details: string;
}

const results: TestResult[] = [];

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

/** テスト用のプロジェクトコンテキストを直接組み立てる */
function ctxOf(bodies: Record<string, string>): ProjectContext {
  const report = Object.entries(bodies)
    .map(([path, body]) => ["### `" + path + "`", "```ts", body, "```", ""].join("\n"))
    .join("\n");
  return parseProjectContext(report);
}

const CTX = ctxOf({
  "src/auth/Auth.ts": "export class Auth { static login() {} }",
  "src/pages/Login.tsx": "export default function Login() { return null; }",
  "tests/auth.test.ts": "export const authSuite = 1;",
  ".env": "DATABASE_PASSWORD=hunter2hunter2\nSTRIPE_SECRET_KEY=sk-livedeadbeefdeadbeef",
  ".env.example": "DATABASE_PASSWORD=\nSTRIPE_SECRET_KEY=",
  "src/config.ts": 'export const apiKey = "sk-abcdefghijklmnopqrstuvwx";',
  "prisma/migrations/001_init.sql": "CREATE TABLE users (id text);",
});

console.log(`\n=== Context Policy Tests ===\n`);

// --- 秘密情報 ---

test("資格情報ファイルを見分ける", () => {
  assert(isSecretFile(".env"), ".env が秘密扱いされない");
  assert(isSecretFile("config/.env.production"), "環境別 .env が秘密扱いされない");
  assert(isSecretFile("certs/server.pem"), ".pem が秘密扱いされない");
  assert(isSecretFile("deploy/id_rsa"), "id_rsa が秘密扱いされない");
  assert(isSecretFile("gcp/service-account-prod.json"), "サービスアカウントが秘密扱いされない");
  assert(!isSecretFile(".env.example"), ".env.example まで秘密扱いされている");
  assert(!isSecretFile("src/auth/Auth.ts"), "普通のソースが秘密扱いされている");
  return "secret files classified";
});

test("秘密ファイルは本文を配らない", () => {
  const d = applyContextPolicy("coder", [{ path: ".env" }], CTX);
  assert(d.granted.length === 0, ".env の本文が配られている");
  assert(d.rejected[0]?.reason === "secret-file", `理由が違う: ${d.rejected[0]?.reason}`);
  const rendered = renderDecision("coder", d);
  assert(!rendered.includes("hunter2hunter2"), "本文が出力に漏れている");
  assert(rendered.includes(".env"), "存在自体は伝えるべき");
  return "secret file body withheld, path still disclosed";
});

test("Leader が指名しても秘密ファイルは通らない", () => {
  const d = applyContextPolicy(
    "security-reviewer",
    [{ path: ".env", reason: "Leader が配分" }],
    CTX
  );
  assert(d.granted.length === 0, "security-reviewer には通ってしまっている");
  return "policy overrides the leader's assignment";
});

test("普通のソース内の秘密値は行単位でマスクする", () => {
  const d = applyContextPolicy("coder", [{ path: "src/config.ts" }], CTX);
  assert(d.granted.length === 1, "ファイルごと落ちている");
  assert(d.granted[0].redacted, "マスクしたフラグが立っていない");
  assert(!d.granted[0].body.includes("sk-abcdefghijklmnopqrstuvwx"), "秘密値が残っている");
  assert(d.granted[0].body.includes("REDACTED"), "マスク痕跡が無い");
  return "secret value masked, file still delivered";
});

test("よくあるトークン書式をマスクする", () => {
  const cases = [
    'const t = "sk-1234567890abcdefghij";',
    "GITHUB_TOKEN=ghp_1234567890abcdefghij1234",
    "aws_key = AKIAIOSFODNN7EXAMPLE",
    'API_KEY: "super-secret-value-here"',
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
  ];
  for (const c of cases) {
    const { text, redacted } = redactSecrets(c);
    assert(redacted, `マスクされなかった: ${c}`);
    assert(text.includes("REDACTED"), `マスク痕跡が無い: ${c}`);
  }
  return `${cases.length} token shapes masked`;
});

test("秘密が無い本文は書き換えない", () => {
  const src = "export class Auth { static login() {} }";
  const { text, redacted } = redactSecrets(src);
  assert(!redacted, "無関係な本文がマスク扱いされている");
  assert(text === src, "本文が変わっている");
  return "clean source untouched";
});

// --- ロール権限 ---

test("本文を受け取らないロールには何も渡さない", () => {
  assert(!roleReceivesFileBodies("planner"), "planner が本文を受け取る設定になっている");
  const d = applyContextPolicy("planner", [{ path: "src/auth/Auth.ts" }], CTX);
  assert(d.granted.length === 0, "planner に本文が渡っている");
  assert(d.rejected[0]?.reason === "role-not-permitted", `理由が違う: ${d.rejected[0]?.reason}`);
  return "planner gets level 1 only";
});

test("ロールごとの拒否パスが効く", () => {
  assert(!isRoleAllowedPath("designer", "prisma/migrations/001_init.sql"), "designer に SQL が通る");
  assert(isRoleAllowedPath("coder", "prisma/migrations/001_init.sql"), "coder に SQL が通らない");
  const d = applyContextPolicy("designer", [{ path: "prisma/migrations/001_init.sql" }], CTX);
  assert(d.rejected[0]?.reason === "role-not-permitted", `理由が違う: ${d.rejected[0]?.reason}`);
  return "per-role path denial enforced";
});

// --- 上限 ---

test("合計コンテキスト上限を超えたら打ち切る", () => {
  const big = ctxOf({ "a.ts": "x".repeat(5000), "b.ts": "y".repeat(5000), "c.ts": "z".repeat(5000) });
  const d = applyContextPolicy(
    "coder",
    [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
    big,
    { maxTotalChars: 6000 }
  );
  assert(d.totalChars <= 6000, `上限を超えている: ${d.totalChars}`);
  assert(d.granted.length < 3, "全ファイルが通ってしまっている");
  assert(d.rejected.some((r) => r.reason === "budget-exceeded"), "上限超過が記録されていない");
  return `${d.granted.length} files, ${d.totalChars} chars under a 6000 cap`;
});

test("1 ファイルのサイズ上限で末尾を切る", () => {
  const big = ctxOf({ "a.ts": "x".repeat(50000) });
  const d = applyContextPolicy("coder", [{ path: "a.ts" }], big, { maxCharsPerFile: 1000 });
  assert(d.granted[0].truncated, "切り詰めフラグが立っていない");
  assert(d.granted[0].body.length === 1000, `長さが違う: ${d.granted[0].body.length}`);
  return "per-file size cap enforced";
});

test("ファイル数の上限が効く", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 10; i++) many[`src/f${i}.ts`] = `export const v${i} = ${i};`;
  const d = applyContextPolicy(
    "coder",
    Object.keys(many).map((path) => ({ path })),
    ctxOf(many),
    { maxFiles: 3 }
  );
  assert(d.granted.length === 3, `件数が違う: ${d.granted.length}`);
  return "file-count cap enforced";
});

// --- 存在しないファイル・重複 ---

test("本文未取得のファイルは理由つきで伝える", () => {
  const d = applyContextPolicy("coder", [{ path: "src/does-not-exist.ts" }], CTX);
  assert(d.granted.length === 0, "存在しないものが配られている");
  assert(d.rejected[0]?.reason === "not-found", `理由が違う: ${d.rejected[0]?.reason}`);
  assert(renderDecision("coder", d).includes("ツールで読めます"), "Level 3 への誘導が無い");
  return "missing bodies point at level 3";
});

test("同じパスの重複指定を弾く", () => {
  const d = applyContextPolicy("coder", [{ path: "src/auth/Auth.ts" }, { path: "src/auth/Auth.ts" }], CTX);
  assert(d.granted.length === 1, "重複して配られている");
  assert(d.rejected[0]?.reason === "duplicate", `理由が違う: ${d.rejected[0]?.reason}`);
  return "duplicates collapsed";
});

test("配布済みのパスは再配布しない", () => {
  const d = applyContextPolicy("coder", [{ path: "src/auth/Auth.ts" }], CTX, {
    alreadyGranted: ["src/auth/Auth.ts"],
  });
  assert(d.granted.length === 0, "再配布されている");
  assert(d.rejected[0]?.reason === "already-granted", `理由が違う: ${d.rejected[0]?.reason}`);
  return "already-granted suppressed when asked";
});

// --- Pull 型 ---

test("追加コンテキスト要求を読む", () => {
  const out = [
    "実装しました。ただし Auth の実装が見えていません。",
    "",
    "```json context-request",
    '{ "paths": ["src/auth/Auth.ts", "./src/pages/Login.tsx"], "reason": "実装に必要" }',
    "```",
  ].join("\n");
  const req = parseContextRequest(out);
  assert(req !== null, "要求が読めていない");
  assert(req!.paths.length === 2, `件数が違う: ${req!.paths.length}`);
  assert(req!.paths[1] === "src/pages/Login.tsx", "./ が正規化されていない");
  assert(req!.reason === "実装に必要", "理由が読めていない");
  return req!.paths.join(", ");
});

test("要求が無い出力では null を返す", () => {
  assert(parseContextRequest("普通の回答です") === null, "誤検出している");
  assert(parseContextRequest("") === null, "空文字で誤検出している");
  assert(
    parseContextRequest("```json context-request\nこわれたJSON\n```") === null,
    "壊れた JSON で落ちている"
  );
  return "no false positives";
});

test("1 タスクの追加要求回数に上限がある", () => {
  const ledger = new ContextRequestLedger();
  for (let i = 0; i < MAX_PULL_ROUNDS_PER_TASK; i++) {
    const denial = ledger.tryConsume(0, { paths: [`src/f${i}.ts`] });
    assert(denial === null, `${i + 1} 回目が拒否された: ${denial}`);
    ledger.recordGranted(0, [`src/f${i}.ts`]);
  }
  const over = ledger.tryConsume(0, { paths: ["src/another.ts"] });
  assert(over !== null, "上限を超えても通っている");
  return over as string;
});

test("同じ要求の繰り返しを循環として止める", () => {
  const ledger = new ContextRequestLedger();
  assert(ledger.tryConsume(0, { paths: ["src/auth/Auth.ts"] }) === null, "1 回目が拒否された");
  ledger.recordGranted(0, ["src/auth/Auth.ts"]);
  const again = ledger.tryConsume(0, { paths: ["src/auth/Auth.ts"] });
  assert(again !== null, "同じ要求が素通りしている");
  return again as string;
});

test("台帳はタスクごとに独立している", () => {
  const ledger = new ContextRequestLedger();
  ledger.recordGranted(0, ["src/auth/Auth.ts"]);
  assert(
    ledger.tryConsume(1, { paths: ["src/auth/Auth.ts"] }) === null,
    "別タスクの配布履歴で拒否されている"
  );
  return "per-task ledger, so a second task of the same role still gets the file";
});

test("実行全体の要求総数にも上限がある", () => {
  const ledger = new ContextRequestLedger();
  let denials = 0;
  for (let task = 0; task < 10; task++) {
    for (let round = 0; round < MAX_PULL_ROUNDS_PER_TASK; round++) {
      if (ledger.tryConsume(task, { paths: [`t${task}-r${round}.ts`] }) !== null) denials++;
    }
  }
  assert(denials > 0, "実行全体の上限が効いていない");
  return `${denials} request(s) denied by the run-wide cap`;
});

// --- Summary ---
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
