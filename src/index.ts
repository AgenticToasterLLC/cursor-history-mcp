/**
 * cursor-history-mcp: MCP server for Cursor AI chat history
 *
 * This server exposes cursor-history library functions as MCP tools,
 * allowing MCP clients like Claude Code to browse, search, and manage
 * Cursor AI chat history.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../package.json";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { listSessionsTool, handleListSessions } from "./tools/list-sessions.js";
import { showSessionTool, handleShowSession } from "./tools/show-session.js";
import { searchTool, handleSearch } from "./tools/search.js";
import { exportTool, handleExport } from "./tools/export.js";
import { backupTool, handleBackup } from "./tools/backup.js";
import { restoreTool, handleRestore } from "./tools/restore.js";
import { migrateTool, handleMigrate } from "./tools/migrate.js";
import { workspacesTool, handleWorkspaces } from "./tools/workspaces.js";
import { indexRefreshTool, handleIndexRefresh } from "./tools/index-refresh.js";
import * as reader from "cursor-history";
import { statusTool, handleStatus } from "./tools/status.js";
import { yearPackTool, handleYearPack } from "./tools/year-pack/index.js";
import type { HandlerContext } from "./tools/history-context.js";
import { McpToolError, formatErrorText, mapCursorHistoryError } from "./errors.js";
import { MCP_ERROR_CODES } from "./types.js";

/**
 * All available tools
 */
const TOOLS = [
  listSessionsTool,
  showSessionTool,
  searchTool,
  exportTool,
  backupTool,
  restoreTool,
  migrateTool,
  yearPackTool,
  workspacesTool,
  statusTool,
  indexRefreshTool,
];

/**
 * Tool handler dispatch map
 */
const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, unknown>, ctx: HandlerContext) => Promise<unknown>
> = {
  cursor_history_list: handleListSessions,
  cursor_history_show: handleShowSession,
  cursor_history_search: handleSearch,
  cursor_history_export: handleExport,
  cursor_history_backup: handleBackup,
  cursor_history_restore: handleRestore,
  cursor_history_migrate: handleMigrate,
  cursor_history_year_pack: handleYearPack,
  cursor_history_workspaces: handleWorkspaces,
  cursor_history_status: handleStatus,
  cursor_history_index_refresh: handleIndexRefresh,
};

/**
 * Read-only tools: they receive the cancellation/time-budget signal.
 * Write operations (backup, restore, migrate, year_pack) are never aborted
 * mid-way, so they get no signal.
 */
const ABORTABLE_TOOLS = new Set([
  "cursor_history_list",
  "cursor_history_show",
  "cursor_history_search",
  "cursor_history_export",
  "cursor_history_workspaces",
  "cursor_history_status",
  "cursor_history_index_refresh",
]);

/** Tools that manage their own waiting (wait/timeoutMs) and are exempt from the per-call budget. */
const BUDGET_EXEMPT = new Set(["cursor_history_index_refresh"]);

const DEFAULT_TIME_BUDGET_MS = 120_000;

/**
 * Per-call time budget from CURSOR_HISTORY_MCP_TIME_BUDGET_MS (default 120000,
 * 0 disables, invalid values fall back to the default). A per-tool override
 * CURSOR_HISTORY_MCP_TIME_BUDGET_MS_<TOOL> (e.g. ..._SEARCH) takes precedence.
 */
export function timeBudgetMs(toolName: string, env: NodeJS.ProcessEnv = process.env): number {
  const suffix = toolName.replace(/^cursor_history_/, "").toUpperCase();
  for (const key of [`CURSOR_HISTORY_MCP_TIME_BUDGET_MS_${suffix}`, "CURSOR_HISTORY_MCP_TIME_BUDGET_MS"]) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return DEFAULT_TIME_BUDGET_MS;
}

function errorResult(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Creates and configures the MCP server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: "cursor-history-mcp",
      version: packageJson.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return errorResult(`Unknown tool: ${name}`);
    }

    // Combine client cancellation with the per-call time budget.
    // Caveat: SQLite calls are synchronous, so aborting is cooperative; it
    // takes effect between source pages / at handler checkpoints, not in the
    // middle of a single blocking read.
    const abortable = ABORTABLE_TOOLS.has(name);
    const budgetMs = abortable && !BUDGET_EXEMPT.has(name) ? timeBudgetMs(name) : 0;
    const budgetSignal = budgetMs > 0 ? AbortSignal.timeout(budgetMs) : undefined;
    const clientSignal = extra?.signal;
    const signals = [clientSignal, budgetSignal].filter((x): x is AbortSignal => x !== undefined);
    const signal = abortable && signals.length > 0 ? AbortSignal.any(signals) : undefined;

    const started = Date.now();
    // Synchronous SQLite reads block the event loop, so the timeout timer may
    // not get to fire until the call has already finished; measure elapsed time
    // as well so an over-budget call is always reported as such.
    const overBudget = (): boolean =>
      budgetMs > 0 && (budgetSignal?.aborted === true || Date.now() - started >= budgetMs);

    try {
      const result = await handler(args ?? {}, { signal });
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      // The read completed (a synchronous SQLite read kept the abort from
      // firing in time). The result is complete and correct, so return it
      // with an explicit warning rather than discarding expensive work.
      const warning =
        abortable && !clientSignal?.aborted && overBudget()
          ? `[warning: ${name} took ${Date.now() - started} ms, over its ${budgetMs} ms time budget. ` +
            "The result below is complete. Narrow the request with `workspace` to speed it up.]\n\n"
          : "";
      return {
        content: [{ type: "text", text: warning + text }],
      };
    } catch (error) {
      let envelope;
      if (signal?.aborted && clientSignal?.aborted) {
        envelope = { code: MCP_ERROR_CODES.CANCELLED, message: `${name} was cancelled by the client.` };
      } else if (abortable && (budgetSignal?.aborted === true || overBudget())) {
        envelope = {
          code: MCP_ERROR_CODES.TIME_BUDGET_EXCEEDED,
          message: `${name} exceeded the ${budgetMs} ms time budget.`,
          remedy: "A large Cursor history may need the upcoming index. Narrow the request with `workspace`, or raise CURSOR_HISTORY_MCP_TIME_BUDGET_MS (0 disables the budget).",
        };
      } else if (error instanceof McpToolError) {
        envelope = error.mcp;
      } else {
        envelope = mapCursorHistoryError(error);
      }
      // Diagnostics go to stderr only; stdout is the protocol channel.
      console.error(`[${name}] error ${envelope.code}: ${envelope.message}`);
      return errorResult(formatErrorText(envelope));
    }
  });

  return server;
}

/**
 * Stops running catalog build workers when the reader exposes a cancel function
 * (the current reader does not export one; its workers are unref'd so they never
 * keep the process alive, and the process exit ends them).
 */
async function cancelCatalogWorkers(): Promise<void> {
  const cancel = (reader as unknown as { cancelCatalogRefreshes?: () => Promise<void> }).cancelCatalogRefreshes;
  if (typeof cancel === "function") await cancel().catch(() => undefined);
}

async function shutdown(server: Server): Promise<never> {
  await cancelCatalogWorkers();
  await server.close();
  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  server.onclose = (): void => {
    void cancelCatalogWorkers();
  };

  // Opt-in: schedule one background global catalog build after the handshake.
  // Never blocks, never writes to stdout; errors go to stderr only.
  if (process.env["CURSOR_HISTORY_MCP_CATALOG_WARM"] === "1") {
    setTimeout(() => {
      reader.refreshCatalog({ catalog: "auto" }).catch((error: unknown) => {
        console.error("[catalog-warm] refresh failed:", error instanceof Error ? error.message : String(error));
      });
    }, 0).unref();
  }

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    await shutdown(server);
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
