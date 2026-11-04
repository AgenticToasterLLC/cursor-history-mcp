import { afterEach, describe, expect, it, vi } from "vitest";

const searchSessions = vi.hoisted(() => vi.fn());
vi.mock("cursor-history", async importOriginal => ({
  ...(await importOriginal<typeof import("cursor-history")>()),
  searchSessions,
}));

import { searchIndexEnabled } from "../../src/tools/catalog.js";
import { readConfig } from "../../src/tools/history-context.js";
import { coverageLines, formatSearchOutput, handleSearch } from "../../src/tools/search.js";
import type { SearchResult } from "cursor-history";

const hit = (id: string): SearchResult =>
  ({ session: { id, workspace: "/w/proj" }, match: "needle", messageIndex: 0, offset: 0, contextBefore: [], contextAfter: [] }) as unknown as SearchResult;

/** A reader result list with non-enumerable metadata, as the real reader returns it. */
function list(items: SearchResult[], meta: Record<string, unknown>) {
  const arr = [...items];
  for (const [k, v] of Object.entries(meta)) Object.defineProperty(arr, k, { value: v, enumerable: false });
  return arr;
}

const COMPLETE = "Coverage: index-assisted search verified against source; complete for this scope.";

describe("coverageLines", () => {
  it("indexed and exhaustive", () => {
    expect(coverageLines({ mode: "indexed", catalog: { state: "ready", complete: true } }, 3)).toEqual([COMPLETE]);
  });

  it("direct without a reason", () => {
    expect(coverageLines(undefined, 1)).toEqual(["Coverage: full scan of this scope (direct); complete."]);
    expect(coverageLines({ mode: "direct" }, 1)).toEqual(["Coverage: full scan of this scope (direct); complete."]);
  });

  it.each([
    ["QUERY_TOO_SHORT", "shorter than 3 characters"],
    ["QUERY_NOT_ASCII", "not plain ASCII"],
    ["INDEX_BUILDING", "still building"],
    ["INDEX_NOT_READY", "not ready"],
  ])("direct with reason %s", (reason, words) => {
    const [line] = coverageLines({ mode: "direct", reason }, 1);
    expect(line).toContain("Coverage: full scan of this scope (direct); complete.");
    expect(line).toContain("The index was not used");
    expect(line).toContain(words);
  });

  it("stale index never claims completeness", () => {
    const [line] = coverageLines({ mode: "indexed", catalog: { state: "stale", complete: false, refreshScheduled: true } }, 1);
    expect(line).toBe("Coverage: index is STALE (Cursor history changed); results may miss recent messages. A refresh is running.");
    expect(coverageLines({ mode: "indexed", catalog: { state: "stale", complete: false, refreshScheduled: false } }, 1)[0]).toContain("No refresh is running");
  });

  it("recent order that stopped early", () => {
    const lines = coverageLines({ mode: "indexed", order: "recent", exhaustive: false, requestedOrder: "recent" }, 5);
    expect(lines[0]).not.toContain("complete for");
    expect(lines[1]).toBe("Order: most recent matching sessions first; stopped after 5 sessions. More matching sessions may exist; use order=relevance for a complete ranked search or increase limit.");
    const direct = coverageLines({ mode: "direct", exhaustive: false }, 2);
    expect(direct[0]).toContain("not exhaustive");
    expect(direct[1]).toContain("stopped after 2 sessions");
  });

  it("recent order that was exhaustive has no Order line", () => {
    expect(coverageLines({ mode: "indexed", order: "recent", exhaustive: true, requestedOrder: "recent" }, 2)).toEqual([COMPLETE]);
  });

  it("recent requested but reader reports no order", () => {
    const lines = coverageLines({ mode: "direct", requestedOrder: "recent" }, 1);
    expect(lines[1]).toContain("recent order requires a newer reader");
  });

  it("notes skipped ambiguous sessions", () => {
    expect(coverageLines({ mode: "indexed" }, 1, true)[0]).toContain("except for the skipped ambiguous session(s)");
  });
});

describe("formatSearchOutput disclosure", () => {
  it("keeps results line, skipped line and limit note around coverage", () => {
    const text = formatSearchOutput("needle", [hit("a")], { limit: 1, skippedAmbiguous: ["x"], meta: { mode: "indexed" } });
    expect(text).toContain("results shown: 1 of 1 returned · truncated: false");
    expect(text).toContain("Skipped 1 ambiguous session(s): x");
    expect(text).toContain("Coverage: index-assisted search");
    expect(text).toContain("The limit of 1 was reached");
  });
});

describe("handleSearch with a mocked reader", () => {
  afterEach(() => {
    searchSessions.mockReset();
  });

  it("passes searchOrder only for order=recent and renders the stop disclosure", async () => {
    searchSessions.mockResolvedValue(list([hit("a"), hit("b")], { searchMode: "direct", searchOrder: "recent", searchExhaustive: false }));
    const text = await handleSearch({ query: "needle", order: "recent", limit: 2 });
    expect(searchSessions.mock.calls[0]![1]).toMatchObject({ searchOrder: "recent" });
    expect(text).toContain("Order: most recent matching sessions first; stopped after 2 sessions.");

    searchSessions.mockResolvedValue(list([hit("a")], { searchMode: "direct", searchOrder: "match-count", searchExhaustive: true }));
    await handleSearch({ query: "needle", order: "relevance" });
    await handleSearch({ query: "needle" });
    expect(searchSessions.mock.calls[1]![1]).not.toHaveProperty("searchOrder");
    expect(searchSessions.mock.calls[2]![1]).not.toHaveProperty("searchOrder");
  });

  it("maps a reader InvalidConfigError for searchOrder to a clear error", async () => {
    const err = Object.assign(new Error("Invalid searchOrder: nope"), { name: "InvalidConfigError" });
    searchSessions.mockRejectedValue(err);
    await expect(handleSearch({ query: "needle", order: "recent" })).rejects.toThrow("requires a newer cursor-history reader");
  });

  it("renders the stale coverage for an empty result", async () => {
    searchSessions.mockResolvedValue(list([], { searchMode: "indexed", catalog: { state: "stale", complete: false, refreshScheduled: true } }));
    const text = await handleSearch({ query: "needle" });
    expect(text).toContain("No matches found");
    expect(text).toContain("Coverage: index is STALE");
  });

  it("rejects an unknown order value", async () => {
    await expect(handleSearch({ query: "x", order: "oldest" })).rejects.toThrow();
  });
});

describe("search index configuration", () => {
  afterEach(() => {
    delete process.env["CURSOR_HISTORY_SEARCH_INDEX"];
    delete process.env["CURSOR_HISTORY_MCP_CATALOG"];
  });

  it("is off by default and parses 1/true", () => {
    expect(searchIndexEnabled({})).toBe(false);
    expect(searchIndexEnabled({ CURSOR_HISTORY_SEARCH_INDEX: "0" })).toBe(false);
    expect(searchIndexEnabled({ CURSOR_HISTORY_SEARCH_INDEX: "1" })).toBe(true);
    expect(searchIndexEnabled({ CURSOR_HISTORY_SEARCH_INDEX: "true" })).toBe(true);
  });

  it("readConfig only adds catalog and searchIndex for search when enabled", () => {
    expect(readConfig({}, undefined, { searchIndex: true })).not.toHaveProperty("searchIndex");
    expect(readConfig({}, undefined, { searchIndex: true })).not.toHaveProperty("catalog");
    process.env["CURSOR_HISTORY_SEARCH_INDEX"] = "1";
    expect(readConfig({}, undefined, { searchIndex: true })).toMatchObject({ catalog: "auto", searchIndex: true });
    expect(readConfig({})).not.toHaveProperty("searchIndex");
    expect(readConfig({}, undefined, { useCatalog: true })).not.toHaveProperty("searchIndex");
    process.env["CURSOR_HISTORY_MCP_CATALOG"] = "strict";
    expect(readConfig({}, undefined, { searchIndex: true })).toMatchObject({ catalog: "strict", searchIndex: true });
    process.env["CURSOR_HISTORY_MCP_CATALOG"] = "direct";
    expect(readConfig({}, undefined, { searchIndex: true })).not.toHaveProperty("searchIndex");
  });
});
