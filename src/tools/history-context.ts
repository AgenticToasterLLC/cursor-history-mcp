import type { LibraryConfig, Session } from "cursor-history";
import { z } from "zod";

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

export function readConfig(value: { workspace?: string; includeCrossWorkspaceSources?: boolean }, signal?: AbortSignal): LibraryConfig {
  return {
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
