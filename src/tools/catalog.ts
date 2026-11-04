/**
 * Sidecar catalog helpers: mode selection from the environment and content-free
 * rendering of catalog disclosure and status. The catalog is a disposable
 * cache written only to the sidecar file; Cursor data is never written.
 */

import type { CatalogInfo, CatalogMode, CatalogStatus } from "cursor-history";

/** CURSOR_HISTORY_MCP_CATALOG: auto (default), strict or direct. Invalid values fall back to auto. */
export function catalogMode(env: NodeJS.ProcessEnv = process.env): CatalogMode {
  const raw = env["CURSOR_HISTORY_MCP_CATALOG"]?.trim().toLowerCase();
  return raw === "direct" || raw === "strict" || raw === "auto" ? raw : "auto";
}

/** CURSOR_HISTORY_SEARCH_INDEX=1 (or true/on/yes): opt in to the reader's indexed search. Default off. */
export function searchIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["CURSOR_HISTORY_SEARCH_INDEX"]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** One-line catalog disclosure for a list result, or undefined when no catalog info was returned (direct mode). */
export function formatCatalogLine(info: CatalogInfo | undefined): string | undefined {
  if (!info) return undefined;
  switch (info.state) {
    case "ready":
      return `Catalog: ready (snapshot ${info.snapshotBuiltAt ?? "unknown"}, verified ${info.verifiedAt ?? "unknown"})`;
    case "stale": {
      const n = info.changedSources;
      return `Catalog: STALE. Cursor history changed since ${info.snapshotBuiltAt ?? "an unknown time"}` +
        `${n !== undefined ? ` (${n} source file${n === 1 ? "" : "s"})` : ""}; showing the previous snapshot, ` +
        "which may be missing recent sessions (this result is NOT guaranteed complete). " +
        `${info.refreshScheduled === false ? "No refresh is running; call cursor_history_index_refresh" : "A refresh is running; call again shortly"}, ` +
        "or set CURSOR_HISTORY_MCP_CATALOG=strict.";
    }
    case "building":
      return "Catalog: building in background; this result was read directly from Cursor history and is complete.";
    case "degraded":
    case "unavailable":
      return `Catalog: unavailable (${info.reason ?? info.state}); read directly.`;
    default:
      return `Catalog: ${String(info.state)}`;
  }
}

export function formatCatalogStatus(status: CatalogStatus | undefined, mode: CatalogMode, error?: string): string[] {
  const head = `Catalog mode: ${mode} (CURSOR_HISTORY_MCP_CATALOG; search, show and export always read directly)`;
  if (error) return [head, `Catalog status unavailable: ${error}`];
  if (!status) return [head];
  if (!status.enabled) return [head, "Catalog: sidecar not available (reads are direct)"];
  const lines = [
    head,
    `Catalog sidecar: ${status.path ?? "unknown path"}${status.sizeBytes !== undefined ? ` (${status.sizeBytes} bytes)` : ""}, schema ${status.schemaVersion}, projection epoch ${status.projectionEpoch}`,
  ];
  if (status.scopes.length === 0) lines.push("Catalog scopes: none built yet");
  for (const s of status.scopes) {
    const parts = [
      `state=${s.building ? `${s.state} (building)` : s.state}`,
      `rows=${s.rowCount ?? "n/a"}`,
      `built=${s.snapshotBuiltAt ?? "n/a"}`,
      `verified=${s.verifiedAt ?? "n/a"}`,
      `buildMs=${s.buildMs ?? "n/a"}`,
    ];
    // Optional reader fields (present only on readers that report the search index).
    const idx = s as { searchMessageCount?: number; searchIndexBytes?: number };
    if (idx.searchMessageCount !== undefined) parts.push(`indexedMessages=${idx.searchMessageCount}`);
    if (idx.searchIndexBytes !== undefined) parts.push(`indexBytes=${idx.searchIndexBytes}`);
    if (s.lastError) parts.push(`lastError=${s.lastError.code} at ${s.lastError.at}`);
    lines.push(`  Scope ${s.workspace ?? "(global)"}: ${parts.join(" ")}`);
  }
  return lines;
}
