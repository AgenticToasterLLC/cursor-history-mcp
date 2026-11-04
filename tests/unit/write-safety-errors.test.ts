import { describe, expect, it } from "vitest";
import {
  CursorRunningError,
  LiveTargetNotConfirmedError,
  ProtectedPathError,
  RestoreRollbackError,
  RestoreSafetyCopyError,
} from "cursor-history";
import { formatErrorText, mapCursorHistoryError } from "../../src/errors.js";
import { flagsFrom, withAudit } from "../../src/audit.js";
import { errorCodeName } from "../../src/types.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const name = (e: unknown) => errorCodeName(mapCursorHistoryError(e).code);

describe("write-safety error mapping", () => {
  it("maps PROTECTED_PATH with a reason and a remedy", () => {
    const mapped = mapCursorHistoryError(new ProtectedPathError("backup-output", "database-file-name"));
    expect(errorCodeName(mapped.code)).toBe("PROTECTED_PATH");
    expect(mapped.message).toContain("named like a database file");
    expect(mapped.message).toContain("outside Cursor's folders");
    expect(mapped.remedy).toBeTruthy();
  });

  it("maps CURSOR_RUNNING, LIVE_TARGET_NOT_CONFIRMED and RESTORE_SAFETY_COPY_FAILED", () => {
    expect(name(new CursorRunningError("restore", ["wal"]))).toBe("CURSOR_RUNNING");
    const live = mapCursorHistoryError(new LiveTargetNotConfirmedError("C:/x/workspaceStorage"));
    expect(errorCodeName(live.code)).toBe("LIVE_TARGET_NOT_CONFIRMED");
    expect(formatErrorText(live)).toBeTruthy();
    expect(name(new RestoreSafetyCopyError("copy-failed", "C:/safety"))).toBe("SAFETY_COPY_FAILED");
  });

  it("RESTORE_ROLLBACK_INCOMPLETE names the safety copy directory", () => {
    const mapped = mapCursorHistoryError(new RestoreRollbackError(1, ["a"], undefined, undefined, { safetyCopyDir: "C:/safety/abc" }));
    expect(errorCodeName(mapped.code)).toBe("RESTORE_ROLLBACK_INCOMPLETE");
    expect(mapped.remedy).toContain("C:/safety/abc");
  });
});

describe("audit safety flags", () => {
  it("records allowPartial and a boolean safetyCopy, never the path", async () => {
    expect(flagsFrom({ allowPartial: true, confirm: true, backupPath: "/secret" })).toEqual({ allowPartial: true, confirm: true });
    const d = mkdtempSync(join(tmpdir(), "mcp-audit-sc-"));
    try {
      const env = { CURSOR_HISTORY_INDEX_PATH: join(d, "index.db") };
      await withAudit("cursor_history_restore", { dryRun: false }, async () => ({ text: "/secret/safety", safetyCopy: true }), env);
      const raw = readFileSync(join(d, "audit.log"), "utf8");
      expect(JSON.parse(raw.trim())).toMatchObject({ safetyCopy: true });
      expect(raw).not.toContain("secret");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
