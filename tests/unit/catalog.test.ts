import { describe, expect, it } from "vitest";
import { catalogMode, formatCatalogLine, formatCatalogStatus } from "../../src/tools/catalog.js";
import { readConfig } from "../../src/tools/history-context.js";

describe("formatCatalogLine", () => {
  it("renders nothing without catalog info (direct mode)", () => {
    expect(formatCatalogLine(undefined)).toBeUndefined();
  });

  it("ready", () => {
    expect(formatCatalogLine({ state: "ready", complete: true, snapshotBuiltAt: "2025-01-01T00:00:00Z", verifiedAt: "2025-01-02T00:00:00Z" }))
      .toBe("Catalog: ready (snapshot 2025-01-01T00:00:00Z, verified 2025-01-02T00:00:00Z)");
  });

  it("stale warns about incompleteness and never claims completeness", () => {
    const line = formatCatalogLine({ state: "stale", complete: false, snapshotBuiltAt: "2025-01-01T00:00:00Z", changedSources: 3, refreshScheduled: true })!;
    expect(line).toContain("Catalog: STALE");
    expect(line).toContain("since 2025-01-01T00:00:00Z (3 source files)");
    expect(line).toContain("may be missing recent sessions");
    expect(line).toContain("A refresh is running");
    expect(line).toContain("strict");
    expect(line).not.toMatch(/is complete/);
  });

  it("stale with one source and no refresh scheduled", () => {
    const line = formatCatalogLine({ state: "stale", complete: false, snapshotBuiltAt: "t", changedSources: 1, refreshScheduled: false })!;
    expect(line).toContain("(1 source file)");
    expect(line).toContain("cursor_history_index_refresh");
  });

  it("building states the direct result is complete", () => {
    expect(formatCatalogLine({ state: "building", complete: true, refreshScheduled: true }))
      .toBe("Catalog: building in background; this result was read directly from Cursor history and is complete.");
  });

  it("degraded and unavailable", () => {
    expect(formatCatalogLine({ state: "degraded", complete: true, reason: "CATALOG_UNAVAILABLE" }))
      .toBe("Catalog: unavailable (CATALOG_UNAVAILABLE); read directly.");
    expect(formatCatalogLine({ state: "unavailable", complete: true, reason: "backupPath" }))
      .toBe("Catalog: unavailable (backupPath); read directly.");
    expect(formatCatalogLine({ state: "unavailable", complete: true })).toContain("(unavailable)");
  });
});

describe("catalogMode / readConfig", () => {
  it("defaults to auto and accepts strict and direct", () => {
    expect(catalogMode({})).toBe("auto");
    expect(catalogMode({ CURSOR_HISTORY_MCP_CATALOG: "strict" })).toBe("strict");
    expect(catalogMode({ CURSOR_HISTORY_MCP_CATALOG: " Direct " })).toBe("direct");
    expect(catalogMode({ CURSOR_HISTORY_MCP_CATALOG: "bogus" })).toBe("auto");
  });

  it("only list-style callers get a catalog mode", () => {
    expect(readConfig({})).not.toHaveProperty("catalog");
    expect(readConfig({}, undefined, { useCatalog: true })).toHaveProperty("catalog");
  });
});

describe("formatCatalogStatus", () => {
  it("renders scopes content-free", () => {
    const lines = formatCatalogStatus({
      enabled: true, path: "/c/catalog.sqlite", sizeBytes: 4096, schemaVersion: 1, projectionEpoch: 1,
      scopes: [
        { scopeKeyDigest: "x", workspace: null, state: "ready", rowCount: 7, snapshotBuiltAt: "b", verifiedAt: "v", buildMs: 12, building: false },
        { scopeKeyDigest: "y", workspace: "/w", state: "stale", building: true, lastError: { code: "E1", at: "t" } },
      ],
    }, "auto").join("\n");
    expect(lines).toContain("/c/catalog.sqlite (4096 bytes), schema 1, projection epoch 1");
    expect(lines).toContain("Scope (global): state=ready rows=7 built=b verified=v buildMs=12");
    expect(lines).toContain("Scope /w: state=stale (building)");
    expect(lines).toContain("lastError=E1");
  });

  it("handles disabled, empty and error", () => {
    expect(formatCatalogStatus({ enabled: false, schemaVersion: 1, projectionEpoch: 1, scopes: [] }, "auto").join("\n")).toContain("not available");
    expect(formatCatalogStatus({ enabled: true, schemaVersion: 1, projectionEpoch: 1, scopes: [] }, "auto").join("\n")).toContain("none built yet");
    expect(formatCatalogStatus(undefined, "direct", "boom").join("\n")).toContain("boom");
  });
});
