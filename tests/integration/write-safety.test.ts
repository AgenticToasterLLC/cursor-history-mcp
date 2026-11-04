import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Synthetic databases only. Never point this test at a real Cursor data tree.
const composerId = "aaaaaaaa-0000-0000-0000-0000000000a1";
const createdAt = Date.UTC(2025, 5, 1);
const SECRET_TEXT = "SECRET-MESSAGE-BODY-xyz";
const SECRET_TITLE = "Secret Title Quux";

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

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

describe("write tool safety over stdio", () => {
  let root: string;
  let project: string;
  let destination: string;
  let sidecar: string;
  const clients: { client: Client; transport: StdioClientTransport }[] = [];

  async function connect(extraEnv: Record<string, string> = {}) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.env.MCP_TEST_ENTRY ?? resolve("dist/index.cjs")],
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
        CURSOR_DATA_PATH: join(root, "User", "workspaceStorage"),
        CURSOR_STORE_ROOT: join(root, "store"),
        CURSOR_HISTORY_INDEX_PATH: join(sidecar, "index.db"),
        ...extraEnv,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "write-safety-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    clients.push({ client, transport });
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (!Array.isArray(result.content)) throw new Error("Expected MCP tool content");
    return { error: result.isError, text: result.content.map(item => item.type === "text" ? item.text : "").join("\n") };
  }

  const auditLines = () => {
    const file = join(sidecar, "audit.log");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-write-safety-"));
    project = join(root, "project");
    destination = join(root, "destination-project");
    sidecar = join(root, "sidecar");
    mkdirSync(project);
    mkdirSync(destination);
    mkdirSync(sidecar);
    const workspace = join(root, "User", "workspaceStorage", "workspace-a");
    const db = database(join(workspace, "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [{ composerId, name: SECRET_TITLE, createdAt, lastUpdatedAt: createdAt }] }));
    db.close();
    writeFileSync(join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(project).href }));
    // The destination must be a known workspace, so give it an empty workspace database.
    const destWorkspace = join(root, "User", "workspaceStorage", "workspace-b");
    const destDb = database(join(destWorkspace, "state.vscdb"));
    destDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    destDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [] }));
    destDb.close();
    writeFileSync(join(destWorkspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(destination).href }));
    const global = database(join(root, "User", "globalStorage", "state.vscdb"));
    global.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`composerData:${composerId}`, JSON.stringify({ name: SECRET_TITLE, createdAt, workspaceIdentifier: { uri: { path: decodeURIComponent(pathToFileURL(project).pathname) } }, fullConversationHeadersOnly: [{ bubbleId: "msg-1", type: 1 }] }));
    global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`bubbleId:${composerId}:msg-1`, JSON.stringify({ bubbleId: "msg-1", type: 1, text: SECRET_TEXT, createdAt }));
    global.close();
  });

  afterAll(async () => {
    for (const { client, transport } of clients) { await client.close(); await transport.close(); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("migrate defaults to a preview and writes nothing", async () => {
    const client = await connect();
    const before = hashTree(join(root, "User"));
    for (const args of [
      { sessionIds: [composerId], destination, workspace: project },
      { sessionIds: [composerId], destination, workspace: project, mode: "copy" },
    ]) {
      const out = await call(client, "cursor_history_migrate", args);
      expect(out.error, out.text).not.toBe(true);
      expect(out.text).toContain("PREVIEW ONLY. Nothing was changed. To apply: dryRun=false (and confirm=true for move).");
    }
    expect(hashTree(join(root, "User"))).toEqual(before);
  });

  it("refuses move without confirm, with a typed error and no writes", async () => {
    const client = await connect();
    const before = hashTree(join(root, "User"));
    const out = await call(client, "cursor_history_migrate", { sessionIds: [composerId], destination, workspace: project, dryRun: false });
    expect(out.error).toBe(true);
    expect(out.text).toMatch(/^\[INVALID_ARGUMENTS\]/);
    expect(out.text).toContain("deletes the originals");
    expect(out.text).toContain("confirm=true");
    expect(hashTree(join(root, "User"))).toEqual(before);
  });

  it("returns typed errors for unknown sessions", async () => {
    const client = await connect();
    const out = await call(client, "cursor_history_migrate", { sessionIds: ["no-such-session"], destination, workspace: project });
    expect(out.error).toBe(true);
    expect(out.text).toMatch(/^\[[A-Z_]+\] /);
  });

  // Verified on Windows: the reader's migrate write path does not hang (unlike backup/restore).
  it(
    "copy with dryRun=false works on a synthetic Composer fixture",
    async () => {
      const client = await connect();
      const out = await call(client, "cursor_history_migrate", { sessionIds: [composerId], destination, workspace: project, mode: "copy", dryRun: false });
      expect(out.error, out.text).not.toBe(true);
      expect(out.text).toContain("Successfully copied 1 session(s)");
      expect(out.text).not.toContain("PREVIEW ONLY");
    },
    30000
  );

  it("restore defaults to a dry run and reports invalid backups as typed errors", async () => {
    const client = await connect();
    const bogus = join(root, "bogus.zip");
    writeFileSync(bogus, "not a zip");
    const before = hashTree(join(root, "User"));
    const out = await call(client, "cursor_history_restore", { backupPath: bogus });
    expect(out.error).toBe(true);
    expect(out.text).toMatch(/^\[[A-Z_]+\] /);
    expect(hashTree(join(root, "User"))).toEqual(before);
  });

  it("writes content-free audit lines", async () => {
    const lines = auditLines();
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const raw = readFileSync(join(sidecar, "audit.log"), "utf8");
    for (const forbidden of [composerId, project, destination, root, "bogus.zip", SECRET_TITLE, SECRET_TEXT, "workspace-a"]) {
      expect(raw).not.toContain(forbidden);
    }
    const preview = lines.find(l => l.tool === "cursor_history_migrate" && l.success === true);
    expect(preview).toMatchObject({ tool: "cursor_history_migrate", sessions: 1, success: true, errorCode: null });
    expect(Number.isNaN(Date.parse(preview.time))).toBe(false);
    expect(typeof preview.durationMs).toBe("number");
    const refused = lines.find(l => l.dryRun === false && l.success === false);
    expect(refused).toMatchObject({ tool: "cursor_history_migrate", errorCode: "INVALID_ARGUMENTS" });
    expect(lines.some(l => l.tool === "cursor_history_restore" && l.success === false)).toBe(true);
  });

  it("CURSOR_HISTORY_MCP_AUDIT=0 disables the audit log", async () => {
    const other = join(root, "sidecar-off");
    mkdirSync(other);
    const client = await connect({ CURSOR_HISTORY_INDEX_PATH: join(other, "index.db"), CURSOR_HISTORY_MCP_AUDIT: "0" });
    // Outcome is irrelevant here (the earlier copy may make the preview fail); only the log matters.
    await call(client, "cursor_history_migrate", { sessionIds: [composerId], destination, workspace: project });
    expect(existsSync(join(other, "audit.log"))).toBe(false);
  });
});
