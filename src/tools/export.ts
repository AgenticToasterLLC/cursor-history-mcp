/**
 * cursor_history_export tool - Export session to Markdown or JSON
 */

import { exportSessionToMarkdown, exportSessionToJson } from "cursor-history";
import { z } from "zod";
import { toToolError } from "../errors.js";
import { sessionSelectorShape, refineOneSelector, sessionSelectorProperties, readSelector, readConfig, throwIfAborted, type HandlerContext } from "./history-context.js";

export const DEFAULT_EXPORT_MAX_CHARS = 200_000;

/**
 * Input schema for the export tool
 */
const ExportInputSchema = z.object({
  ...sessionSelectorShape,
  format: z.enum(["markdown", "json"]).default("markdown").optional(),
  chunkOffset: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(1).max(2_000_000).optional(),
}).superRefine(refineOneSelector);

/**
 * Tool definition for MCP
 */
export const exportTool = {
  name: "cursor_history_export",
  description:
    "Export a Cursor AI chat session to Markdown or JSON format. Returns the formatted content. Small exports are returned unchanged; larger ones are returned in chunks with a leading '[export chunk: ...]' header giving nextChunkOffset.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ...sessionSelectorProperties,
      format: {
        type: "string",
        description:
          "Export format: 'markdown' for human-readable, 'json' for structured data. For JSON, chunks are raw text slices of one document: concatenate them (without the header lines) to rebuild it; a single chunk is not standalone JSON.",
        enum: ["markdown", "json"],
        default: "markdown",
      },
      chunkOffset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description:
          "Character offset into the full export at which to start (default: 0). Use nextChunkOffset from the previous chunk header to continue.",
      },
      maxChars: {
        type: "integer",
        minimum: 1,
        maximum: 2000000,
        default: DEFAULT_EXPORT_MAX_CHARS,
        description:
          "Maximum characters of export returned per call (default: 200000, max: 2000000). If the whole export fits it is returned unchanged with no header.",
      },
    },
    additionalProperties: false,
  },
};

/**
 * Pure chunking: returns the full text unchanged when it fits (offset 0),
 * otherwise the slice prefixed with a one-line header. The slice end never
 * splits a UTF-16 surrogate pair, so concatenated chunks equal the original.
 */
export function chunkExport(full: string, chunkOffset = 0, maxChars = DEFAULT_EXPORT_MAX_CHARS): string {
  if (chunkOffset === 0 && full.length <= maxChars) return full;
  const total = full.length;
  const start = Math.min(chunkOffset, total);
  let end = Math.min(start + maxChars, total);
  if (end < total && end - start > 1) {
    const code = full.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  const complete = end >= total;
  const header = `[export chunk: chars ${start}-${end} of ${total} · complete: ${complete}${complete ? "" : ` · nextChunkOffset: ${end}`}]`;
  return `${header}\n${full.slice(start, end)}`;
}

/**
 * Handler for the export tool
 */
export async function handleExport(
  args: Record<string, unknown>,
  ctx: HandlerContext = {}
): Promise<string> {
  try {
    const parsed = ExportInputSchema.parse(args);
    const format = parsed.format ?? "markdown";
    throwIfAborted(ctx.signal);

    // cursor-history uses 0-based indexing internally
    const index = readSelector(parsed);
    const config = readConfig(parsed, ctx.signal);

    // The library has no paged export yet: the full text is built, then sliced.
    const full = format === "json"
      ? await exportSessionToJson(index, config)
      : await exportSessionToMarkdown(index, config);
    throwIfAborted(ctx.signal);
    return chunkExport(full, parsed.chunkOffset, parsed.maxChars);
  } catch (error) {
    throw toToolError(error);
  }
}
