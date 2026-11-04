/**
 * Test safety net: point every per-user directory at a throwaway sandbox
 * before any test runs. Spawned MCP servers inherit process.env, so if any
 * code path ever falls back to a default location (Cursor's
 * %APPDATA%\Cursor\User, ~/.cursor, the catalog cache or the audit log),
 * it lands in an empty temp directory instead of the developer's real data.
 *
 * Background: the reader's backup/restore once ignored CURSOR_DATA_PATH, so
 * an integration test silently read the real Cursor directory and would have
 * restored over it with force. Tests must never rely on the code under test
 * honoring an override to stay away from real data.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mcp-test-userdirs-"));
const dirs = {
  APPDATA: join(sandbox, "AppData", "Roaming"),
  LOCALAPPDATA: join(sandbox, "AppData", "Local"),
  USERPROFILE: join(sandbox, "home"),
  HOME: join(sandbox, "home"),
  XDG_CONFIG_HOME: join(sandbox, "home", ".config"),
  XDG_CACHE_HOME: join(sandbox, "home", ".cache"),
};
for (const [key, value] of Object.entries(dirs)) {
  mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
// Tests that need data always pass explicit synthetic paths; clear any
// developer-level overrides so they cannot leak in either.
for (const key of ["CURSOR_DATA_PATH", "CURSOR_STORE_ROOT", "CURSOR_HISTORY_INDEX_PATH"]) {
  delete process.env[key];
}
