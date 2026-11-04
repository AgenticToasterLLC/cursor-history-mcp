/**
 * Content-free audit log for write tools (backup, restore, migrate).
 *
 * One JSON line per invocation is appended to `<sidecar dir>/audit.log`.
 * Only booleans, counts, a status, an error code and a duration are recorded.
 * Session ids, titles, message text, backup contents and paths are NEVER
 * written (not even hashed: low-entropy paths are trivially guessable from a
 * hash, and correlation is not needed for an operator-facing "what ran" log).
 * Audit failures never fail the tool. Opt out with CURSOR_HISTORY_MCP_AUDIT=0.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { McpToolError, mapCursorHistoryError } from "./errors.js";
import { errorCodeName } from "./types.js";

export interface AuditFlags {
  mode?: string;
  dryRun?: boolean;
  force?: boolean;
  confirm?: boolean;
}

export interface AuditEntry extends AuditFlags {
  time: string;
  tool: string;
  sessions: number | null;
  success: boolean;
  errorCode: string | null;
  durationMs: number;
}

export function auditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CURSOR_HISTORY_MCP_AUDIT?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** Sidecar directory: index path dir, then %LOCALAPPDATA%/cursor-history (Windows), then tmpdir. */
export function auditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const indexPath = env.CURSOR_HISTORY_INDEX_PATH?.trim();
  if (indexPath) return join(dirname(indexPath), "audit.log");
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "cursor-history", "audit.log");
  }
  return join(tmpdir(), "cursor-history-mcp", "audit.log");
}

export function writeAudit(entry: AuditEntry, env: NodeJS.ProcessEnv = process.env): void {
  if (!auditEnabled(env)) return;
  try {
    const file = auditLogPath(env);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Never fail the tool because the audit log is unwritable.
  }
}

/**
 * Runs a write-tool body and records one audit line. `fn` returns the result
 * text and the number of selected sessions (if known).
 */
export async function withAudit(
  tool: string,
  flags: AuditFlags,
  fn: () => Promise<{ text: string; sessions?: number }>,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const started = Date.now();
  const base = { time: new Date(started).toISOString(), tool, ...flags };
  try {
    const { text, sessions } = await fn();
    writeAudit({ ...base, sessions: sessions ?? null, success: true, errorCode: null, durationMs: Date.now() - started }, env);
    return text;
  } catch (error) {
    const mapped = error instanceof McpToolError ? error.mcp : mapCursorHistoryError(error);
    writeAudit(
      { ...base, sessions: null, success: false, errorCode: errorCodeName(mapped.code), durationMs: Date.now() - started },
      env
    );
    throw error;
  }
}

/** Extracts only boolean/enum flags from raw tool arguments (never values like paths or ids). */
export function flagsFrom(args: Record<string, unknown>): AuditFlags {
  const flags: AuditFlags = {};
  for (const key of ["dryRun", "force", "confirm"] as const) {
    if (typeof args[key] === "boolean") flags[key] = args[key] as boolean;
  }
  if (args.mode === "move" || args.mode === "copy") flags.mode = args.mode;
  return flags;
}
