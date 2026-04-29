import fs from "fs";
import path from "path";

/**
 * `.divisionignore` 互換マッチャー（gitignore 形式の最小実装）。
 *
 * - ワークスペースルートに `.divisionignore` を置くと、そこに書かれたパターンに一致する
 *   ファイル／フォルダは Division のサーバー側ファイルツール（read/list/search/write/edit）から
 *   読まれなくなる。
 * - `.git/`, `node_modules/`, `.divisionignore` 自体は **常にデフォルトで無視**（ユーザーは
 *   `!.git/` のように否定パターンで上書き可能）。
 *
 * 対応するパターン構文（gitignore のサブセット — 一般的なものはほぼカバー）:
 *   - `# コメント` / 空行 はスキップ
 *   - `pattern`        … 任意の階層で一致（フォルダ・ファイル両方）
 *   - `/pattern`       … ルート直下のみ一致
 *   - `pattern/`       … ディレクトリのみ一致
 *   - `*`              … `/` を含まない任意の文字列
 *   - `**`             … 任意のパス（`/` を跨いでよい）
 *   - `?`              … 1 文字（`/` 以外）
 *   - `!pattern`       … 否定（前のルールで無視されたものを戻す）
 */

type Rule = {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
};

export type DivisionIgnoreMatcher = {
  /** 相対パス（POSIX 形式 or OS ネイティブ）に対し、無視されるかを判定する */
  isIgnored: (relPath: string, isDirectory: boolean) => boolean;
  /** `.divisionignore` ファイル自体が存在するかどうか */
  isEnabled: boolean;
  /** ユーザーが書いた raw のパターン一覧（デフォルト除外を除く） */
  userPatterns: string[];
  /** デバッグ用 */
  workspaceRoot: string;
};

const DEFAULT_IGNORE_PATTERNS = [".git/", "node_modules/", ".divisionignore"];

const cache = new Map<
  string,
  { mtimeMs: number; matcher: DivisionIgnoreMatcher }
>();

function compileRule(pattern: string): Rule | null {
  let p = pattern.trim();
  if (!p || p.startsWith("#")) return null;

  let negate = false;
  if (p.startsWith("!")) {
    negate = true;
    p = p.slice(1);
  }

  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
  }

  // gitignore: pattern が `/` を含む（末尾以外）か leading `/` ならルートからアンカー、
  // それ以外は任意の階層で一致。
  const hasInternalSlash = p.includes("/") && !p.startsWith("/");
  const anchored = p.startsWith("/") || hasInternalSlash;
  if (p.startsWith("/")) p = p.slice(1);

  let regex = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**`
        if (p[i + 2] === "/") {
          regex += "(?:.+/)?";
          i += 3;
        } else if (i + 2 >= p.length) {
          regex += ".*";
          i += 2;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if ("+^$|()[]{}.\\".includes(c)) {
      regex += "\\" + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }

  const finalRe = anchored
    ? "^" + regex + "(?:/.*)?$"
    : "(?:^|/)" + regex + "(?:/.*)?$";

  try {
    return { re: new RegExp(finalRe), negate, dirOnly };
  } catch {
    return null;
  }
}

function normalizeRel(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/g, "");
}

/**
 * ワークスペースルートにある `.divisionignore` を読み込み、マッチャーを返す。
 * mtime ベースでキャッシュされ、ファイルが更新されると再読込される。
 * `.divisionignore` が無くてもデフォルト除外（`.git/`, `node_modules/`, `.divisionignore`）は適用される。
 */
export function loadDivisionIgnore(
  workspaceRoot: string
): DivisionIgnoreMatcher {
  const root = path.resolve(workspaceRoot);
  const filePath = path.join(root, ".divisionignore");

  let mtimeMs = 0;
  let raw = "";
  let exists = false;
  try {
    const stat = fs.statSync(filePath);
    mtimeMs = stat.mtimeMs;
    exists = true;
    const cached = cache.get(root);
    if (cached && cached.mtimeMs === mtimeMs) return cached.matcher;
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    // ファイルが無いケース。デフォルト除外のみ適用する。
    const cached = cache.get(root);
    if (cached && cached.mtimeMs === 0 && !cached.matcher.isEnabled) {
      return cached.matcher;
    }
  }

  const rules: Rule[] = [];
  const userPatterns: string[] = [];

  // 先にデフォルト除外を入れる（後続の user pattern で `!.git/` 等の否定が可能になる）
  for (const dp of DEFAULT_IGNORE_PATTERNS) {
    const compiled = compileRule(dp);
    if (compiled) rules.push(compiled);
  }

  for (const line of raw.split(/\r?\n/)) {
    const compiled = compileRule(line);
    if (compiled) {
      rules.push(compiled);
      userPatterns.push(line.trim());
    }
  }

  const isIgnored = (relPath: string, isDirectory: boolean): boolean => {
    const p = normalizeRel(relPath);
    if (!p) return false;
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.re.test(p)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  };

  const matcher: DivisionIgnoreMatcher = {
    isIgnored,
    isEnabled: exists,
    userPatterns,
    workspaceRoot: root,
  };

  cache.set(root, { mtimeMs, matcher });
  return matcher;
}

/**
 * パスがワークスペース外ならそのまま false を返す（ignore 対象外）。
 * 内部にあれば相対パスを計算してマッチャーで判定する。
 */
export function isPathIgnored(
  absPath: string,
  workspaceRoot: string,
  isDirectory: boolean
): { ignored: boolean; reason?: string; matcher: DivisionIgnoreMatcher } {
  const matcher = loadDivisionIgnore(workspaceRoot);
  const root = matcher.workspaceRoot;
  const abs = path.resolve(absPath);
  if (!abs.startsWith(root)) return { ignored: false, matcher };
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..")) return { ignored: false, matcher };
  const ignored = matcher.isIgnored(rel, isDirectory);
  return {
    ignored,
    matcher,
    reason: ignored ? rel : undefined,
  };
}
