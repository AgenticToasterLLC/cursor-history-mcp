import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Synthetic databases only. Never point this test at a real Cursor data tree.
const composerId = "aaaaaaaa-0000-0000-0000-000000000001";
const dupId = "dddddddd-0000-0000-0000-000000000002";
const createdAt = Date.UTC(2025, 5, 1);

function database(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  let Database;
  try {
    Database = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
  } catch {
    Database = createRequire(import.meta.url)("better-sqlite3");
  }
  return new Database(path);
}

describe("workspaces, status, scope and ambiguity over stdio", () => {
  let root: string;
  let project: string;
  let emptyProject: string;
  let dupProject: string;
  let client: Client;
  let transport: StdioClientTransport;

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (!Array.isArray(result.content)) throw new Error("Expected MCP tool content");
    return { error: result.isError, text: result.content.map(item => item.type === "text" ? item.text : "").join("\n") };
  }

  function workspaceStorage(id: string, folder: string, composers: unknown[]) {
    const dir = join(root, "User", "workspaceStorage", id);
    const db = database(join(dir, "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: composers }));
    db.close();
    writeFileSync(join(dir, "workspace.json"), JSON.stringify({ folder: pathToFileURL(folder).href }));
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "mcp-ws-status-"));
    project = join(root, "project");
    emptyProject = join(root, "empty-project");
    dupProject = join(root, "dup-project");
    for (const dir of [project, emptyProject, dupProject]) mkdirSync(dir);

    workspaceStorage("workspace-a", project, [{ composerId, name: "Composer test", createdAt, lastUpdatedAt: createdAt }]);
    workspaceStorage("workspace-empty", emptyProject, []);
    // Two workspace replicas of one session whose titles diverge (reader reports SESSION_AMBIGUOUS).
    workspaceStorage("workspace-dup1", dupProject, [{ composerId: dupId, name: "Replica one", createdAt, lastUpdatedAt: createdAt }]);
    workspaceStorage("workspace-dup2", dupProject, [{ composerId: dupId, name: "Replica two", createdAt, lastUpdatedAt: createdAt }]);

    const global = database(join(root, "User", "globalStorage", "state.vscdb"));
    global.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const put = (key: string, value: unknown) => global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
    put(`composerData:${composerId}`, { name: "Composer test", createdAt, workspaceIdentifier: { uri: { fsPath: project } }, fullConversationHeadersOnly: [{ bubbleId: "msg-1", type: 1 }] });
    put(`bubbleId:${composerId}:msg-1`, { bubbleId: "msg-1", type: 1, text: "Composer authentication question", createdAt });
    global.close();

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.env.MCP_TEST_ENTRY ?? resolve("dist/index.cjs")],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CURSOR_DATA_PATH: join(root, "User", "workspaceStorage"), CURSOR_STORE_ROOT: join(root, "store"), CURSOR_HISTORY_INDEX_PATH: join(root, "catalog.sqlite") },
      stderr: "pipe",
    });
    client = new Client({ name: "workspaces-status-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("workspaces lists the fixture workspaces, including one with no sessions", async () => {
    const result = await call("cursor_history_workspaces");
    expect(result.error, result.text).not.toBe(true);
    // The inventory normalizes paths (case, separators) on Windows.
    const norm = (value: string) => value.split("\\").join("/").toLowerCase();
    expect(norm(result.text)).toContain(norm(project));
    expect(norm(result.text)).toContain(norm(emptyProject));
    expect(result.text).toContain("Inventory lists every workspace Cursor has recorded");
    expect(result.text).not.toContain("Composer test");
    const filtered = await call("cursor_history_workspaces", { query: "empty-project", limit: 1 });
    expect(filtered.text).toContain("empty-project");
    expect(filtered.text).not.toContain("dup-project");
  });

  it("status reports OK from the inventory probe", async () => {
    const result = await call("cursor_history_status", { verbose: true });
    expect(result.error, result.text).not.toBe(true);
    expect(result.text).toContain("OK:");
    expect(result.text).toContain("Workspaces by source: composer=");
    expect(result.text).toContain("Catalog mode: auto");
    expect(result.text).toContain("Reader (cursor-history) version:");
  });

  it("list with an unknown workspace returns not-found with suggestions", async () => {
    const result = await call("cursor_history_list", { workspace: join(root, "elsewhere", "project") });
    expect(result.error, result.text).not.toBe(true);
    expect(result.text).toContain("No workspace in local Cursor history matches");
    expect(result.text).toContain("Did you mean:");
    expect(result.text).toContain("cursor_history_workspaces");
  });

  it("list with a known workspace that has no sessions says so", async () => {
    const result = await call("cursor_history_list", { workspace: emptyProject });
    expect(result.error, result.text).not.toBe(true);
    expect(result.text).toContain("is known to Cursor history but has no chat sessions");
  });

  it("search skips ambiguous sessions instead of failing and reports them", async () => {
    const result = await call("cursor_history_search", { query: "authentication" });
    expect(result.error, result.text).not.toBe(true);
    expect(result.text).toContain("Composer authentication question");
    expect(result.text).toContain(`Skipped 1 ambiguous session(s): ${dupId}`);
    expect(result.text).toContain("except for the skipped ambiguous session(s)");
  });
});
