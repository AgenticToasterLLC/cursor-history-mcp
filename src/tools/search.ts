/**
 * cursor_history_search tool - Search across all sessions
 */

import { searchSessions } from "cursor-history";
import { z } from "zod";
import { McpToolError, toToolError } from "../errors.js";
import { MCP_ERROR_CODES } from "../types.js";
import { readScopeShape, readScopeProperties, readConfig, formatScopeNotice, sourceSummary, pathBasename, throwIfAborted, type HandlerContext } from "./history-context.js";
import { safeSlice } from "./show-session.js";
import type { CatalogInfo, LibraryConfig, SearchResult, WorkspaceScopeResolution } from "cursor-history";

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
  order: z.enum(["relevance", "recent"]).optional(),
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
      order: {
        type: "string",
        enum: ["relevance", "recent"],
        default: "relevance",
        description:
          "relevance ranks every matching session by match count (complete but slower on large histories); recent returns the newest matching sessions first and stops early (fast; more matches may exist).",
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

/** Read scope a search ran under; message indexes are only valid under the same scope. */
export interface SearchReadScope {
  workspace?: string;
  includeCrossWorkspaceSources?: boolean;
}

/** Exact cursor_history_show arguments that open this hit under the same scope. */
export function openWithLine(result: SearchResult, scope: SearchReadScope = {}): string {
  const args = [`sessionId=${result.session.id}`, `messageOffset=${result.messageIndex}`];
  if (scope.workspace) args.push(`workspace=${JSON.stringify(scope.workspace)}`);
  if (scope.includeCrossWorkspaceSources) args.push("includeCrossWorkspaceSources=true");
  return `  Open with: cursor_history_show ${args.join(" ")} (use the same scope; message indexes differ between scopes)`;
}

/** Renders one result with capped context. */
export function renderResult(result: SearchResult, scope: SearchReadScope = {}): string {
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
    openWithLine(result, scope),
    "",
  ].join("\n");
}

function skippedLine(ids: string[]): string[] {
  return ids.length > 0
    ? [`Skipped ${ids.length} ambiguous session(s): ${ids.join(", ")} (divergent copies; not searched)`]
    : [];
}

type ReaderOrder = "match-count" | "recent";

/** How the reader answered the search; every field comes from non-enumerable result metadata. */
export interface SearchMeta {
  mode?: "indexed" | "direct";
  reason?: string;
  catalog?: CatalogInfo;
  /** Order the reader reports it used (absent on readers without searchOrder). */
  order?: ReaderOrder;
  /** False means more matching sessions may exist beyond those returned. */
  exhaustive?: boolean;
  /** Order the caller asked for. */
  requestedOrder?: ReaderOrder;
}

const REASON_TEXT: Record<string, string> = {
  QUERY_TOO_SHORT: "the query is shorter than 3 characters",
  QUERY_NOT_ASCII: "the query is not plain ASCII",
  INDEX_BUILDING: "the search index is still building",
  INDEX_NOT_READY: "the search index is not ready",
};

/** Reads the non-enumerable search metadata off a reader result list. */
export function searchMetaOf(results: unknown, requestedOrder: ReaderOrder): SearchMeta {
  const r = results as {
    searchMode?: "indexed" | "direct";
    searchModeReason?: string;
    catalog?: CatalogInfo;
    searchOrder?: ReaderOrder;
    searchExhaustive?: boolean;
  };
  return { mode: r.searchMode, reason: r.searchModeReason, catalog: r.catalog, order: r.searchOrder, exhaustive: r.searchExhaustive, requestedOrder };
}

/** Coverage and order disclosure lines. `found` is the number of sessions returned. */
export function coverageLines(meta: SearchMeta | undefined, found: number, ambiguousSkipped = false): string[] {
  const stale = meta?.catalog?.state === "stale" && meta.mode !== "direct";
  const partial = meta?.exhaustive === false;
  const qualifier = ambiguousSkipped ? ", except for the skipped ambiguous session(s)" : "";
  const lines: string[] = [];
  if (stale) {
    const refresh = meta?.catalog?.refreshScheduled === false
      ? "No refresh is running; call cursor_history_index_refresh."
      : "A refresh is running.";
    lines.push(`Coverage: index is STALE (Cursor history changed); results may miss recent messages. ${refresh}`);
  } else if (meta?.mode === "indexed") {
    lines.push(partial
      ? "Coverage: index-assisted search verified against source; not exhaustive (see Order)."
      : `Coverage: index-assisted search verified against source; complete for this scope${qualifier}.`);
  } else {
    const reason = meta?.reason ? ` The index was not used: ${REASON_TEXT[meta.reason] ?? `reason ${meta.reason}`}.` : "";
    lines.push(partial
      ? `Coverage: scan of this scope (direct); not exhaustive (see Order).${reason}`
      : `Coverage: full scan of this scope (direct); complete${qualifier}.${reason}`);
  }
  if (partial) {
    lines.push(`Order: most recent matching sessions first; stopped after ${found} sessions. More matching sessions may exist; use order=relevance for a complete ranked search or increase limit.`);
  } else if (meta?.requestedOrder === "recent" && meta.order === undefined) {
    lines.push("Order: this reader did not report a search order; recent order requires a newer reader, so results may be in relevance order.");
  }
  return lines;
}

/**
 * Bounds total output: results are added until the next one would exceed
 * maxChars (the first result is always included).
 */
export function formatSearchOutput(
  query: string,
  results: SearchResult[],
  options: { limit: number; maxChars?: number; workspace?: string; includeCrossWorkspaceSources?: boolean; skippedAmbiguous?: string[]; scope?: WorkspaceScopeResolution; meta?: SearchMeta }
): string {
  const maxChars = options.maxChars ?? DEFAULT_SEARCH_MAX_CHARS;
  const blocks: string[] = [];
  let used = 0;
  for (const result of results) {
    const block = renderResult(result, { workspace: options.workspace, includeCrossWorkspaceSources: options.includeCrossWorkspaceSources });
    if (blocks.length > 0 && used + block.length + 1 > maxChars) break;
    blocks.push(block);
    used += block.length + 1;
  }
  const truncated = blocks.length < results.length;
  const limitNote = results.length >= options.limit
    ? [`The limit of ${options.limit} was reached, so further matches may exist; raise limit (max 100) or narrow with workspace.`]
    : [];
  const skipped = options.skippedAmbiguous ?? [];
  const scopeNotice = formatScopeNotice(options.scope);
  const sessions = new Set(results.map(r => r.session.id)).size;
  return [
    ...(scopeNotice ? [scopeNotice] : []),
    `Found ${results.length} match(es) for "${query}":`,
    "",
    blocks.join("\n"),
    `results shown: ${blocks.length} of ${results.length} returned · truncated: ${truncated}`,
    ...(truncated ? [`Output was bounded at maxChars=${maxChars}; raise maxChars (max 1000000) or lower limit/context to see the remaining ${results.length - blocks.length} result(s).`] : []),
    ...skippedLine(skipped),
    ...coverageLines(options.meta, sessions, skipped.length > 0),
    ...limitNote,
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
    const requestedOrder: ReaderOrder = parsed.order === "recent" ? "recent" : "match-count";

    // Supplying onDiagnostic makes the reader skip ambiguous sessions (and
    // report them) instead of rejecting the whole search.
    const skippedAmbiguous: string[] = [];
    const config: LibraryConfig & { searchOrder?: ReaderOrder } = {
      ...readConfig(parsed, ctx.signal, { searchIndex: true }),
      limit,
      context: parsed.context,
      // Only sent when non-default so a reader without searchOrder never sees an unknown key.
      ...(requestedOrder === "recent" ? { searchOrder: requestedOrder } : {}),
      onDiagnostic: (d: { code: string; sessionId?: string }) => {
        if (d.code === "SESSION_AMBIGUOUS" && d.sessionId && !skippedAmbiguous.includes(d.sessionId)) {
          skippedAmbiguous.push(d.sessionId);
        }
      },
    };
    let results;
    try {
      results = await searchSessions(parsed.query, config);
    } catch (error) {
      const e = error as { name?: unknown; message?: unknown };
      if (requestedOrder === "recent" && e.name === "InvalidConfigError" && /searchOrder/.test(String(e.message))) {
        throw new McpToolError({
          code: MCP_ERROR_CODES.INVALID_ARGUMENTS,
          message: "order=recent requires a newer cursor-history reader than the one installed.",
          remedy: "Use order=relevance, or upgrade the cursor-history dependency.",
        });
      }
      throw error;
    }
    throwIfAborted(ctx.signal);
    const meta = searchMetaOf(results, requestedOrder);

    if (results.length === 0) {
      const scopeNotice = formatScopeNotice(results.scope);
      const where = parsed.workspace ? `workspace ${parsed.workspace}` : "all workspaces";
      const unsearchable = results.scope?.state === "empty" || results.scope?.state === "not-found";
      return [
        ...(scopeNotice ? [scopeNotice] : []),
        `No matches found for "${parsed.query}".`,
        ...skippedLine(skippedAmbiguous),
        ...(unsearchable ? [`Coverage: ${where} has no searchable sessions.`] : coverageLines(meta, 0, skippedAmbiguous.length > 0)),
      ].join("\n");
    }

    return formatSearchOutput(parsed.query, results, { limit, maxChars: parsed.maxChars, workspace: parsed.workspace, includeCrossWorkspaceSources: parsed.includeCrossWorkspaceSources, skippedAmbiguous, scope: results.scope, meta });
  } catch (error) {
    throw toToolError(error);
  }
}
