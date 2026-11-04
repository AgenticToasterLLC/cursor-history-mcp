import { describe, expect, it } from "vitest";
import { formatScopeNotice } from "../../src/tools/history-context.js";
import { formatSearchOutput } from "../../src/tools/search.js";
import { formatWorkspaces } from "../../src/tools/workspaces.js";
import { formatStatus, timeBudgetSettings } from "../../src/tools/status.js";

describe("formatScopeNotice", () => {
  it("renders empty", () => {
    expect(formatScopeNotice({ state: "empty", requested: "p", path: "/w/p", matchKind: "exact" }))
      .toBe("Workspace /w/p is known to Cursor history but has no chat sessions (matched exact).");
  });
  it("renders not-found with at most 5 suggestions and a pointer", () => {
    const suggestions = Array.from({ length: 7 }, (_, i) => ({ path: `/w/p${i}`, reason: "same-basename" as const, score: 0.5 }));
    const text = formatScopeNotice({ state: "not-found", requested: "pp", normalizedRequest: "pp", suggestions })!;
    expect(text).toContain("No workspace in local Cursor history matches pp.");
    expect(text).toContain("/w/p4 (same-basename");
    expect(text).not.toContain("/w/p5");
    expect(text).toContain("cursor_history_workspaces");
  });
  it("shows the resolved path only for unique-suffix", () => {
    expect(formatScopeNotice({ state: "matched", requested: "p", path: "/w/p", matchKind: "unique-suffix" })).toContain("/w/p");
    expect(formatScopeNotice({ state: "matched", requested: "/w/p", path: "/w/p", matchKind: "exact" })).toBeUndefined();
    expect(formatScopeNotice({ state: "unscoped" })).toBeUndefined();
  });
});

describe("formatSearchOutput ambiguity", () => {
  it("reports skipped sessions and qualifies coverage", () => {
    const text = formatSearchOutput("q", [], { limit: 10, skippedAmbiguous: ["id-1", "id-2"] });
    expect(text).toContain("Skipped 2 ambiguous session(s): id-1, id-2 (divergent copies; not searched)");
    expect(text).toContain("except for the skipped ambiguous session(s)");
  });
});

describe("formatWorkspaces", () => {
  it("omits aliases equal to the path and adds the note and pagination", () => {
    const text = formatWorkspaces(
      [{ path: "/w/a", aliases: ["/w/a", "C:\\w\\a"], sources: ["composer"], workspaceStorageIds: ["x", "y"], lastModifiedAt: "2025-01-01T00:00:00.000Z" }],
      { total: 3, limit: 1, offset: 0, hasMore: true }
    );
    expect(text).toContain("#1 /w/a");
    expect(text).toContain("Aliases: C:\\w\\a");
    expect(text).not.toContain("Aliases: /w/a");
    expect(text).toContain("workspaceStorage dirs: 2");
    expect(text).toContain("hasMore=true");
    expect(text).toContain("Inventory lists every workspace Cursor has recorded");
  });
});

describe("formatStatus", () => {
  const base = { serverVersion: "1.0.0", readerVersion: "0.19.0", driver: "node:sqlite", paths: { dataPath: "/nope", storeRoot: "/nope2", globalDb: "/nope/g.vscdb" }, budget: timeBudgetSettings({}), verbose: true };
  it("reports OK probe details", () => {
    const text = formatStatus({ ...base, probe: { ok: true, total: 3, composer: 2, store: 1, ms: 7 } });
    expect(text).toContain("OK: 3 known workspace(s)");
    expect(text).toContain("composer=2 store=1");
    expect(text).toContain("Catalog mode: direct");
    expect(text).toContain("120000 (default)");
  });
  it("reports probe failure", () => {
    expect(formatStatus({ ...base, probe: { ok: false, error: "[DATABASE_NOT_FOUND] x" } })).toContain("FAILED: [DATABASE_NOT_FOUND] x");
  });
});
