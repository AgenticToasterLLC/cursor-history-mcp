import { describe, expect, it } from "vitest";
import type { Message, SearchResult } from "cursor-history";
import { SessionIntegrityError } from "cursor-history";
import { z } from "zod";
import { pageMessages, rangeLabel, footerLines, safeSlice } from "../../src/tools/show-session.js";
import { chunkExport } from "../../src/tools/export.js";
import { formatSearchOutput } from "../../src/tools/search.js";
import { pathBasename } from "../../src/tools/history-context.js";
import { mapCursorHistoryError, formatErrorText, McpToolError } from "../../src/errors.js";
import { MCP_ERROR_CODES } from "../../src/types.js";

const msg = (i: number, size = 100): Message => ({
  role: i % 2 ? "assistant" : "user", content: `m${i}:` + "x".repeat(size), timestamp: "2025-01-01T00:00:00Z",
} as unknown as Message);

describe("show paging", () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(i));

  it("returns everything when it fits", () => {
    const page = pageMessages(messages);
    expect(page.truncated).toBe(false);
    expect(page.count).toBe(10);
    expect(rangeLabel(page)).toBe("Messages: 1-10 of 10");
    expect(footerLines(page)).toEqual(["truncated: false"]);
  });

  it("follows nextMessageOffset to cover every message exactly once", () => {
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = pageMessages(messages, { messageOffset: offset, maxChars: 600 });
      for (let i = 0; i < page.count; i++) seen.push(page.from + i);
      offset = page.nextMessageOffset;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("honors maxMessages and reports the next offset", () => {
    const page = pageMessages(messages, { messageOffset: 2, maxMessages: 3 });
    expect(rangeLabel(page)).toBe("Messages: 3-5 of 10");
    expect(footerLines(page)[0]).toBe("truncated: true · nextMessageOffset: 5");
  });

  it("cuts a single oversized message with a marker and still advances", () => {
    const page = pageMessages([msg(0, 5000), msg(1)], { maxChars: 200 });
    expect(page.count).toBe(1);
    expect(page.cutMessage?.shown).toBeLessThanOrEqual(200);
    expect(page.body).toMatch(/\[message truncated at \d+ of \d+ chars/);
    expect(page.nextMessageOffset).toBe(1);
    expect(page.truncated).toBe(true);
  });

  it("flags truncation even when the last message is cut", () => {
    const page = pageMessages([msg(0, 5000)], { maxChars: 200 });
    expect(page.nextMessageOffset).toBeUndefined();
    expect(footerLines(page).join("\n")).toContain("truncated: true");
  });

  it("handles offsets past the end and empty sessions", () => {
    expect(pageMessages(messages, { messageOffset: 99 }).count).toBe(0);
    expect(rangeLabel(pageMessages([]))).toContain("0 total");
  });

  it("does not split surrogate pairs", () => {
    expect(safeSlice("a\u{1F600}b", 2)).toBe("a");
  });

  it("labels abbreviations", () => {
    const m = { ...msg(1), role: "assistant", thinking: "t".repeat(300) } as unknown as Message;
    expect(pageMessages([m]).body).toContain("abbreviated to 200 of 300 chars");
  });
});

describe("export chunking", () => {
  const full = "line\u{1F600}\n".repeat(500);

  it("returns small exports unchanged with no header", () => {
    expect(chunkExport("small", 0, 100)).toBe("small");
  });

  it("reassembles all chunks into the full export", () => {
    let out = "";
    let offset = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const chunk = chunkExport(full, offset, 77);
      const nl = chunk.indexOf("\n");
      const header = chunk.slice(0, nl);
      out += chunk.slice(nl + 1);
      const next = /nextChunkOffset: (\d+)\]$/.exec(header);
      if (!next) { expect(header).toContain("complete: true"); break; }
      expect(header).toContain(`of ${full.length} · complete: false`);
      offset = Number(next[1]);
    }
    expect(out).toBe(full);
  });
});

describe("search output bounding", () => {
  const result = (i: number): SearchResult => ({
    session: { id: `id-${i}`, workspace: "C:\\work\\proj" }, match: "needle " + "y".repeat(400), messageIndex: i, offset: 0,
    contextBefore: Array.from({ length: 20 }, (_, k) => `before ${k}`), contextAfter: Array.from({ length: 20 }, (_, k) => `after ${k}`),
  } as unknown as SearchResult);

  it("stops adding results at maxChars and reports it", () => {
    const out = formatSearchOutput("needle", Array.from({ length: 10 }, (_, i) => result(i)), { limit: 10, maxChars: 2000 });
    expect(out).toMatch(/results shown: \d of 10 returned · truncated: true/);
    expect(out).toContain("Coverage:");
    expect(out).toContain("(proj)");
  });

  it("caps context lines per result", () => {
    const out = formatSearchOutput("needle", [result(0)], { limit: 10 });
    expect(out).toContain("results shown: 1 of 1 returned · truncated: false");
    expect(out).not.toContain("before 0");
    expect(out).toContain("before 19");
    expect(out).toContain("30 more context line(s) omitted");
    expect(out).toContain("[line cut at 300");
  });
});

describe("misc helpers", () => {
  it("splits workspace names on both separators", () => {
    expect(pathBasename("C:\\Users\\me\\proj")).toBe("proj");
    expect(pathBasename("/home/me/proj/")).toBe("proj");
  });
});

describe("error mapping", () => {
  it("tags zod errors INVALID_ARGUMENTS", () => {
    const parsed = z.object({ a: z.number() }).safeParse({ a: "x" });
    const mapped = mapCursorHistoryError((parsed as { error: unknown }).error);
    expect(mapped.code).toBe(MCP_ERROR_CODES.INVALID_ARGUMENTS);
    expect(formatErrorText(mapped)).toMatch(/^\[INVALID_ARGUMENTS\] Invalid arguments: a:/);
  });

  it.each(["WORKSPACE_AMBIGUOUS", "SESSION_AMBIGUOUS", "SESSION_SCOPE_MISMATCH", "SOURCE_LIMIT_EXCEEDED"] as const)("maps %s", (code) => {
    const mapped = mapCursorHistoryError(new SessionIntegrityError(code, "boom", {}));
    expect(mapped.code).toBe(MCP_ERROR_CODES[code]);
    expect(formatErrorText(mapped)).toMatch(new RegExp(`^\\[${code}\\] boom\\n.+`));
  });

  it("keeps other integrity failures and uses INTERNAL_ERROR for unknown errors", () => {
    expect(mapCursorHistoryError(new SessionIntegrityError("READ_CONTEXT_DISPOSED", "x", {})).code).toBe(MCP_ERROR_CODES.INTEGRITY_FAILED);
    expect(mapCursorHistoryError(new Error("weird")).code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });

  it("passes typed tool errors through", () => {
    const e = new McpToolError({ code: MCP_ERROR_CODES.CANCELLED, message: "c" });
    expect(mapCursorHistoryError(e)).toBe(e.mcp);
  });
});
