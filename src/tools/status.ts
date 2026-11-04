/**
 * cursor_history_status tool - Server and history-reader health report
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getActiveDriver, getCatalogStatus, getDefaultDataPath, listWorkspaces } from "cursor-history";
import type { CatalogMode, CatalogStatus } from "cursor-history";
import { z } from "zod";
import packageJson from "../../package.json";
import { formatErrorText, mapCursorHistoryError } from "../errors.js";
import { catalogMode, formatCatalogStatus } from "./catalog.js";
import { throwIfAborted, type HandlerContext } from "./history-context.js";

const StatusInputSchema = z.object({ verbose: z.boolean().optional() });

export const statusTool = {
  name: "cursor_history_status",
  description:
    "Report server and reader versions, data locations, time-budget settings and whether Cursor history is actually readable (a cheap inventory probe). Connected does not mean readable; check the probe line.",
  inputSchema: {
    type: "object" as const,
    properties: {
      verbose: {
        type: "boolean",
        description: "Also report workspace counts by source and how long the inventory probe took. Default: false.",
        default: false,
      },
    },
    additionalProperties: false,
  },
};

/** Installed reader version, read from its package.json (the package does not export that subpath). */
export function readerVersion(): string {
  try {
    const req = createRequire(__filename);
    let dir = dirname(req.resolve("cursor-history"));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "cursor-history" && pkg.version) return pkg.version;
      }
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  return "unknown";
}

export interface StatusPaths {
  dataPath: string;
  storeRoot: string;
  globalDb: string;
}

/** Locations as the reader resolves them from the environment (reported only, never opened). */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): StatusPaths {
  const dataPath = env["CURSOR_DATA_PATH"] || getDefaultDataPath();
  const storeRoot = env["CURSOR_STORE_ROOT"] || join(homedir(), ".cursor");
  return { dataPath, storeRoot, globalDb: join(dirname(dataPath), "globalStorage", "state.vscdb") };
}

export function timeBudgetSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = Object.keys(env).filter(k => k.startsWith("CURSOR_HISTORY_MCP_TIME_BUDGET_MS_")).sort();
  const lines = [`Time budget: ${env["CURSOR_HISTORY_MCP_TIME_BUDGET_MS"] ?? "120000 (default)"} ms (0 disables)`];
  for (const key of keys) lines.push(`Time budget override ${key}=${env[key]}`);
  return lines;
}

function exists(path: string): string {
  return existsSync(path) ? "exists" : "missing";
}

function globalDbInfo(path: string): string {
  try {
    return `${path} (exists, ${statSync(path).size} bytes)`;
  } catch {
    return `${path} (missing)`;
  }
}

export interface StatusInput {
  serverVersion: string;
  readerVersion: string;
  driver: string | undefined;
  paths: StatusPaths;
  budget: string[];
  catalog?: { mode: CatalogMode; status?: CatalogStatus; error?: string };
  probe: { ok: true; total: number; composer: number; store: number; ms: number } | { ok: false; error: string };
  verbose: boolean;
}

export function formatStatus(s: StatusInput): string {
  const lines = [
    "cursor-history-mcp status",
    `MCP server version: ${s.serverVersion}`,
    `Reader (cursor-history) version: ${s.readerVersion}`,
    `SQLite driver: ${s.driver ?? "not yet selected (chosen on first database read)"}`,
    `Default data path: ${s.paths.dataPath} (${exists(s.paths.dataPath)})`,
    `Store root: ${s.paths.storeRoot} (${exists(s.paths.storeRoot)})`,
    `Global DB: ${globalDbInfo(s.paths.globalDb)} (stat only, not opened)`,
    ...s.budget,
    ...formatCatalogStatus(s.catalog?.status, s.catalog?.mode ?? "direct", s.catalog?.error),
    "",
    "Note: a live MCP connection does not mean history is readable. History readability probe (workspace inventory):",
  ];
  if (s.probe.ok) {
    lines.push(`  OK: ${s.probe.total} known workspace(s)`);
    if (s.verbose) {
      lines.push(
        `  Workspaces by source: composer=${s.probe.composer} store=${s.probe.store} (a workspace may appear in both)`,
        `  Inventory took ${s.probe.ms} ms`
      );
    }
  } else {
    lines.push(`  FAILED: ${s.probe.error}`);
  }
  return lines.join("\n");
}

export async function handleStatus(
  args: Record<string, unknown>,
  ctx: HandlerContext = {}
): Promise<string> {
  const parsed = StatusInputSchema.parse(args);
  throwIfAborted(ctx.signal);
  const verbose = parsed.verbose ?? false;
  const started = Date.now();
  const sig = ctx.signal ? { signal: ctx.signal } : {};
  let probe: StatusInput["probe"];
  try {
    // Non-verbose only needs the total; verbose pages through every entry to count sources.
    let page = await listWorkspaces({ ...sig, limit: verbose ? 1000 : 1 });
    const total = page.pagination.total;
    let composer = 0;
    let store = 0;
    if (verbose) {
      let offset = 0;
      for (;;) {
        for (const e of page.data) {
          if (e.sources.includes("composer")) composer++;
          if (e.sources.includes("store")) store++;
        }
        offset += page.data.length;
        if (!page.pagination.hasMore || page.data.length === 0) break;
        throwIfAborted(ctx.signal);
        page = await listWorkspaces({ ...sig, limit: 1000, offset });
      }
    }
    probe = { ok: true, total, composer, store, ms: Date.now() - started };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    probe = { ok: false, error: formatErrorText(mapCursorHistoryError(error)).replace(/\n/g, " ") };
  }
  const mode = catalogMode();
  let catalog: StatusInput["catalog"];
  try {
    catalog = { mode, status: await getCatalogStatus({}) };
  } catch (error) {
    catalog = { mode, error: formatErrorText(mapCursorHistoryError(error)).replace(/\s+/g, " ") };
  }
  return formatStatus({
    catalog,
    serverVersion: packageJson.version,
    readerVersion: readerVersion(),
    driver: getActiveDriver(),
    paths: resolvePaths(),
    budget: timeBudgetSettings(),
    probe,
    verbose,
  });
}
