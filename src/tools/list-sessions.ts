/**
 * cursor_history_list tool - List Cursor AI chat sessions
 */

import { listSessionSummaries } from "cursor-history";
import type { SessionSummary, ResolvedSessionSummary } from "cursor-history";
import { z } from "zod";
import { toToolError } from "../errors.js";
import { readScopeShape, readScopeProperties, readConfig, formatTimestamp, throwIfAborted, type HandlerContext } from "./history-context.js";

/**
 * Input schema for the list tool
 */
const ListInputSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(20).optional(),
  offset: z.number().int().min(0).default(0).optional(),
  ...readScopeShape,
});

/**
 * Tool definition for MCP
 */
export const listSessionsTool = {
  name: "cursor_history_list",
  description:
    "List Cursor AI chat sessions. Returns recent sessions with metadata including workspace, message count, and timestamps.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "integer",
        description: "Maximum number of sessions to return (default: 20, max: 1000)",
        minimum: 1,
        maximum: 1000,
        default: 20,
      },
      offset: {
        type: "integer",
        description: "Number of sessions to skip for pagination (default: 0)",
        minimum: 0,
        default: 0,
      },
      ...readScopeProperties,
    },
    additionalProperties: false,
  },
};

function isAmbiguous(s: SessionSummary): s is Exclude<SessionSummary, ResolvedSessionSummary> {
  return s.resolutionState === "ambiguous";
}

function workspaceLabel(path: string | undefined): string {
  return path ? path.split(/[\\/]/).filter(Boolean).pop() || path : "No workspace";
}

/** Same output semantics as sourceSummary() in history-context.ts, for message-free summaries. */
function summarySource(s: ResolvedSessionSummary): string {
  const state = s.resolutionState ?? s.resolution?.state ??
    (s.source === "workspace-fallback" ? "partial" : "unknown");
  const detail = `Source: ${s.resolvedSource ?? s.source ?? "unknown"} · Data: ${state}`;
  return state === "partial"
    ? `${detail}\nPartial history: some content or sources are unavailable in this scope.`
    : detail;
}

/**
 * Handler for the list tool
 */
export async function handleListSessions(
  args: Record<string, unknown>,
  ctx: HandlerContext = {}
): Promise<string> {
  try {
    const parsed = ListInputSchema.parse(args);
    throwIfAborted(ctx.signal);

    const result = await listSessionSummaries({
      limit: parsed.limit,
      offset: parsed.offset,
      ...readConfig(parsed, ctx.signal),
    });

    const sessions = result.data;
    const { pagination } = result;
    const diagnostics = result.diagnostics ?? [];

    if (sessions.length === 0 && diagnostics.length === 0) {
      return "No Cursor chat sessions found.";
    }

    const lines: string[] = [
      `Found ${pagination.total} session(s). Showing ${sessions.length}:`,
      `Pagination: total=${pagination.total} offset=${pagination.offset} limit=${pagination.limit} hasMore=${pagination.hasMore}`,
      "",
    ];

    for (let i = 0; i < sessions.length; i++) {
      const summary = sessions[i];
      if (!summary) continue;

      const sessionIndex = (summary.index ?? pagination.offset + i) + 1;
      const scope = `${summary.indexScope ?? (parsed.workspace ? "workspace" : "global")}${parsed.workspace ? ` (${parsed.workspace})` : ""}`;

      if (isAmbiguous(summary)) {
        lines.push(
          `#${sessionIndex} - ${workspaceLabel(summary.canonicalWorkspacePath)} (ambiguous)`,
          `    ID: ${summary.id}`,
          `    Workspace: ${summary.canonicalWorkspacePath ?? summary.matchedWorkspacePath ?? "unknown"}`,
          `    Index scope: ${scope}`,
          `    Source: unresolved · Data: ambiguous · ${summary.occurrenceCount} divergent copies${summary.sourceRoles.length ? ` (${summary.sourceRoles.join(", ")})` : ""}`,
          "    Ambiguous: multiple divergent copies of this session exist; no copy was selected, so show/export by this entry is unavailable until the ambiguity is resolved.",
          ""
        );
        continue;
      }

      const workspace = summary.canonicalWorkspacePath ?? summary.workspace;
      const date = formatTimestamp(summary.timestamp, summary.createdAtSource);
      const text = (summary.title?.trim() || summary.preview || "").slice(0, 50);
      const preview = text ? `"${text}..."` : "(no messages)";
      lines.push(
        `#${sessionIndex} - ${workspaceLabel(summary.workspace)} (${date})`,
        `    ID: ${summary.id}`,
        `    Workspace: ${workspace}`,
        `    Index scope: ${scope}`,
        `    ${summarySource(summary)}`,
        `    ${summary.messageCount} messages · ${preview}`,
        ""
      );
    }

    if (diagnostics.length > 0) {
      lines.push("Diagnostics:");
      for (const d of diagnostics) {
        lines.push(`  - [${d.code}]${d.sessionId ? ` ${d.sessionId}:` : ""} ${d.message}${d.remedy ? ` (${d.remedy})` : ""}`);
      }
      lines.push("");
    }

    if (pagination.hasMore) {
      lines.push(
        `(${Math.max(0, pagination.total - pagination.offset - sessions.length)} more sessions available)`
      );
    }

    return lines.join("\n");
  } catch (error) {
    throw toToolError(error);
  }
}
