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
const createdAt = Date.UTC(2025, 5, 1);
const MESSAGES = 30;
const BODY = 2000;

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

describe("bounded reads over stdio", () => {
  let root: string;
  const clients: { client: Client; transport: StdioClientTransport }[] = [];

  async function connect(extraEnv: Record<string, string> = {}) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.env.MCP_TEST_ENTRY ?? resolve("dist/index.cjs")],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), CURSOR_DATA_PATH: join(root, "User", "workspaceStorage"), CURSOR_STORE_ROOT: join(root, "store"), ...extraEnv },
      stderr: "pipe",
    });
    const client = new Client({ name: "bounded-reads-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    clients.push({ client, transport });
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (!Array.isArray(result.content)) throw new Error("Expected MCP tool content");
    return { error: result.isError, text: result.content.map(item => item.type === "text" ? item.text : "").join("\n") };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-bounded-reads-"));
    const project = join(root, "project");
    mkdirSync(project);
    const workspace = join(root, "User", "workspaceStorage", "workspace-a");
    const db = database(join(workspace, "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [{ composerId, name: "Big", createdAt, lastUpdatedAt: createdAt }] }));
    db.close();
    writeFileSync(join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(project).href }));
    const global = database(join(root, "User", "globalStorage", "state.vscdb"));
    global.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    const headers = Array.from({ length: MESSAGES }, (_, i) => ({ bubbleId: `msg-${i}`, type: i % 2 === 0 ? 1 : 2 }));
    insert.run(`composerData:${composerId}`, JSON.stringify({ name: "Big", createdAt, workspaceIdentifier: { uri: { fsPath: project } }, fullConversationHeadersOnly: headers }));
    for (const [i, h] of headers.entries()) {
      insert.run(`bubbleId:${composerId}:${h.bubbleId}`, JSON.stringify({ bubbleId: h.bubbleId, type: h.type, text: `MSG-${String(i).padStart(3, "0")} needle ${"z".repeat(BODY)}`, createdAt: createdAt + i }));
    }
    global.close();
  });

  afterAll(async () => {
    for (const { client, transport } of clients) { await client.close(); await transport.close(); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("pages show output and covers every message exactly once", async () => {
    const client = await connect();
    const seen: number[] = [];
    let offset = 0;
    for (let guard = 0; guard < 100; guard++) {
      const out = await call(client, "cursor_history_show", { sessionId: composerId, messageOffset: offset, maxChars: 7000 });
      expect(out.error, out.text).not.toBe(true);
      expect(out.text).toMatch(new RegExp(`Messages: ${offset + 1}-\\d+ of ${MESSAGES}`));
      for (const m of out.text.matchAll(/MSG-(\d{3})/g)) seen.push(Number(m[1]));
      const next = /truncated: true · nextMessageOffset: (\d+)/.exec(out.text);
      if (!next) { expect(out.text).toContain("truncated: false"); break; }
      offset = Number(next[1]);
    }
    expect(seen).toEqual(Array.from({ length: MESSAGES }, (_, i) => i));
  });

  it("export chunks reassemble to the unbounded export", async () => {
    const client = await connect();
    for (const format of ["markdown", "json"]) {
      const whole = await call(client, "cursor_history_export", { sessionId: composerId, format });
      expect(whole.error, whole.text).not.toBe(true);
      expect(whole.text).not.toMatch(/^\[export chunk:/);
      let out = "";
      let offset = 0;
      for (let guard = 0; guard < 200; guard++) {
        const chunk = await call(client, "cursor_history_export", { sessionId: composerId, format, chunkOffset: offset, maxChars: 9000 });
        expect(chunk.error, chunk.text).not.toBe(true);
        const nl = chunk.text.indexOf("\n");
        const header = chunk.text.slice(0, nl);
        expect(header).toMatch(/^\[export chunk: chars \d+-\d+ of \d+ · complete: (true|false)/);
        out += chunk.text.slice(nl + 1);
        const next = /nextChunkOffset: (\d+)\]$/.exec(header);
        if (!next) break;
        offset = Number(next[1]);
      }
      expect(out).toBe(whole.text);
      if (format === "json") expect(JSON.parse(out).id).toBe(composerId);
    }
  });

  it("bounds search output and reports coverage", async () => {
    const client = await connect();
    const out = await call(client, "cursor_history_search", { query: "needle", limit: 20, maxChars: 1500 });
    expect(out.error, out.text).not.toBe(true);
    expect(out.text).toMatch(/results shown: \d+ of \d+ returned · truncated: (true|false)/);
    expect(out.text).toContain("Coverage:");
  });

  it("reports an exceeded time budget honestly and stays alive", async () => {
    const client = await connect({ CURSOR_HISTORY_MCP_TIME_BUDGET_MS: "1" });
    // Synchronous SQLite reads make the abort cooperative: the call either
    // aborts with a typed error, or completes and returns the full result
    // with an explicit over-budget warning. It is never silently discarded.
    const expectHonest = (out: { error?: boolean; text: string }) => {
      if (out.error) {
        expect(out.text).toMatch(/^\[TIME_BUDGET_EXCEEDED\] /);
        expect(out.text).toContain("workspace");
      } else {
        expect(out.text).toMatch(/^\[warning: cursor_history_\w+ took \d+ ms, over its 1 ms time budget\./);
        expect(out.text).toContain("The result below is complete.");
      }
    };
    expectHonest(await call(client, "cursor_history_show", { sessionId: composerId }));
    expectHonest(await call(client, "cursor_history_export", { sessionId: composerId }));
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(8);
  });
});
