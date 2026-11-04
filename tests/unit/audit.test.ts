import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditLogPath, flagsFrom, withAudit } from "../../src/audit.js";
import { McpToolError } from "../../src/errors.js";
import { MCP_ERROR_CODES } from "../../src/types.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "mcp-audit-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("audit log", () => {
  it("resolves next to CURSOR_HISTORY_INDEX_PATH", () => {
    expect(auditLogPath({ CURSOR_HISTORY_INDEX_PATH: join("a", "b", "index.db") })).toBe(join("a", "b", "audit.log"));
  });

  it("records flags only, never argument values", () => {
    expect(flagsFrom({ dryRun: false, confirm: true, mode: "copy", destination: "/secret/path", sessionIds: ["x"] }))
      .toEqual({ dryRun: false, confirm: true, mode: "copy" });
  });

  it("records failures with the error code", async () => {
    const d = tmp();
    const env = { CURSOR_HISTORY_INDEX_PATH: join(d, "index.db") };
    const err = new McpToolError({ code: MCP_ERROR_CODES.INVALID_ARGUMENTS, message: "contains /secret/path" });
    await expect(withAudit("cursor_history_restore", { dryRun: false }, async () => { throw err; }, env)).rejects.toBe(err);
    const line = JSON.parse(readFileSync(join(d, "audit.log"), "utf8").trim());
    expect(line).toMatchObject({ tool: "cursor_history_restore", success: false, errorCode: "INVALID_ARGUMENTS", dryRun: false });
    expect(JSON.stringify(line)).not.toContain("secret");
  });

  it("opt-out writes nothing", async () => {
    const d = tmp();
    const env = { CURSOR_HISTORY_INDEX_PATH: join(d, "index.db"), CURSOR_HISTORY_MCP_AUDIT: "0" };
    await withAudit("cursor_history_backup", {}, async () => ({ text: "ok" }), env);
    expect(existsSync(join(d, "audit.log"))).toBe(false);
  });

  it("an unwritable audit location never fails the tool", async () => {
    const d = tmp();
    // A regular file where the directory should be makes mkdir/append fail on every platform.
    const blocker = join(d, "blocker");
    writeFileSync(blocker, "x");
    const env = { CURSOR_HISTORY_INDEX_PATH: join(blocker, "sub", "index.db") };
    await expect(withAudit("cursor_history_backup", {}, async () => ({ text: "done", sessions: 2 }), env)).resolves.toBe("done");
  });
});
