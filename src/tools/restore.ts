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

const MAX_LISTED_FILES = 20;
const LIVE_TARGET_TEXT =
  "This would overwrite the live Cursor data directory; with force=true it also needs confirm=true (after quitting Cursor).";
const ERROR_RESTORE_FALLBACK = "Restore failed.";

/**
 * Input schema for the restore tool
 */
const RestoreInputSchema = z.object({
  backupPath: z.string(),
  force: z.boolean().default(false).optional(),
  confirm: z.boolean().default(false).optional(),
  allowPartial: z.boolean().default(false).optional(),
  dryRun: z.boolean().optional(),
});

/**
 * Tool definition for MCP
 */
export const restoreTool = {
  name: "cursor_history_restore",
  description:
    "⚠️ DESTRUCTIVE: Restore Composer databases from a backup archive. PREVIEW BY DEFAULT: dryRun defaults to true and only validates the archive. To restore, pass dryRun=false; overwriting existing data additionally requires force=true, and writing to the live Cursor data directory also requires confirm=true. Cursor must be closed. Before any write the reader makes a verified safety copy of every file it replaces (never deleted automatically) and rolls back from it on failure. This can overwrite Composer history; it does not restore Store databases, Agent transcripts or ACP stores. Back up current Composer data first.",
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
      confirm: {
        type: "boolean",
        description:
          "Acknowledge that the restore targets the live (platform-default) Cursor data directory. Required together with dryRun=false and force=true when existing live data would be overwritten (default: false). Mapped to confirmLiveTarget.",
        default: false,
      },
      allowPartial: {
        type: "boolean",
        description:
          "If some archive entries fail their checksum, restore only the intact ones instead of aborting (default: false). The corrupt entries are skipped and listed.",
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

      // The reader's restore ignores CURSOR_DATA_PATH on its own; honour it here like every other tool,
      // so an explicit custom data dir is restored into (and is not treated as the live default).
      const customTarget = process.env.CURSOR_DATA_PATH?.trim();
      const config = {
        backupPath: parsed.backupPath,
        ...(customTarget ? { targetPath: customTarget } : {}),
        force: parsed.force ?? false,
        confirmLiveTarget: parsed.confirm ?? false,
        allowPartial: parsed.allowPartial ?? false,
      };

      if (dryRun) {
        const validation = await validateBackup(parsed.backupPath);
        if (validation.status === "invalid") {
          throw new McpToolError({
            code: MCP_ERROR_CODES.INVALID_BACKUP,
            message: `Invalid or corrupted backup file (${validation.errors.length} error(s), ${validation.corruptedFiles.length} corrupt file(s)).`,
            remedy: "Verify the archive, or pick another backup. Nothing was changed.",
          });
        }
        const plan = await restoreBackup({ ...config, dryRun: true });
        if (plan.error && (plan.blockingConditions ?? []).length === 0) {
          throw new McpToolError({
            code: MCP_ERROR_CODES.RESTORE_FAILED,
            message: plan.error,
            remedy: "Nothing was changed.",
          });
        }
        const stats = validation.manifest?.stats;
        const blocking = plan.blockingConditions ?? [];
        const lines = [
          "PREVIEW ONLY. Nothing was changed.",
          "",
          `Backup validation: ${validation.status}`,
          `📄 Files that would be restored: ${validation.validFiles.length}`,
        ];
        if (stats) lines.push(`📊 Sessions in backup: ${stats.sessionCount}`, `🗂️  Workspaces: ${stats.workspaceCount}`);
        if (validation.manifest) lines.push(`🕒 Backup created: ${validation.manifest.createdAt}`);
        if (validation.corruptedFiles.length > 0) lines.push(`⚠️ Corrupt files (would be skipped): ${validation.corruptedFiles.length}`);
        if (validation.missingFiles.length > 0) lines.push(`⚠️ Files missing from manifest: ${validation.missingFiles.length}`);
        lines.push(`📍 Target path: ${plan.targetPath}`);
        const replace = plan.filesToReplace ?? [];
        lines.push("", `Existing files that would be replaced: ${replace.length}`);
        for (const file of replace.slice(0, MAX_LISTED_FILES)) lines.push(`  • ${file}`);
        if (replace.length > MAX_LISTED_FILES) lines.push(`  … and ${replace.length - MAX_LISTED_FILES} more`);
        if (plan.skippedFiles && plan.skippedFiles.length > 0) {
          lines.push("", `Corrupt entries that would be skipped (allowPartial): ${plan.skippedFiles.length}`);
        }
        if (plan.safetyCopyRoot) {
          lines.push(
            "",
            `🛟 A verified safety copy of every replaced file WILL be written under: ${plan.safetyCopyRoot}`,
            "   (a timestamped subfolder; never deleted automatically)"
          );
        }
        lines.push("");
        if (blocking.length > 0) {
          lines.push("⛔ Blocking conditions (a real restore would be refused):");
          for (const b of blocking) lines.push(`  • [${b.code}] ${b.code === "LIVE_TARGET_NOT_CONFIRMED" ? LIVE_TARGET_TEXT : b.message}`);
          lines.push("");
        } else {
          lines.push("No blocking conditions found.", "");
        }
        lines.push(
          "Cursor must be closed for a real restore.",
          "To apply: dryRun=false, force=true (if data exists), confirm=true (live Cursor data)."
        );
        return { text: lines.join("\n") };
      }

      const result = await restoreBackup({ ...config, dryRun: false });
      if (!result.success) {
        throw new McpToolError({
          code: MCP_ERROR_CODES.RESTORE_FAILED,
          message: result.error ?? ERROR_RESTORE_FALLBACK,
          remedy: result.rolledBack
            ? "The failure was rolled back from the safety copy; your data is as it was."
            : "Nothing was written.",
        });
      }

      const lines: string[] = [
        "Restore completed successfully!",
        "",
        `📁 Restored from: ${parsed.backupPath}`,
        `📄 Files restored: ${result.filesRestored}`,
        `📍 Target path: ${result.targetPath}`,
      ];
      if (result.partial) {
        lines.push(`⚠️ Partial restore: ${result.skippedFiles?.length ?? 0} corrupt entr(y/ies) skipped.`);
        for (const file of (result.skippedFiles ?? []).slice(0, MAX_LISTED_FILES)) lines.push(`  • ${file}`);
      }
      if (result.safetyCopy) {
        lines.push(
          "",
          `🛟 Safety copy: ${result.safetyCopy.directory}`,
          `   Files in safety copy: ${result.safetyCopy.fileCount} (manifest: ${result.safetyCopy.manifestPath})`,
          "   To roll back manually: quit Cursor and copy the files listed in that manifest.json back into the Cursor User directory. It is never deleted automatically."
        );
      } else {
        lines.push("", "🛟 No safety copy was needed: no existing files were replaced.");
      }
      lines.push("", "⚠️ Note: Restart Cursor IDE to see the restored sessions.");

      if (result.warnings.length > 0) {
        lines.push("", "⚠️ Warnings:");
        for (const warning of result.warnings) {
          lines.push(`  • ${warning}`);
        }
      }

      return { text: lines.join("\n"), safetyCopy: result.safetyCopy !== undefined };
    });
  } catch (error) {
    throw toToolError(error);
  }
}
