import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Synthetic databases only. Never point this test at a real Cursor data tree.
const composerId = "aaaaaaaa-0000-0000-0000-000000000001";
const createdAt = Date.UTC(2025, 5, 1);
const FORBIDDEN = ["oneOf", "anyOf", "allOf", "not", "if", "then", "else"];

// Walk the schema; ignore keys that are merely property names under "properties".
function findForbidden(node: unknown, path = "inputSchema", isPropertyMap = false): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => findForbidden(item, `${path}[${i}]`));
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => [
    ...(!isPropertyMap && FORBIDDEN.includes(key) ? [`${path}.${key}`] : []),
    ...findForbidden(value, `${path}.${key}`, !isPropertyMap && key === "properties"),
  ]);
}

describe("published tool schemas and selector validation", () => {
  let root: string;
  let project: string;
  let workspaceDb: string;
  let globalDb: string;
  let client: Client;
  let transport: StdioClientTransport;

  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const snapshot = () => [hash(workspaceDb), hash(globalDb)];

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

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (!Array.isArray(result.content)) throw new Error("Expected MCP tool content");
    return { error: result.isError, text: result.content.map(item => item.type === "text" ? item.text : "").join("\n") };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "mcp-tool-schemas-"));
    project = join(root, "project");
    mkdirSync(project);
    const workspace = join(root, "User", "workspaceStorage", "workspace-a");
    workspaceDb = join(workspace, "state.vscdb");
    const db = database(workspaceDb);
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [{ composerId, name: "Composer test", createdAt, lastUpdatedAt: createdAt }] }));
    db.close();
    writeFileSync(join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(project).href }));
    globalDb = join(root, "User", "globalStorage", "state.vscdb");
    const global = database(globalDb);
    global.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`composerData:${composerId}`, JSON.stringify({ name: "Composer test", createdAt, workspaceIdentifier: { uri: { fsPath: project } }, fullConversationHeadersOnly: [{ bubbleId: "msg-1", type: 1 }] }));
    global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`bubbleId:${composerId}:msg-1`, JSON.stringify({ bubbleId: "msg-1", type: 1, text: "Composer authentication question", createdAt }));
    global.close();

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.env.MCP_TEST_ENTRY ?? resolve("dist/index.cjs")],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CURSOR_DATA_PATH: join(root, "User", "workspaceStorage"), CURSOR_STORE_ROOT: join(root, "store") },
      stderr: "pipe",
    });
    client = new Client({ name: "tool-schemas-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("publishes every tool with a plain object root schema", async () => {
    const { tools } = await client.listTools();
    // Matches TOOLS in src/index.ts: list, show, search, export, backup, restore, migrate, year_pack.
    expect(tools.map(tool => tool.name).sort()).toEqual([
      "cursor_history_backup", "cursor_history_export", "cursor_history_list", "cursor_history_migrate",
      "cursor_history_restore", "cursor_history_search", "cursor_history_show", "cursor_history_status",
      "cursor_history_workspaces", "cursor_history_year_pack",
    ]);
    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(findForbidden(tool.inputSchema), tool.name).toEqual([]);
      for (const key of FORBIDDEN) expect(tool.inputSchema, `${tool.name}.${key}`).not.toHaveProperty(key);
    }
    const migrate = tools.find(tool => tool.name === "cursor_history_migrate");
    expect(migrate?.inputSchema.required).toEqual(["destination"]);
  });

  it("show and export accept sessionId or sessionIndex", async () => {
    for (const selector of [{ sessionId: composerId }, { sessionIndex: 1 }]) {
      const shown = await call("cursor_history_show", selector);
      expect(shown.error, shown.text).not.toBe(true);
      expect(shown.text).toContain("authentication question");
      const exported = await call("cursor_history_export", { ...selector, format: "json" });
      expect(exported.error, exported.text).not.toBe(true);
      expect(JSON.parse(exported.text).id).toBe(composerId);
    }
  });

  it("migrate dry run with a valid selector does not crash or change files", async () => {
    const before = snapshot();
    const result = await call("cursor_history_migrate", { sessionIds: [composerId], destination: join(root, "destination"), workspace: project, dryRun: true });
    expect(result.text).not.toMatch(/Provide exactly one/);
    expect(snapshot()).toEqual(before);
  });

  const neither = "Provide exactly one of sessionId or sessionIndex (neither was given)";
  const both = "Provide exactly one of sessionId or sessionIndex (both were given)";
  it.each([
    ["cursor_history_show", {}, neither],
    ["cursor_history_show", { sessionId: composerId, sessionIndex: 1 }, both],
    ["cursor_history_export", {}, neither],
    ["cursor_history_export", { sessionId: composerId, sessionIndex: 1 }, both],
    ["cursor_history_migrate", {}, "Provide exactly one of sessionIds or sessionIndexes (neither was given)"],
    ["cursor_history_migrate", { sessionIds: [composerId], sessionIndexes: [1] }, "Provide exactly one of sessionIds or sessionIndexes (both were given)"],
  ])("%s %j is refused with a clear message", async (name, args, message) => {
    const before = snapshot();
    const input = name === "cursor_history_migrate" ? { ...args, destination: join(root, "destination"), dryRun: true } : args;
    const result = await call(name, input);
    expect(result.error).toBe(true);
    // show/export tag validation errors with [INVALID_ARGUMENTS]; migrate keeps its plain message.
    expect(result.text).toBe(name === "cursor_history_migrate" ? message : `[INVALID_ARGUMENTS] ${message}`);
    expect(snapshot()).toEqual(before);
  });
});
