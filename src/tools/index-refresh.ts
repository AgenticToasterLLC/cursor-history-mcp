/**
 * cursor_history_index_refresh tool - (Re)build the sidecar catalog snapshot.
 * Writes only the disposable sidecar file; Cursor data is never modified.
 */

import { getCatalogStatus, refreshCatalog, waitForCatalog } from "cursor-history";
import { z } from "zod";
import { toToolError } from "../errors.js";
import { formatCatalogStatus } from "./catalog.js";
import { readScopeShape, readScopeProperties, readConfig, throwIfAborted, type HandlerContext } from "./history-context.js";

const InputSchema = z.object({
  ...readScopeShape,
  wait: z.boolean().default(false).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).default(60_000).optional(),
});

/** refreshCatalog also reports rateLimited at runtime; the published type omits it. */
interface RefreshJob {
  jobId: string;
  alreadyRunning: boolean;
  rateLimited?: boolean;
}

export const indexRefreshTool = {
  name: "cursor_history_index_refresh",
  description:
    "Start (or wait for) a background rebuild of the fast-listing catalog snapshot for a scope. Does not modify Cursor data; it writes only the disposable sidecar catalog file.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ...readScopeProperties,
      wait: {
        type: "boolean",
        description: "Wait for the build to finish (up to timeoutMs) and report the resulting state. Default: false.",
        default: false,
      },
      timeoutMs: {
        type: "integer",
        description: "Maximum wait in milliseconds when wait is true (default: 60000, max: 600000)",
        minimum: 1,
        maximum: 600000,
        default: 60000,
      },
    },
    additionalProperties: false,
  },
};

export async function handleIndexRefresh(
  args: Record<string, unknown>,
  ctx: HandlerContext = {}
): Promise<string> {
  try {
    const parsed = InputSchema.parse(args);
    throwIfAborted(ctx.signal);
    // Deliberately no signal: an aborted call must not cancel the background build config.
    const config = { ...readConfig(parsed), catalog: "auto" as const };
    delete (config as { signal?: AbortSignal }).signal;
    const timeoutMs = parsed.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    let job = await refreshCatalog(config) as RefreshJob;
    // The reader rate-limits rebuilds of one scope (default 10 s after the previous build ended).
    // When waiting, retry until the limit lifts instead of reporting a build that never started.
    while (parsed.wait && job.rateLimited && Date.now() < deadline) {
      throwIfAborted(ctx.signal);
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await refreshCatalog(config) as RefreshJob;
    }
    const scope = parsed.workspace ?? "(global)";
    const lines = [
      job.rateLimited
        ? "Catalog refresh for scope " + scope + ": not started, a build for this scope finished moments ago (rebuilds are rate-limited to one per ~10 s). Retry shortly."
        : `Catalog refresh for scope ${scope}: ${job.alreadyRunning ? "already running" : "started"} (job ${job.jobId}).`,
    ];
    if (parsed.wait) {
      const finished = job.rateLimited ? false : await waitForCatalog(config, Math.max(1, deadline - Date.now()));
      lines.push(finished ? "Build finished." : `Build did not finish within ${timeoutMs} ms (it may continue in the background).`);
      const status = await getCatalogStatus(config);
      const s = status.scopes[0];
      if (s) {
        lines.push(`State: ${s.building ? `${s.state} (building)` : s.state}; rows=${s.rowCount ?? "n/a"}; built=${s.snapshotBuiltAt ?? "n/a"}; verified=${s.verifiedAt ?? "n/a"}; buildMs=${s.buildMs ?? "n/a"}${s.lastError ? `; lastError=${s.lastError.code}` : ""}`);
      } else {
        lines.push(...formatCatalogStatus(status, "auto").slice(1));
      }
    } else if (!job.rateLimited) {
      lines.push("The build runs in the background. Call this tool with wait=true, or cursor_history_status, to check progress.");
    }
    return lines.join("\n");
  } catch (error) {
    throw toToolError(error);
  }
}
