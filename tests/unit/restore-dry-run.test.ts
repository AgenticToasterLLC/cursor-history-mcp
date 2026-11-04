import { beforeEach, describe, expect, it, vi } from "vitest";
import * as history from "cursor-history";
import { handleRestore } from "../../src/tools/restore.js";
import { handleBackup } from "../../src/tools/backup.js";
import { McpToolError } from "../../src/errors.js";

vi.mock("cursor-history", async (importOriginal) => ({
  ...await importOriginal<typeof import("cursor-history")>(),
  restoreBackup: vi.fn(),
  validateBackup: vi.fn(),
  createBackup: vi.fn(),
}));

process.env.CURSOR_HISTORY_MCP_AUDIT = "0";

const manifest = { createdAt: "2025-01-01T00:00:00Z", stats: { sessionCount: 3, workspaceCount: 2 } };

describe("restore safety", () => {
  beforeEach(() => vi.resetAllMocks());

  it("defaults to a dry run: validates, reports, never restores", async () => {
    vi.mocked(history.validateBackup).mockResolvedValue({
      status: "valid", manifest, validFiles: ["a", "b"], corruptedFiles: [], missingFiles: [], errors: [],
    } as unknown as history.BackupValidation);
    const text = await handleRestore({ backupPath: "/x/backup.zip", force: true });
    expect(history.restoreBackup).not.toHaveBeenCalled();
    expect(text).toContain("PREVIEW ONLY. Nothing was changed.");
    expect(text).toContain("Files that would be restored: 2");
    expect(text).toContain("Sessions in backup: 3");
  });

  it("dryRun=false restores and passes force through", async () => {
    vi.mocked(history.restoreBackup).mockResolvedValue({ success: true, targetPath: "/t", filesRestored: 2, warnings: [], durationMs: 1 });
    const text = await handleRestore({ backupPath: "/x/backup.zip", dryRun: false, force: true });
    expect(history.restoreBackup).toHaveBeenCalledWith({ backupPath: "/x/backup.zip", force: true });
    expect(text).toContain("Restore completed successfully");
  });

  it("an invalid backup is a typed INVALID_BACKUP error", async () => {
    vi.mocked(history.validateBackup).mockResolvedValue({
      status: "invalid", validFiles: [], corruptedFiles: ["a"], missingFiles: [], errors: ["bad"],
    } as unknown as history.BackupValidation);
    const error = await handleRestore({ backupPath: "/x/backup.zip" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpToolError);
    expect((error as McpToolError).mcp.remedy).toBeTruthy();
  });

  it("backup failures are typed too", async () => {
    vi.mocked(history.createBackup).mockRejectedValue(new Error("disk full"));
    const error = await handleBackup({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpToolError);
  });
});
