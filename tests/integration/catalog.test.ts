import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Synthetic databases only. The sidecar catalog always lives under the temp root.
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

describe("sidecar catalog over stdio", () => {
  let root: string;
  let project: string;
  const open: { client: Client; transport: StdioClientTransport }[] = [];

  const globalPath = () => join(root, "User", "globalStorage", "state.vscdb");

  function addComposer(id: string, title: string) {
    const db = database(globalPath());
    db.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const put = (key: string, value: unknown) => db.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
    put(`composerData:${id}`, { name: title, createdAt, workspaceIdentifier: { uri: { fsPath: project } }, fullConversationHeadersOnly: [{ bubbleId: "msg-1", type: 1 }] });
    put(`bubbleId:${id}:msg-1`, { bubbleId: "msg-1", type: 1, text: `${title} question`, createdAt });
    db.close();
  }

  async function connect(extraEnv: Record<string, string> = {}) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.env.MCP_TEST_ENTRY ?? resolve("dist/index.cjs")],
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
        CURSOR_DATA_PATH: join(root, "User", "workspaceStorage"),
        CURSOR_STORE_ROOT: join(root, "store"),
        CURSOR_HISTORY_INDEX_PATH: join(root, "catalog.sqlite"),
        ...extraEnv,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "catalog-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    open.push({ client, transport });
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (!Array.isArray(result.content)) throw new Error("Expected MCP tool content");
    return { error: result.isError, text: result.content.map(item => item.type === "text" ? item.text : "").join("\n") };
  }

  const ids = (text: string) => [...text.matchAll(/ID: ([0-9a-f-]{36})/g)].map(m => m[1]).sort();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-catalog-"));
    project = join(root, "project");
    mkdirSync(project);
    mkdirSync(join(root, "User", "workspaceStorage"), { recursive: true });
    addComposer(idA, "First session");
  });

  afterAll(async () => {
    for (const { client, transport } of open) {
      await client.close();
      await transport.close();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("walks building, ready, ready, stale, ready and reports status", async () => {
    // Sources modified within the settle window (about 2 s) are never reported as ready.
    await sleep(2500);
    const client = await connect();

    const first = await call(client, "cursor_history_list");
    expect(first.error, first.text).not.toBe(true);
    expect(first.text).toContain("Catalog: building in background");
    expect(first.text).toContain("is complete");
    expect(first.text).toContain("prefer the session ID");
    expect(ids(first.text)).toEqual([idA]);

    const refresh = await call(client, "cursor_history_index_refresh", { wait: true, timeoutMs: 60000 });
    expect(refresh.error, refresh.text).not.toBe(true);
    expect(refresh.text).toContain("Build finished.");
    expect(refresh.text).toContain("State: ready");
    expect(existsSync(join(root, "catalog.sqlite"))).toBe(true);

    const second = await call(client, "cursor_history_list");
    expect(second.text).toMatch(/Catalog: ready \(snapshot \S+, verified \S+\)/);
    expect(ids(second.text)).toEqual(ids(first.text));

    const status = await call(client, "cursor_history_status");
    expect(status.text).toContain("Catalog mode: auto");
    expect(status.text).toContain("Scope (global): state=ready rows=1");
    expect(status.text).toContain("catalog.sqlite");

    // Change a source, then wait past the settle window so the change is not treated as in-flight.
    addComposer(idB, "Second session");
    await sleep(2500);

    const stale = await call(client, "cursor_history_list");
    expect(stale.text).toContain("Catalog: STALE");
    expect(stale.text).toContain("may be missing recent sessions");
    expect(ids(stale.text)).toEqual([idA]);

    const refreshed = await call(client, "cursor_history_index_refresh", { wait: true, timeoutMs: 60000 });
    expect(refreshed.text).toContain("State: ready");
    const fresh = await call(client, "cursor_history_list");
    expect(fresh.text).toContain("Catalog: ready");
    expect(ids(fresh.text)).toEqual([idA, idB].sort());
  }, 90000);

  it("direct mode renders no catalog line", async () => {
    const client = await connect({ CURSOR_HISTORY_MCP_CATALOG: "direct" });
    const result = await call(client, "cursor_history_list");
    expect(result.error, result.text).not.toBe(true);
    expect(result.text).not.toContain("Catalog:");
    expect(ids(result.text)).toHaveLength(2);
  });

  it("refresh without wait returns promptly", async () => {
    const client = await connect();
    const result = await call(client, "cursor_history_index_refresh");
    expect(result.error, result.text).not.toBe(true);
    expect(result.text).toMatch(/Catalog refresh for scope \(global\): (started|already running)/);
  });

  it("warm mode does not disturb the handshake or stdout", async () => {
    const client = await connect({ CURSOR_HISTORY_MCP_CATALOG_WARM: "1" });
    const result = await call(client, "cursor_history_list");
    expect(result.error, result.text).not.toBe(true);
    expect(ids(result.text)).toHaveLength(2);
  });
});
