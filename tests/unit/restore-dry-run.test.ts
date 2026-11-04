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
    vi.mocked(history.restoreBackup).mockResolvedValue({
      success: false, dryRun: true, targetPath: "/t", filesRestored: 0, warnings: [], durationMs: 1,
      blockingConditions: [{ code: "CURSOR_RUNNING", message: "Cursor is running: quit Cursor first" }],
      error: "Cursor is running: quit Cursor first", filesToReplace: ["User/globalStorage/state.vscdb"], safetyCopyRoot: "/safety-root",
    });
    const text = await handleRestore({ backupPath: "/x/backup.zip", force: true });
    expect(history.restoreBackup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(history.restoreBackup).mock.calls[0]?.[0]).toMatchObject({ dryRun: true });
    expect(text).toContain("PREVIEW ONLY. Nothing was changed.");
    expect(text).toContain("[CURSOR_RUNNING] Cursor is running: quit Cursor first");
    expect(text).toContain("User/globalStorage/state.vscdb");
    expect(text).toContain("/safety-root");
    expect(text).toContain("To apply: dryRun=false, force=true (if data exists), confirm=true (live Cursor data).");
    expect(text).toContain("Files that would be restored: 2");
    expect(text).toContain("Sessions in backup: 3");
  });

  it("dryRun=false restores, maps confirm and reports the safety copy", async () => {
    vi.mocked(history.restoreBackup).mockResolvedValue({
      success: true, targetPath: "/t", filesRestored: 2, warnings: [], durationMs: 1,
      safetyCopy: { directory: "/safety/2025-x", manifestPath: "/safety/2025-x/manifest.json", fileCount: 4 },
    });
    const text = await handleRestore({ backupPath: "/x/backup.zip", dryRun: false, force: true, confirm: true });
    expect(history.restoreBackup).toHaveBeenCalledWith({
      backupPath: "/x/backup.zip", force: true, confirmLiveTarget: true, allowPartial: false, dryRun: false,
    });
    expect(text).toContain("Restore completed successfully");
    expect(text).toContain("/safety/2025-x");
    expect(text).toContain("Files in safety copy: 4");
    expect(text).toContain("roll back manually");
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
