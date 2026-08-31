/**
 * Project Context Tests
 *
 * file-searcher のレポートを共有コンテキストへ変換するロジックの単体テスト。
 * 外部 I/O を使わないので、API キーもネットワークも不要。
 *
 * Run: npx ts-node --transpileOnly tests/project-context.test.ts
 */

import {
  FILE_SEARCHER_OUTPUT_CONTRACT,
  isEmptyProjectContext,
  mergeProjectContext,
  normalizeContextRoleSlug,
  parseProjectContext,
  relevanceForRole,
  renderContextForRole,
  renderSharedContext,
  selectRelevantFilesForRole,
} from "../src/services/project-context";

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

// --- Fixtures ---

/** file-searcher が出力契約に従って構造化 JSON を付けたレポート */
const REPORT_WITH_JSON = [
  "認証まわりを調査しました。Google ログインは未実装です。",
  "",
  "### `src/auth/Auth.ts`",
  "```ts",
  "export class Auth {",
  "  static async login() {}",
  "}",
  "```",
  "",
  "### `src/auth/AuthProvider.tsx`",
  "```tsx",
  'import { Auth } from "./Auth";',
  "export const AuthProvider = () => null;",
  "```",
  "",
  "### `src/pages/Login.tsx`",
  "```tsx",
  'import { AuthProvider } from "../auth/AuthProvider";',
  "export default function Login() { return null; }",
  "```",
  "",
  "### `tests/auth.test.ts`",
  "```ts",
  'import { Auth } from "../src/auth/Auth";',
  "export const authSuite = 1;",
  "```",
  "",
  "```json division-context",
  JSON.stringify(
    {
      summary: "認証まわりの調査",
      relevant_files: [
        { path: "src/auth/Auth.ts", reason: "認証処理の中心" },
        { path: "src/pages/Login.tsx", reason: "ログインUI" },
      ],
      dependencies: ["src/pages/Login.tsx -> src/auth/AuthProvider.tsx"],
      symbols: ["Auth.login", "AuthProvider"],
    },
    null,
    2
  ),
  "```",
].join("\n");

/** 構造化 JSON を出さなかった場合（Orchestra のローカル file-search 形式） */
const REPORT_WITHOUT_JSON = [
  "## ワークスペース: `/repo`",
  "",
  "### 反復ファイルサーチ サマリ（2 回 / 最大 3）",
  "",
  "- 反復 1: 3 / 200 件 のファイルを本文込みで読み込みました（キーワード: login）。",
  "",
  "### ディレクトリツリー（関連ファイルの追加読取が必要ならパスを明示してください）",
  "",
  "- package.json",
  "- .env.example",
  "- src/api/auth.ts",
  "- src/auth/Auth.ts",
  "",
  "### `src/auth/Auth.ts`",
  "```ts",
  "export class Auth {}",
  "```",
  "",
  "### `src/api/auth.ts`",
  "```ts",
  "export const authRouter = 1;",
  "```",
  "",
].join("\n");

console.log(`\n=== Project Context Tests ===\n`);

test("空入力は空コンテキストになる", () => {
  assert(isEmptyProjectContext(parseProjectContext("")), "空文字が空コンテキストにならない");
  assert(isEmptyProjectContext(parseProjectContext("   \n  ")), "空白のみが空コンテキストにならない");
  return "empty input -> empty context";
});

test("構造化 JSON ブロックを優先して読む", () => {
  const ctx = parseProjectContext(REPORT_WITH_JSON);
  assert(ctx.summary === "認証まわりの調査", `summary=${ctx.summary}`);
  const top = ctx.relevantFiles[0];
  assert(top.path === "src/auth/Auth.ts", `先頭の関連ファイルが違う: ${top.path}`);
  assert(top.reason === "認証処理の中心", `reason が読めていない: ${top.reason}`);
  assert(ctx.symbols.includes("Auth.login"), "JSON の symbols が反映されていない");
  return `${ctx.relevantFiles.length} relevant files, summary from JSON`;
});

test("ファイル本文を path 単位で取り出す", () => {
  const ctx = parseProjectContext(REPORT_WITH_JSON);
  assert(Object.keys(ctx.bodies).length === 4, `bodies=${Object.keys(ctx.bodies).length}`);
  assert(ctx.bodies["src/auth/Auth.ts"].includes("static async login"), "本文が欠けている");
  return `${Object.keys(ctx.bodies).length} file bodies`;
});

test("import 文から依存エッジを推定する", () => {
  const ctx = parseProjectContext(REPORT_WITH_JSON);
  assert(
    ctx.dependencies.includes("src/auth/AuthProvider.tsx -> src/auth/Auth.ts"),
    `相対 import が解決できていない: ${ctx.dependencies.join(" / ")}`
  );
  assert(
    ctx.dependencies.includes("src/pages/Login.tsx -> src/auth/AuthProvider.tsx"),
    "JSON 由来の依存が消えている"
  );
  return ctx.dependencies.join(" / ");
});

test("JSON が無くても Markdown から復元する", () => {
  const ctx = parseProjectContext(REPORT_WITHOUT_JSON);
  assert(ctx.files.includes("src/auth/Auth.ts"), "本文つきファイルが一覧に無い");
  assert(ctx.files.includes("package.json"), "ツリー中のファイルが拾えていない");
  assert(ctx.files.includes(".env.example"), "ドットファイルが拾えていない");
  assert(!ctx.summary.includes("package.json"), "サマリにツリーが混入している");
  return `${ctx.files.length} files without a JSON block`;
});

test("シンボルらしき文字列をファイル扱いしない", () => {
  const ctx = parseProjectContext(
    "調査対象は Auth.login と AuthProvider です。\n\n### `src/auth/Auth.ts`\n```ts\nexport class Auth {}\n```\n"
  );
  assert(!ctx.files.includes("Auth.login"), `Auth.login がファイル扱いされている: ${ctx.files.join(",")}`);
  assert(ctx.files.includes("src/auth/Auth.ts"), "実ファイルが落ちている");
  return ctx.files.join(", ");
});

test("Level 1 は全ロール共通で、本文を含まない", () => {
  const ctx = parseProjectContext(REPORT_WITH_JSON);
  const shared = renderSharedContext(ctx);
  assert(shared.includes("src/auth/Auth.ts"), "ファイル一覧が無い");
  assert(shared.includes("認証処理の中心"), "reason が出ていない");
  assert(!shared.includes("static async login"), "Level 1 に本文が混ざっている");
  return `${shared.length} chars, bodies excluded`;
});

test("Level 2 はロールごとに関連ファイルが変わる", () => {
  const ctx = parseProjectContext(REPORT_WITH_JSON);
  const coder = selectRelevantFilesForRole(ctx, "coder").map((f) => f.path);
  const tester = selectRelevantFilesForRole(ctx, "tester").map((f) => f.path);
  assert(tester[0] === "tests/auth.test.ts", `tester の先頭が違う: ${tester[0]}`);
  assert(coder[0] !== "tests/auth.test.ts", `coder がテストを最優先している: ${coder[0]}`);
  return `coder=${coder[0]} / tester=${tester[0]}`;
});

test("本文を渡さないロールは Level 1 だけになる", () => {
  const ctx = parseProjectContext(REPORT_WITH_JSON);
  assert(relevanceForRole("planner").attachBodies === false, "planner に本文が付く設定になっている");
  const planner = renderContextForRole(ctx, "planner");
  const coder = renderContextForRole(ctx, "coder");
  assert(!planner.includes("static async login"), "planner に本文が渡っている");
  assert(coder.includes("static async login"), "coder に本文が渡っていない");
  assert(coder.length > planner.length, "coder のコンテキストが planner より小さい");
  return `planner=${planner.length} chars, coder=${coder.length} chars`;
});

test("ロール名の表記ゆれを吸収する", () => {
  assert(normalizeContextRoleSlug("filesearch") === "file-searcher", "filesearch が正規化されない");
  assert(normalizeContextRoleSlug("file_search") === "file-searcher", "file_search が正規化されない");
  assert(normalizeContextRoleSlug("coding") === "coder", "coding が正規化されない");
  assert(normalizeContextRoleSlug("Review") === "reviewer", "Review が正規化されない");
  assert(
    relevanceForRole("design").bodyBudgetChars === relevanceForRole("designer").bodyBudgetChars,
    "design と designer で設定が違う"
  );
  return "aliases normalized";
});

test("未知のロールにもフォールバックのコンテキストを渡す", () => {
  const ctx = parseProjectContext(REPORT_WITH_JSON);
  const md = renderContextForRole(ctx, "translator");
  assert(md.includes("プロジェクト共有コンテキスト"), "Level 1 が渡っていない");
  assert(md.includes("static async login"), "既定の本文添付が効いていない");
  return `${md.length} chars for an unknown role`;
});

test("本文の予算を超えたら切り詰める", () => {
  const big = "x".repeat(50000);
  const ctx = parseProjectContext(
    `### \`src/big.ts\`\n\`\`\`ts\n${big}\n\`\`\`\n`
  );
  const md = renderContextForRole(ctx, "designer", { bodyBudgetChars: 500 });
  assert(md.length < 5000, `予算が効いていない: ${md.length} chars`);
  assert(md.includes("以降は省略"), "省略の断りが入っていない");
  return `${md.length} chars under a 500 char budget`;
});

test("2 回目の file-searcher 結果はマージされる", () => {
  const first = parseProjectContext(REPORT_WITH_JSON);
  const second = parseProjectContext(
    "### `src/payments/Checkout.ts`\n```ts\nexport const checkout = 1;\n```\n"
  );
  const merged = mergeProjectContext(first, second);
  assert(merged.files.includes("src/auth/Auth.ts"), "1 回目のファイルが消えている");
  assert(merged.files.includes("src/payments/Checkout.ts"), "2 回目のファイルが入っていない");
  assert(merged.bodies["src/auth/Auth.ts"] !== undefined, "1 回目の本文が消えている");
  assert(merged.relevantFiles[0].path === "src/payments/Checkout.ts", "新しい結果が優先されていない");
  return `${merged.files.length} files after merge`;
});

test("マージは空コンテキストを壊さない", () => {
  const ctx = parseProjectContext(REPORT_WITH_JSON);
  assert(mergeProjectContext(null, ctx).files.length === ctx.files.length, "null 起点のマージが壊れている");
  assert(mergeProjectContext(ctx, parseProjectContext("")).files.length === ctx.files.length, "空とのマージで欠落した");
  return "merge is null-safe";
});

test("出力契約は JSON 例を含む", () => {
  assert(FILE_SEARCHER_OUTPUT_CONTRACT.includes("division-context"), "契約にタグが無い");
  assert(FILE_SEARCHER_OUTPUT_CONTRACT.includes("relevant_files"), "契約にキーが無い");
  return "contract looks well-formed";
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
