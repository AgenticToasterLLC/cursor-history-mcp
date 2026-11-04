import type { LibraryConfig, Session, WorkspaceScopeResolution } from "cursor-history";
import { z } from "zod";
import { catalogMode } from "./catalog.js";

export const readScopeShape = {
  workspace: z.string().min(1).optional(),
  includeCrossWorkspaceSources: z.boolean().optional(),
};

export const readScopeProperties = {
  workspace: {
    type: "string",
    description: "Workspace path. Reuse the same scope for listing and reading a session index.",
  },
  includeCrossWorkspaceSources: {
    type: "boolean",
    description: "Opt in to complementary sources outside this workspace, only for already selected session IDs. Default: false.",
    default: false,
  },
};

export const sessionSelectorShape = {
  sessionIndex: z.number().int().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  ...readScopeShape,
};

export function hasOneSelector(value: { sessionIndex?: number; sessionId?: string }): boolean {
  return (value.sessionIndex !== undefined) !== (value.sessionId !== undefined);
}

/** Message for a violated exactly-one-of rule between two selector arguments. */
export function selectorMessage(a: string, b: string, aGiven: boolean): string {
  return `Provide exactly one of ${a} or ${b} (${aGiven ? "both were" : "neither was"} given)`;
}

/** Zod superRefine callback enforcing exactly one of sessionId / sessionIndex. */
export function refineOneSelector(value: { sessionIndex?: number; sessionId?: string }, ctx: z.RefinementCtx): void {
  if (!hasOneSelector(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: selectorMessage("sessionId", "sessionIndex", value.sessionId !== undefined),
    });
  }
}

export const sessionSelectorProperties = {
  sessionIndex: { type: "integer", minimum: 1, description: "One-based index from a list with the same workspace scope. Prefer sessionId for reuse. Specify this OR sessionId, not both." },
  sessionId: { type: "string", minLength: 1, description: "Exact case-sensitive native UUID returned by list/search (preferred). Specify this OR sessionIndex, not both." },
  ...readScopeProperties,
};

export function readSelector(value: { sessionIndex?: number; sessionId?: string }): string | number {
  if (value.sessionId !== undefined) return value.sessionId;
  if (value.sessionIndex !== undefined) return value.sessionIndex - 1;
  throw new Error("Provide a session selector");
}

/** Per-call context handed to tool handlers by the server. */
export interface HandlerContext {
  /** Fires on client cancellation or when the per-call time budget elapses. */
  signal?: AbortSignal;
}

/** Last path segment of a POSIX or Windows path. */
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Cooperative abort check. SQLite calls are synchronous, so an abort cannot
 * interrupt a read in flight; it takes effect between source pages and at the
 * checkpoints handlers place around library calls.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/**
 * Library config for a read. Only callers passing `useCatalog` (currently list) get the
 * sidecar catalog mode from CURSOR_HISTORY_MCP_CATALOG; search/show/export stay direct.
 */
export function readConfig(
  value: { workspace?: string; includeCrossWorkspaceSources?: boolean },
  signal?: AbortSignal,
  options: { useCatalog?: boolean } = {}
): LibraryConfig {
  return {
    ...(options.useCatalog ? { catalog: catalogMode() } : {}),
    ...(signal ? { signal } : {}),
    workspace: value.workspace,
    includeCrossWorkspaceSources: value.includeCrossWorkspaceSources ?? false,
  };
}

export function sourceSummary(session: Session): string {
  const state = session.resolutionState ?? session.resolution?.state ??
    (session.source === "workspace-fallback" ? "partial" : "unknown");
  const detail = `Source: ${session.resolvedSource ?? session.source ?? "unknown"} · Data: ${state}`;
  return state === "partial"
    ? `${detail}\nPartial history: some content or sources are unavailable in this scope.`
    : detail;
}

export function formatTimestamp(value: string, source?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || source === "epoch-unknown") return "Unknown time";
  const approximate = !source || source === "unknown" || source.startsWith("inferred-") || source === "session-fallback";
  return `${approximate ? "≈ " : ""}${date.toLocaleString()} [${source ?? "unknown"}]`;
}

/**
 * Renders the workspace scope outcome as content-free text (paths only), or
 * undefined when nothing needs saying (unscoped, or a plain exact match).
 */
export function formatScopeNotice(scope: WorkspaceScopeResolution | undefined): string | undefined {
  if (!scope) return undefined;
  switch (scope.state) {
    case "empty":
      return `Workspace ${scope.path} is known to Cursor history but has no chat sessions (matched ${scope.matchKind}).`;
    case "not-found": {
      const lines = [`No workspace in local Cursor history matches ${scope.requested}.`];
      const suggestions = scope.suggestions.slice(0, 5);
      if (suggestions.length > 0) {
        lines.push("Did you mean:");
        for (const s of suggestions) lines.push(`  - ${s.path} (${s.reason}, score ${s.score.toFixed(2)})`);
      }
      lines.push("Use cursor_history_workspaces to list known workspace paths.");
      return lines.join("\n");
    }
    case "matched":
      return scope.matchKind === "unique-suffix"
        ? `Workspace ${scope.requested} resolved to ${scope.path} (matched ${scope.matchKind}).`
        : undefined;
    default:
      return undefined;
  }
}
