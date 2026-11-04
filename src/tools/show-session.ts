/**
 * cursor_history_show tool - Show full session content
 */

import { getSession } from "cursor-history";
import type { Message } from "cursor-history";
import { z } from "zod";
import { toToolError } from "../errors.js";
import { sessionSelectorShape, refineOneSelector, sessionSelectorProperties, readSelector, readConfig, sourceSummary, formatTimestamp, pathBasename, throwIfAborted, type HandlerContext } from "./history-context.js";

export const DEFAULT_SHOW_MAX_CHARS = 100_000;
const TOOL_RESULT_LIMIT = 500;
const THINKING_LIMIT = 200;
const RULE = "─".repeat(40);

/**
 * Input schema for the show tool
 */
const ShowInputSchema = z.object({
  ...sessionSelectorShape,
  messageOffset: z.number().int().min(0).optional(),
  maxMessages: z.number().int().min(1).max(1000).optional(),
  maxChars: z.number().int().min(1).max(1_000_000).optional(),
}).superRefine(refineOneSelector);

/**
 * Tool definition for MCP
 */
export const showSessionTool = {
  name: "cursor_history_show",
  description:
    "Inspect the available messages and tool activity in a Cursor session, with source and timestamp provenance. Output is paged: the header states which messages were returned, and when truncated is true, call again with nextMessageOffset. Tool results (500 chars) and thinking (200 chars) are abbreviated; use export for unabridged available content.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ...sessionSelectorProperties,
      messageOffset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Zero-based index of the first message to render (default: 0). Use nextMessageOffset from a previous truncated response to continue.",
      },
      maxMessages: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Maximum number of messages to render in this call (default: as many as fit in maxChars).",
      },
      maxChars: {
        type: "integer",
        minimum: 1,
        maximum: 1000000,
        default: DEFAULT_SHOW_MAX_CHARS,
        description: "Character budget for the rendered messages (default: 100000, max: 1000000). At least one message is always rendered; an oversized single message is cut and marked.",
      },
    },
    additionalProperties: false,
  },
};

/** Cuts text at a UTF-16 boundary that does not split a surrogate pair. */
export function safeSlice(text: string, end: number): string {
  if (end >= text.length) return text;
  let cut = end;
  const code = text.charCodeAt(cut - 1);
  if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/** Renders one message to text; payload abbreviations are labeled explicitly. */
export function renderMessage(message: Message): string {
  const timestamp = formatTimestamp(message.timestamp, message.timestampSource);
  const roleLabel = message.role === "user" ? "You" : "Assistant";
  const lines: string[] = [`${roleLabel}: ${timestamp}`, ""];

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    for (const toolCall of message.toolCalls) {
      lines.push(`🔧 ${toolCall.name}`);
      if (toolCall.params) {
        lines.push(`   Params: ${JSON.stringify(toolCall.params)}`);
      }
      if (toolCall.result) {
        const cut = toolCall.result.length > TOOL_RESULT_LIMIT;
        lines.push(
          `   Result: ${cut ? safeSlice(toolCall.result, TOOL_RESULT_LIMIT) + "..." : toolCall.result}` +
            (cut ? ` (abbreviated to ${TOOL_RESULT_LIMIT} of ${toolCall.result.length} chars; use export for full content)` : "")
        );
      }
      const statusIcon = toolCall.status === "completed" ? "✓" : "✗";
      lines.push(`   Status: ${statusIcon} ${toolCall.status}`);
    }
    lines.push("");
  }

  if (message.role === "assistant" && message.thinking) {
    const cut = message.thinking.length > THINKING_LIMIT;
    lines.push(
      `💭 ${cut ? safeSlice(message.thinking, THINKING_LIMIT) + "..." : message.thinking}` +
        (cut ? ` (abbreviated to ${THINKING_LIMIT} of ${message.thinking.length} chars; use export for full content)` : ""),
      ""
    );
  }

  lines.push(message.content, "", RULE, "");
  return lines.join("\n");
}

export interface PageOptions {
  messageOffset?: number;
  maxMessages?: number;
  maxChars?: number;
}

export interface PageResult {
  /** Rendered message blocks, concatenated. */
  body: string;
  /** Zero-based offset of the first rendered message. */
  from: number;
  /** Number of messages rendered (a cut message counts). */
  count: number;
  total: number;
  /** True when any message was left out or cut. */
  truncated: boolean;
  /** Set when the first rendered message had to be cut at maxChars. */
  cutMessage?: { index: number; shown: number; of: number };
  /** Offset to pass to continue; defined when messages remain. */
  nextMessageOffset?: number;
}

/**
 * Pure paging math. Stops before exceeding maxChars or maxMessages, but always
 * renders at least one message when any remain, cutting it if needed.
 * maxChars bounds the rendered message text; the short header, cut marker and
 * footer are not counted.
 */
export function pageMessages(messages: Message[], options: PageOptions = {}): PageResult {
  const total = messages.length;
  const from = Math.min(options.messageOffset ?? 0, total);
  const maxChars = options.maxChars ?? DEFAULT_SHOW_MAX_CHARS;
  const maxMessages = options.maxMessages ?? Number.POSITIVE_INFINITY;
  const blocks: string[] = [];
  let used = 0;
  let cutMessage: PageResult["cutMessage"];
  let i = from;

  for (; i < total; i++) {
    if (blocks.length >= maxMessages) break;
    let block = renderMessage(messages[i] as Message);
    if (blocks.length > 0 && used + block.length > maxChars) break;
    if (blocks.length === 0 && block.length > maxChars) {
      const shown = safeSlice(block, maxChars);
      cutMessage = { index: i, shown: shown.length, of: block.length };
      block = `${shown}\n[message truncated at ${shown.length} of ${block.length} chars; use export for full content]\n\n${RULE}\n`;
    }
    blocks.push(block);
    used += block.length;
    if (cutMessage) {
      i++;
      break;
    }
  }

  const remaining = i < total;
  return {
    body: blocks.join("\n"),
    from,
    count: blocks.length,
    total,
    truncated: remaining || cutMessage !== undefined,
    cutMessage,
    nextMessageOffset: remaining ? i : undefined,
  };
}

/** "Messages: 1-5 of 20" using 1-based inclusive positions. */
export function rangeLabel(page: PageResult): string {
  if (page.total === 0) return "Messages: none (0 total)";
  if (page.count === 0) return `Messages: none returned (offset ${page.from} is at or past the end of ${page.total})`;
  return `Messages: ${page.from + 1}-${page.from + page.count} of ${page.total}`;
}

/** Footer stating exactly whether everything requested was returned. */
export function footerLines(page: PageResult): string[] {
  const lines: string[] = [];
  if (page.cutMessage) {
    lines.push(`Message at offset ${page.cutMessage.index} was cut at ${page.cutMessage.shown} of ${page.cutMessage.of} chars; use cursor_history_export for its full content.`);
  }
  if (!page.truncated) return [...lines, "truncated: false"];
  if (page.nextMessageOffset !== undefined) {
    lines.push(
      `truncated: true · nextMessageOffset: ${page.nextMessageOffset}`,
      `To continue, call cursor_history_show again with messageOffset=${page.nextMessageOffset}.`
    );
  } else {
    lines.push("truncated: true");
  }
  return lines;
}

/**
 * Handler for the show tool.
 * The session is hydrated with getSession (the library has no paged hydration
 * yet), so paging here is presentation-level only.
 */
export async function handleShowSession(
  args: Record<string, unknown>,
  ctx: HandlerContext = {}
): Promise<string> {
  try {
    const parsed = ShowInputSchema.parse(args);
    throwIfAborted(ctx.signal);

    // cursor-history uses 0-based indexing internally
    const session = await getSession(readSelector(parsed), readConfig(parsed, ctx.signal));
    throwIfAborted(ctx.signal);

    const workspaceName = session.workspace ? pathBasename(session.workspace) : "No workspace";
    const date = formatTimestamp(session.timestamp, session.createdAtSource);
    const page = pageMessages(session.messages, parsed);

    const lines: string[] = [
      `Session ${parsed.sessionIndex === undefined ? session.id : `#${parsed.sessionIndex}`} · ${workspaceName}`,
      `ID: ${session.id}`,
      sourceSummary(session),
      `${session.messageCount} messages · Created ${date}`,
      rangeLabel(page),
      "(tool results abbreviated to 500 chars and thinking to 200 chars; use export for full content)",
      "",
      RULE,
      "",
    ];
    if (page.body) lines.push(page.body);
    lines.push(...footerLines(page));
    return lines.join("\n");
  } catch (error) {
    throw toToolError(error);
  }
}
