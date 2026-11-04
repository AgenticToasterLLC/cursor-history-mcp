/**
 * cursor_history_workspaces tool - Inventory of known historical workspace paths
 */

import { listWorkspaces } from "cursor-history";
import type { WorkspaceInventoryEntry } from "cursor-history";
import { z } from "zod";
import { toToolError } from "../errors.js";
import { throwIfAborted, type HandlerContext } from "./history-context.js";

const WorkspacesInputSchema = z.object({
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1000).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
});

export const workspacesTool = {
  name: "cursor_history_workspaces",
  description:
    "List workspace paths known to local Cursor history (paths and metadata only, no session content). Use a returned path as the workspace argument of cursor_history_list, search, show or export.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Case-insensitive substring filter matched against each workspace path and its aliases",
        minLength: 1,
      },
      limit: {
        type: "integer",
        description: "Maximum number of workspaces to return (default: 50, max: 1000)",
        minimum: 1,
        maximum: 1000,
        default: 50,
      },
      offset: {
        type: "integer",
        description: "Number of workspaces to skip for pagination (default: 0)",
        minimum: 0,
        default: 0,
      },
    },
    additionalProperties: false,
  },
};

export const INVENTORY_NOTE =
  "Inventory lists every workspace Cursor has recorded; some may have no chat sessions. Use the path with cursor_history_list's workspace argument.";

export function formatWorkspaceEntry(entry: WorkspaceInventoryEntry, position: number): string[] {
  const aliases = entry.aliases.filter(alias => alias !== entry.path);
  return [
    `#${position} ${entry.path}`,
    ...(aliases.length > 0 ? [`    Aliases: ${aliases.join("; ")}`] : []),
    `    Sources: ${entry.sources.length > 0 ? entry.sources.join(", ") : "unknown"}`,
    `    workspaceStorage dirs: ${entry.workspaceStorageIds.length}`,
    `    Last modified: ${entry.lastModifiedAt ?? "unknown"}`,
    "",
  ];
}

export function formatWorkspaces(
  entries: WorkspaceInventoryEntry[],
  pagination: { total: number; limit: number; offset: number; hasMore: boolean },
  query?: string
): string {
  const lines: string[] = [
    `Found ${pagination.total} known workspace(s)${query ? ` matching "${query}"` : ""}. Showing ${entries.length}:`,
    `Pagination: total=${pagination.total} offset=${pagination.offset} limit=${pagination.limit} hasMore=${pagination.hasMore}`,
    "",
  ];
  entries.forEach((entry, i) => lines.push(...formatWorkspaceEntry(entry, pagination.offset + i + 1)));
  if (pagination.hasMore) {
    lines.push(`(${Math.max(0, pagination.total - pagination.offset - entries.length)} more workspaces available; raise offset)`, "");
  }
  lines.push(INVENTORY_NOTE);
  return lines.join("\n");
}

export async function handleWorkspaces(
  args: Record<string, unknown>,
  ctx: HandlerContext = {}
): Promise<string> {
  try {
    const parsed = WorkspacesInputSchema.parse(args);
    throwIfAborted(ctx.signal);
    const result = await listWorkspaces({
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      query: parsed.query,
      limit: parsed.limit,
      offset: parsed.offset,
    });
    throwIfAborted(ctx.signal);
    if (result.data.length === 0) {
      return `No known workspaces${parsed.query ? ` match "${parsed.query}"` : " found in local Cursor history"}.\n${INVENTORY_NOTE}`;
    }
    return formatWorkspaces(result.data, result.pagination, parsed.query);
  } catch (error) {
    throw toToolError(error);
  }
}
