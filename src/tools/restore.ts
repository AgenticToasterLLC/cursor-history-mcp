/**
 * cursor_history_restore tool - Restore chat history from backup
 *
 * ⚠️ DESTRUCTIVE OPERATION: This tool overwrites current chat history
 */

import { restoreBackup, validateBackup } from "cursor-history";
import { z } from "zod";
import { toToolError, McpToolError } from "../errors.js";
import { withAudit, flagsFrom } from "../audit.js";
import { MCP_ERROR_CODES } from "../types.js";

/**
 * Input schema for the restore tool
 */
const RestoreInputSchema = z.object({
  backupPath: z.string(),
  force: z.boolean().default(false).optional(),
  dryRun: z.boolean().optional(),
});

/**
 * Tool definition for MCP
 */
export const restoreTool = {
  name: "cursor_history_restore",
  description:
    "⚠️ DESTRUCTIVE: Restore Composer databases from a backup archive. PREVIEW BY DEFAULT: dryRun defaults to true and only validates the archive. To restore, pass dryRun=false; overwriting existing data additionally requires force=true. This can overwrite Composer history; it does not restore Store databases, Agent transcripts or ACP stores. Back up current Composer data first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      backupPath: {
        type: "string",
        description: "Path to the backup file to restore from",
      },
      force: {
        type: "boolean",
        description:
          "Allow overwriting existing data (default: false). Only effective with dryRun=false. The server has no interactive confirmation; obtain approval in the client.",
        default: false,
      },
      dryRun: {
        type: "boolean",
        description: "Validate the backup and report what would be restored, without writing (default: true). Pass false to restore.",
        default: true,
      },
    },
    required: ["backupPath"],
    additionalProperties: false,
  },
};

/**
 * Handler for the restore tool
 */
export async function handleRestore(
  args: Record<string, unknown>
): Promise<string> {
  try {
    return await withAudit("cursor_history_restore", flagsFrom(args), async () => {
      const parsed = RestoreInputSchema.parse(args);
      const dryRun = parsed.dryRun ?? true;

      if (dryRun) {
        const validation = await validateBackup(parsed.backupPath);
        if (validation.status === "invalid") {
          throw new McpToolError({
            code: MCP_ERROR_CODES.INVALID_BACKUP,
            message: `Invalid or corrupted backup file (${validation.errors.length} error(s), ${validation.corruptedFiles.length} corrupt file(s)).`,
            remedy: "Verify the archive, or pick another backup. Nothing was changed.",
          });
        }
        const stats = validation.manifest?.stats;
        const lines = [
          "PREVIEW ONLY. Nothing was changed. To apply: dryRun=false (and force=true to overwrite existing data).",
          "",
          `Backup validation: ${validation.status}`,
          `📄 Files that would be restored: ${validation.validFiles.length}`,
        ];
        if (stats) lines.push(`📊 Sessions in backup: ${stats.sessionCount}`, `🗂️  Workspaces: ${stats.workspaceCount}`);
        if (validation.manifest) lines.push(`🕒 Backup created: ${validation.manifest.createdAt}`);
        if (validation.corruptedFiles.length > 0) lines.push(`⚠️ Corrupt files (would be skipped): ${validation.corruptedFiles.length}`);
        if (validation.missingFiles.length > 0) lines.push(`⚠️ Files missing from manifest: ${validation.missingFiles.length}`);
        return { text: lines.join("\n") };
      }

      const result = await restoreBackup({
        backupPath: parsed.backupPath,
        force: parsed.force ?? false,
      });

      const lines: string[] = [
        "Restore completed successfully!",
        "",
        `📁 Restored from: ${parsed.backupPath}`,
        `📄 Files restored: ${result.filesRestored}`,
        `📍 Target path: ${result.targetPath}`,
        "",
        "⚠️ Note: Restart Cursor IDE to see the restored sessions.",
      ];

      if (result.warnings.length > 0) {
        lines.push("", "⚠️ Warnings:");
        for (const warning of result.warnings) {
          lines.push(`  • ${warning}`);
        }
      }

      return { text: lines.join("\n") };
    });
  } catch (error) {
    throw toToolError(error);
  }
}
