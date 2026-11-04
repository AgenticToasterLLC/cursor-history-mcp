/**
 * cursor_history_search tool - Search across all sessions
 */

import { searchSessions } from "cursor-history";
import { z } from "zod";
import { toToolError } from "../errors.js";
import { readScopeShape, readScopeProperties, readConfig, sourceSummary, pathBasename, throwIfAborted, type HandlerContext } from "./history-context.js";
import { safeSlice } from "./show-session.js";
import type { SearchResult } from "cursor-history";

export const DEFAULT_SEARCH_MAX_CHARS = 60_000;
/** Per-result display caps: context lines per side and chars per line. */
const MAX_CONTEXT_LINES_SHOWN = 5;
const MAX_LINE_CHARS = 300;

/**
 * Input schema for the search tool
 */
const SearchInputSchema = z.object({
  ...readScopeShape,
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(10).optional(),
  context: z.number().int().min(0).max(500).default(50).optional(),
  maxChars: z.number().int().min(1).max(1_000_000).optional(),
});

/**
 * Tool definition for MCP
 */
export const searchTool = {
  name: "cursor_history_search",
  description:
    "Search across all Cursor AI chat sessions for a keyword or phrase. Returns matching sessions with context around each match.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ...readScopeProperties,
      query: {
        type: "string",
        description: "The search query (keyword or phrase to find)",
        minLength: 1,
      },
      limit: {
        type: "integer",
        description: "Maximum number of results to return (default: 10)",
        minimum: 1,
        maximum: 100,
        default: 10,
      },
      context: {
        type: "integer",
        description:
          "Number of source lines of context requested around each match (default: 50). Output shows at most 5 lines per side, each cut at 300 chars.",
        minimum: 0,
        maximum: 500,
        default: 50,
      },
      maxChars: {
        type: "integer",
        description:
          "Maximum characters of search output (default: 60000, max: 1000000). Results beyond the bound are omitted and reported as 'results shown: k of n'.",
        minimum: 1,
        maximum: 1000000,
        default: 60000,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${safeSlice(line, MAX_LINE_CHARS)}... [line cut at ${MAX_LINE_CHARS} of ${line.length} chars]`
    : line;
}

/** Renders one result with capped context. */
export function renderResult(result: SearchResult): string {
  const workspaceName = result.session.workspace ? pathBasename(result.session.workspace) : "No workspace";
  const before = result.contextBefore ?? [];
  const after = result.contextAfter ?? [];
  const shownBefore = before.slice(-MAX_CONTEXT_LINES_SHOWN);
  const shownAfter = after.slice(0, MAX_CONTEXT_LINES_SHOWN);
  const omitted = before.length - shownBefore.length + (after.length - shownAfter.length);
  return [
    `Session (${workspaceName}):`,
    `  ID: ${result.session.id}`,
    `  ${sourceSummary(result.session)}`,
    `  Message index: ${result.messageIndex} · UTF-16 offset: ${result.offset}`,
    ...shownBefore.map(line => `    ${clip(line)}`),
    `  "${clip(result.match)}"`,
    ...shownAfter.map(line => `    ${clip(line)}`),
    ...(omitted > 0 ? [`    (${omitted} more context line(s) omitted; use show or export for more)`] : []),
    "",
  ].join("\n");
}

/**
 * Bounds total output: results are added until the next one would exceed
 * maxChars (the first result is always included).
 */
export function formatSearchOutput(
  query: string,
  results: SearchResult[],
  options: { limit: number; maxChars?: number; workspace?: string }
): string {
  const maxChars = options.maxChars ?? DEFAULT_SEARCH_MAX_CHARS;
  const blocks: string[] = [];
  let used = 0;
  for (const result of results) {
    const block = renderResult(result);
    if (blocks.length > 0 && used + block.length + 1 > maxChars) break;
    blocks.push(block);
    used += block.length + 1;
  }
  const truncated = blocks.length < results.length;
  const scope = options.workspace ? `workspace ${options.workspace}` : "all workspaces";
  const limitNote = results.length >= options.limit
    ? ` The limit of ${options.limit} was reached, so further matches may exist; raise limit (max 100) or narrow with workspace.`
    : "";
  return [
    `Found ${results.length} match(es) for "${query}":`,
    "",
    blocks.join("\n"),
    `results shown: ${blocks.length} of ${results.length} returned · truncated: ${truncated}`,
    ...(truncated ? [`Output was bounded at maxChars=${maxChars}; raise maxChars (max 1000000) or lower limit/context to see the remaining ${results.length - blocks.length} result(s).`] : []),
    `Coverage: search scanned ${scope} with a full scan through the direct source reader (not an index), so the scan is complete for that scope.${limitNote}`,
  ].join("\n");
}

/**
 * Handler for the search tool
 */
export async function handleSearch(
  args: Record<string, unknown>,
  ctx: HandlerContext = {}
): Promise<string> {
  try {
    const parsed = SearchInputSchema.parse(args);
    throwIfAborted(ctx.signal);
    const limit = parsed.limit ?? 10;

    const results = await searchSessions(parsed.query, {
      ...readConfig(parsed, ctx.signal),
      limit,
      context: parsed.context,
    });
    throwIfAborted(ctx.signal);

    if (results.length === 0) {
      return `No matches found for "${parsed.query}".\nCoverage: full scan of ${parsed.workspace ? `workspace ${parsed.workspace}` : "all workspaces"} through the direct source reader (not an index); no match exists in that scope.`;
    }

    return formatSearchOutput(parsed.query, results, { limit, maxChars: parsed.maxChars, workspace: parsed.workspace });
  } catch (error) {
    throw toToolError(error);
  }
}
