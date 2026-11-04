/**
 * cursor_history_migrate tool - Move or copy sessions between workspaces
 *
 * ⚠️ DESTRUCTIVE OPERATION: When moving (not copying), original sessions are deleted
 */

import { migrateSession } from "cursor-history";
import { z } from "zod";
import { toToolError, McpToolError } from "../errors.js";
import { withAudit, flagsFrom } from "../audit.js";
import { MCP_ERROR_CODES } from "../types.js";
import { selectorMessage } from "./history-context.js";

/** Human-readable byte size. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1))} ${units[i]}`;
}

/**
 * Input schema for the migrate tool
 */
const MigrateInputSchema = z.object({
  sessionIndexes: z.array(z.number().int().min(1)).min(1).optional(),
  sessionIds: z.array(z.string().min(1)).min(1).optional(),
  destination: z.string(),
  mode: z.enum(["move", "copy"]).default("move").optional(),
  workspace: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
  confirm: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if ((value.sessionIndexes !== undefined) === (value.sessionIds !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: selectorMessage("sessionIds", "sessionIndexes", value.sessionIds !== undefined),
    });
  }
});

/**
 * Tool definition for MCP
 */
export const migrateTool = {
  name: "cursor_history_migrate",
  description:
    "Move or copy eligible Composer sessions between workspaces. PREVIEW BY DEFAULT: dryRun defaults to true and nothing is changed. To apply, pass dryRun=false; mode 'move' (the default) deletes the originals and additionally requires confirm=true, so preview first and back up. Store-only, merged-source and ambiguous sessions are refused. Cursor must be closed for a real run; a verified safety copy of the affected databases is written first (never deleted automatically), which can take minutes for a large global database.",
  inputSchema: {
    type: "object" as const,
    properties: {
      sessionIds: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: "Exact native UUIDs from list/search. Preferred for stable selection. Specify this OR sessionIndexes, not both.",
      },
      workspace: {
        type: "string",
        description: "Source workspace scope; use the same scope that produced the session indexes.",
      },
      dryRun: {
        type: "boolean",
        description: "Preview only (default: true). Pass false to actually migrate.",
        default: true,
      },
      sessionIndexes: {
        type: "array",
        items: {
          type: "integer",
          minimum: 1,
        },
        description:
          "List of session indexes to migrate (1-based, as shown in list output). Specify this OR sessionIds, not both.",
        minItems: 1,
      },
      destination: {
        type: "string",
        description: "Absolute path to the destination workspace folder",
      },
      mode: {
        type: "string",
        description: "Migration mode: 'move' deletes the original (requires dryRun=false and confirm=true), 'copy' keeps it.",
        enum: ["move", "copy"],
        default: "move",
      },
      confirm: {
        type: "boolean",
        description: "Required (true) with dryRun=false when mode is 'move', because a move deletes the originals. Preview first.",
        default: false,
      },
    },
    required: ["destination"],
    additionalProperties: false,
  },
};

/**
 * Handler for the migrate tool
 */
export async function handleMigrate(
  args: Record<string, unknown>
): Promise<string> {
  try {
    return await withAudit("cursor_history_migrate", flagsFrom(args), async () => {
      const parsed = MigrateInputSchema.parse(args);
      const mode = parsed.mode ?? "move";
      const dryRun = parsed.dryRun ?? true;
      const sessions = parsed.sessionIds ?? parsed.sessionIndexes;
      if (!sessions) throw new Error("Provide sessionIds or sessionIndexes");

      if (!dryRun && mode === "move" && parsed.confirm !== true) {
        throw new McpToolError({
          code: MCP_ERROR_CODES.INVALID_ARGUMENTS,
          message:
            "Refusing to move sessions without confirmation: a move deletes the originals from the source workspace.",
          remedy:
            "Preview first (omit dryRun), back up with cursor_history_backup, then repeat with dryRun=false and confirm=true. Use mode='copy' to keep the originals.",
        });
      }

      // v0.18 migration selectors are one-based (unlike public read indices).
      const results = await migrateSession({
        sessions,
        destination: parsed.destination,
        mode: mode,
        workspace: parsed.workspace,
        dryRun,
      });

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.filter((r) => !r.success).length;
      const errors = results.filter((r) => !r.success).map((r) => r.error ?? "Unknown error");

      const modeLabel = mode === "copy" ? "copied" : "moved";
      const lines: string[] = [];
      if (dryRun) {
        lines.push(
          "PREVIEW ONLY. Nothing was changed. To apply: dryRun=false (and confirm=true for move).",
          ""
        );
      }

      const blockers = new Map<string, string>();
      for (const r of results) for (const b of r.blockers ?? []) blockers.set(b.code, b.message);
      const estimate = Math.max(0, ...results.map((r) => r.safetyCopyEstimateBytes ?? 0));
      const copies = new Map<string, NonNullable<(typeof results)[number]["safetyCopy"]>>();
      for (const r of results) if (r.safetyCopy) copies.set(r.safetyCopy.directory, r.safetyCopy);

      if (successCount > 0) {
        lines.push(
          `${dryRun ? "Preview: would have" : "Successfully"} ${modeLabel} ${successCount} session(s) to:`,
          `📁 ${parsed.destination}`,
          ""
        );
      }

      if (dryRun) {
        if (blockers.size > 0) {
          lines.push("⛔ Blocking conditions (a real migration would be refused):");
          for (const [code, message] of blockers) lines.push(`  • [${code}] ${message}`);
          lines.push("Quit Cursor completely before applying.", "");
        }
        if (estimate > 0) {
          lines.push(
            `🛟 A verified safety copy of the affected databases (about ${formatSize(estimate)}) will be written before any change.`,
            "   Copying a large global database can take minutes, and needs that much free disk space.",
            ""
          );
        }
      } else if (copies.size > 0) {
        for (const copy of copies.values()) {
          lines.push(
            `🛟 Safety copy: ${copy.directory}`,
            `   Size: ${formatSize(copy.totalBytes)} in ${copy.files.length} file(s) (manifest: ${copy.manifestPath})`,
            "   It is never deleted automatically. To roll back, quit Cursor and copy the files listed in the manifest back to their original locations.",
            ""
          );
        }
      }

      if (failedCount > 0) {
        lines.push(`⚠️ Failed to migrate ${failedCount} session(s):`);
        for (const error of errors) {
          lines.push(`  • ${error}`);
        }
      }

      if (successCount === 0 && failedCount === 0) {
        lines.push("No sessions were migrated.");
      }

      return { text: lines.join("\n"), sessions: sessions.length, safetyCopy: copies.size > 0 };
    });
  } catch (error) {
    throw toToolError(error);
  }
}
