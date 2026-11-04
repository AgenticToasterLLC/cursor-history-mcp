import { describe, expect, it } from "vitest";
import type { SearchResult } from "cursor-history";
import { formatSearchOutput, openWithLine } from "../../src/tools/search.js";

const hit = (id: string, messageIndex: number) =>
  ({
    session: { id, workspace: "/c:/repo/ws.code-workspace", source: "global", resolutionState: "complete" },
    match: "needle here",
    messageIndex,
    offset: 0,
    contextBefore: [],
    contextAfter: [],
  }) as unknown as SearchResult;

describe("search hits carry the exact show arguments for the same scope", () => {
  it("includes sessionId and messageOffset, and no scope when unscoped", () => {
    expect(openWithLine(hit("abc", 472))).toBe(
      "  Open with: cursor_history_show sessionId=abc messageOffset=472 (use the same scope; message indexes differ between scopes)"
    );
  });

  it("repeats the workspace and cross-workspace flag the search used", () => {
    const line = openWithLine(hit("abc", 7), { workspace: "c:/repo/ws.code-workspace", includeCrossWorkspaceSources: true });
    expect(line).toContain('workspace="c:/repo/ws.code-workspace"');
    expect(line).toContain("includeCrossWorkspaceSources=true");
    expect(line).toContain("messageOffset=7");
  });

  it("is rendered for every result in formatted output", () => {
    const text = formatSearchOutput("needle", [hit("a", 1), hit("b", 2)], { limit: 10, workspace: "c:/repo/ws.code-workspace" });
    expect(text.match(/Open with: cursor_history_show/g)).toHaveLength(2);
    expect(text).toContain('sessionId=b messageOffset=2 workspace="c:/repo/ws.code-workspace"');
  });
});
