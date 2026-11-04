import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sandbox APPDATA/LOCALAPPDATA/USERPROFILE/HOME for every test process and
    // every MCP server it spawns, so no test can touch real Cursor data.
    setupFiles: ["tests/setup/isolate-user-dirs.ts"],
  },
});
