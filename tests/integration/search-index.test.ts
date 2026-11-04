import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Synthetic databases only. The sidecar always lives under the temp root.
const idA = "aaaaaaaa-0000-0000-0000-000000000001";
const idB = "bbbbbbbb-0000-0000-0000-000000000002";
const createdAt = Date.UTC(2025, 5, 1);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

describe("indexed search over stdio", () => {
  let root: string;
  let project: string;
  const open: { client: Client; transport: StdioClientTransport }[] = [];

  function addComposer(id: string, title: string, text: string) {
    const db = database(join(root, "User", "globalStorage", "state.vscdb"));
    db.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const put = (key: string, value: unknown) => db.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
    put(`composerData:${id}`, { name: title, createdAt, workspaceIdentifier: { uri: { fsPath: project } }, fullConversationHeadersOnly: [{ bubbleId: "msg-1", type: 1 }] });
    put(`bubbleId:${id}:msg-1`, { bubbleId: "msg-1", type: 1, text, createdAt });
    db.close();
  }

  async function connect(extraEnv: Record<string, string> = {}, sidecar = "catalog.sqlite") {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.env.MCP_TEST_ENTRY ?? resolve("dist/index.cjs")],
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
        CURSOR_DATA_PATH: join(root, "User", "workspaceStorage"),
        CURSOR_STORE_ROOT: join(root, "store"),
        CURSOR_HISTORY_INDEX_PATH: join(root, sidecar),
        ...extraEnv,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "search-index-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    open.push({ client, transport });
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (!Array.isArray(result.content)) throw new Error("Expected MCP tool content");
    return { error: result.isError, text: result.content.map(item => item.type === "text" ? item.text : "").join("\n") };
  }

  /** Results text without the coverage/order disclosure lines. */
  const body = (text: string) => text.split("\n").filter(l => !l.startsWith("Coverage:") && !l.startsWith("Order:")).join("\n");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-search-index-"));
    project = join(root, "project");
    mkdirSync(project);
    mkdirSync(join(root, "User", "workspaceStorage"), { recursive: true });
    addComposer(idA, "First session", "how do I tune the connection pool");
    addComposer(idB, "Second session", "the connection pool leaks under load");
  });

  afterAll(async () => {
    for (const { client, transport } of open) {
      await client.close();
      await transport.close();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("goes from direct (building) to indexed with identical results", async () => {
    await sleep(2500); // sources modified within the settle window are never reported ready
    const client = await connect({ CURSOR_HISTORY_SEARCH_INDEX: "1" });

    const first = await call(client, "cursor_history_search", { query: "connection pool" });
    expect(first.error, first.text).not.toBe(true);
    expect(first.text).toContain("Coverage: full scan of this scope (direct); complete.");
    expect(first.text).toContain("the search index is still building");
    expect(first.text).toContain(idA);
    expect(first.text).toContain(idB);

    const refresh = await call(client, "cursor_history_index_refresh", { wait: true, timeoutMs: 60000 });
    expect(refresh.text).toContain("State: ready");

    const second = await call(client, "cursor_history_search", { query: "connection pool" });
    expect(second.text).toContain("Coverage: index-assisted search verified against source; complete for this scope.");
    expect(body(second.text)).toBe(body(first.text));

    const short = await call(client, "cursor_history_search", { query: "co" });
    expect(short.text).toContain("Coverage: full scan of this scope (direct); complete.");
    expect(short.text).toContain("shorter than 3 characters");

    const recent = await call(client, "cursor_history_search", { query: "connection pool", order: "recent" });
    expect(recent.error, recent.text).not.toBe(true);
    expect(recent.text).toContain(idA);

    const status = await call(client, "cursor_history_status");
    expect(status.text).toContain("Search index: enabled");
  }, 90000);

  it("with the env off, search is a plain direct scan", async () => {
    const client = await connect({ CURSOR_HISTORY_SEARCH_INDEX: "" }, "catalog-off.sqlite");
    const result = await call(client, "cursor_history_search", { query: "connection pool" });
    expect(result.error, result.text).not.toBe(true);
    expect(result.text).toContain("Coverage: full scan of this scope (direct); complete.");
    expect(result.text).not.toContain("index was not used");
    expect(result.text).not.toContain("index-assisted");
    const status = await call(client, "cursor_history_status");
    expect(status.text).toContain("Search index: disabled");
  });
});
