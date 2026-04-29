import fs from "fs";
import path from "path";

/**
 * `.division/<ROLE>.md` 読み込みユーティリティ。
 *
 * Division API の Brief Gate（Leader Review Brief）が、評価対象の実装者ロール
 * （coder / writer 等）に応じた **静的なロールガイド Markdown** を取り込むために利用する。
 *
 * 読み込み優先順:
 *   1) `req.workspacePath` に `.division/<FILE>.md` が存在すればそれを使う（プロジェクト固有）
 *   2) Division API サーバー自身の cwd 配下 `.division/<FILE>.md` を使う（リポジトリ同梱の既定値）
 *   3) どちらも無ければ null（Brief Gate にガイドを連結しない）
 *
 * ファイルは `mtime` ベースでキャッシュし、編集即反映できるようにしている。
 */

const ROLE_TO_GUIDE_FILENAME: Record<string, string> = {
  coder: "CODER.md",
  writer: "WRITING.md",
  designer: "DESIGN.md",
  planner: "PLANNING.md",
  searcher: "SEARCH.md",
  "file-searcher": "SEARCH.md",
};

/**
 * 別名 → 正規ロールスラグ。`normalizeRoleSlug` の対象外で渡される可能性がある
 * 表記ゆれを軽く吸収する。
 */
const ROLE_ALIASES: Record<string, string> = {
  coding: "coder",
  writing: "writer",
  design: "designer",
  planning: "planner",
  search: "searcher",
  "file-search": "file-searcher",
};

interface CacheEntry {
  mtimeMs: number;
  size: number;
  content: string | null;
}

const cache = new Map<string, CacheEntry>();

function tryStat(filePath: string): fs.Stats | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function readWithCache(filePath: string): string | null {
  const stat = tryStat(filePath);
  if (!stat) return null;

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.content;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    return content;
  } catch {
    cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content: null });
    return null;
  }
}

/**
 * ロールスラグから `.division/<NAME>.md` のファイル名を返す。
 * 該当しないロールは null（ガイド対象外）。
 */
export function getDivisionGuideFilename(roleSlug: string): string | null {
  const lower = roleSlug.toLowerCase();
  const canonical = ROLE_ALIASES[lower] ?? lower;
  return ROLE_TO_GUIDE_FILENAME[canonical] ?? null;
}

export interface DivisionGuide {
  /** 例: "CODER.md" */
  filename: string;
  /** 実際に読み込んだ絶対パス */
  source: string;
  /** Markdown 本文 */
  content: string;
}

/**
 * 実装者ロール（coder / writer 等）に対応する `.division/<NAME>.md` を読み込む。
 *
 * @param roleSlug      評価対象のロール（例: "coder", "writer"）
 * @param workspacePath ユーザー側ワークスペースの絶対パス（オプション。あれば優先）
 * @returns ガイドが見つかれば本文を含むオブジェクト、見つからなければ null
 */
export function loadDivisionGuide(
  roleSlug: string,
  workspacePath?: string
): DivisionGuide | null {
  const filename = getDivisionGuideFilename(roleSlug);
  if (!filename) return null;

  const candidates: string[] = [];
  if (workspacePath && path.isAbsolute(workspacePath)) {
    candidates.push(path.join(workspacePath, ".division", filename));
  }
  candidates.push(path.join(process.cwd(), ".division", filename));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const content = readWithCache(candidate);
    if (content && content.trim().length > 0) {
      return { filename, source: candidate, content };
    }
  }
  return null;
}
