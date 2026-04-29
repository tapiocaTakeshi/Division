/**
 * 実行中タスクのインメモリレジストリ。
 *
 * `/api/tasks/execute` などの長時間実行エンドポイントが
 * 自身を `runId` で登録し、`/api/tasks/stop` から
 * `AbortController.abort()` で中断できるようにする。
 *
 * NOTE: プロセス内メモリのみを使用するので、Vercel のように
 * 複数インスタンスへルーティングされる環境では同一インスタンスに
 * リクエストが届いた場合のみ機能する。Sticky に届きやすくするには
 * クライアントが `X-Run-Id` を素早く受け取って同じインスタンス
 * （= 同じ `set-cookie` セッションなど）に stop を送る必要がある。
 */

import { randomUUID } from "node:crypto";

export type RunKind =
  | "tasks-execute"
  | "tasks-execute-stream"
  | "agent-run"
  | "agent-stream"
  | string;

export interface RunMeta {
  kind: RunKind;
  projectId?: string;
  roleSlug?: string;
  userId?: string;
}

interface RegistryEntry extends RunMeta {
  runId: string;
  controller: AbortController;
  startedAt: number;
}

const entries = new Map<string, RegistryEntry>();

export function newRunId(): string {
  return randomUUID();
}

/**
 * 新しい AbortController を作成しレジストリに登録する。
 * 既に同じ runId が登録されていた場合は、それを abort してから上書きする
 * （クライアントが古い runId を再利用したケースで、古い実行を確実に止めるため）。
 */
export function registerRun(runId: string, meta: RunMeta): AbortController {
  const existing = entries.get(runId);
  if (existing) {
    try {
      existing.controller.abort("Replaced by new run with the same runId");
    } catch {
      /* ignore */
    }
  }
  const controller = new AbortController();
  entries.set(runId, {
    runId,
    controller,
    startedAt: Date.now(),
    ...meta,
  });
  return controller;
}

export function unregisterRun(runId: string): void {
  entries.delete(runId);
}

/**
 * 指定された runId の実行を中断する。中断対象が見つかれば true を返す。
 */
export function abortRun(runId: string, reason?: string): boolean {
  const entry = entries.get(runId);
  if (!entry) return false;
  try {
    entry.controller.abort(reason ?? "Aborted by /api/tasks/stop");
  } catch {
    /* ignore */
  }
  entries.delete(runId);
  return true;
}

/** 全アクティブランを中断し、件数を返す。 */
export function abortAllRuns(reason?: string): number {
  const ids = Array.from(entries.keys());
  for (const id of ids) {
    abortRun(id, reason);
  }
  return ids.length;
}

export interface RunSummary {
  runId: string;
  kind: RunKind;
  projectId?: string;
  roleSlug?: string;
  userId?: string;
  startedAt: number;
  ageMs: number;
}

export function listRuns(): RunSummary[] {
  const now = Date.now();
  return Array.from(entries.values()).map((e) => ({
    runId: e.runId,
    kind: e.kind,
    projectId: e.projectId,
    roleSlug: e.roleSlug,
    userId: e.userId,
    startedAt: e.startedAt,
    ageMs: now - e.startedAt,
  }));
}

/**
 * 渡された値が AbortError 由来かどうかを判定する。
 * fetch の AbortSignal、Node の `node:fs/promises` などはどちらも
 * `name === "AbortError"` または `code === "ABORT_ERR"` を立てる。
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}
