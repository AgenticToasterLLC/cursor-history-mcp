import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Synthetic databases only. Every path is under os.tmpdir(); the vitest setup also sandboxes APPDATA etc.
const composerId = "bbbbbbbb-0000-0000-0000-0000000000b1";
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

/** Builds a synthetic Cursor `User` tree (workspaceStorage + globalStorage). */
function buildUserTree(user: string, project: string, destination: string) {
  const workspace = join(user, "workspaceStorage", "workspace-a");
  const db = database(join(workspace, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [{ composerId, name: "M7 fixture", createdAt, lastUpdatedAt: createdAt }] }));
  db.close();
  writeFileSync(join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(project).href }));
  const destWorkspace = join(user, "workspaceStorage", "workspace-b");
  const destDb = database(join(destWorkspace, "state.vscdb"));
  destDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  destDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [] }));
  destDb.close();
  writeFileSync(join(destWorkspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(destination).href }));
  const global = database(join(user, "globalStorage", "state.vscdb"));
  global.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`composerData:${composerId}`, JSON.stringify({ name: "M7 fixture", createdAt, workspaceIdentifier: { uri: { path: decodeURIComponent(pathToFileURL(project).pathname) } }, fullConversationHeadersOnly: [{ bubbleId: "msg-1", type: 1 }] }));
  global.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`bubbleId:${composerId}:msg-1`, JSON.stringify({ bubbleId: "msg-1", type: 1, text: "hello", createdAt }));
  global.close();
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

describe("M7 write-safety surfacing over stdio", () => {
  let root: string;
  let userA: string; // custom data dir used by most tests
  let userB: string; // custom data dir with a non-empty -wal
  let project: string;
  let destination: string;
  let sidecar: string;
  let restoreSafety: string;
  let migrateSafety: string;
  let archive: string;
  const clients: { client: Client; transport: StdioClientTransport }[] = [];

  function baseEnv(): Record<string, string> {
    return {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      CURSOR_STORE_ROOT: join(root, "store"),
      CURSOR_HISTORY_INDEX_PATH: join(sidecar, "index.db"),
      CURSOR_HISTORY_SAFETY_DIR: migrateSafety,
      CURSOR_HISTORY_RESTORE_SAFETY_DIR: restoreSafety,
    };
  }

  async function connectWith(env: Record<string, string>) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.env.MCP_TEST_ENTRY ?? resolve("dist/index.cjs")],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "m7-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    clients.push({ client, transport });
    return client;
  }

  /** Fixture tests: explicit data dir; the running-check skip is honoured only outside the platform default. */
  const connect = (user: string, skipRunningCheck = true) =>
    connectWith({
      ...baseEnv(),
      CURSOR_DATA_PATH: join(user, "workspaceStorage"),
      ...(skipRunningCheck ? { CURSOR_HISTORY_SKIP_RUNNING_CHECK: "1" } : {}),
    });

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (process.env.M7_DUMP) writeFileSync(process.env.M7_DUMP, `
=== ${name} ${JSON.stringify(args).replace(root, "<root>")}
${JSON.stringify(result.content)}
`, { flag: "a" }); // TMPDUMP
    if (!Array.isArray(result.content)) throw new Error("Expected MCP tool content");
    return { error: result.isError, text: result.content.map(item => item.type === "text" ? item.text : "").join("\n") };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "mcp-m7-"));
    project = join(root, "project");
    destination = join(root, "destination-project");
    sidecar = join(root, "sidecar");
    restoreSafety = join(root, "restore-safety");
    migrateSafety = join(root, "migrate-safety");
    for (const d of [project, destination, sidecar]) mkdirSync(d, { recursive: true });
    userA = join(root, "A", "User");
    userB = join(root, "B", "User");
    buildUserTree(userA, project, destination);
    archive = join(root, "backups", "m7.zip");
    const client = await connect(userA);
    const made = await call(client, "cursor_history_backup", { outputPath: archive });
    expect(made.error, made.text).not.toBe(true);
    expect(existsSync(archive)).toBe(true);
    // B is a copy of A with a non-empty write-ahead log next to a database (an unflushed Cursor write).
    cpSync(userA, userB, { recursive: true });
    writeFileSync(join(userB, "workspaceStorage", "workspace-a", "state.vscdb-wal"), Buffer.alloc(64, 1));
  }, 60000);

  afterAll(async () => {
    for (const { client, transport } of clients) { await client.close(); await transport.close(); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("restore dry run lists files to replace, the safety copy location and how to apply", async () => {
    const client = await connect(userA);
    const before = hashTree(userA);
    const out = await call(client, "cursor_history_restore", { backupPath: archive, force: true });
    expect(out.error, out.text).not.toBe(true);
    expect(out.text).toContain("PREVIEW ONLY. Nothing was changed.");
    expect(out.text).toMatch(/Existing files that would be replaced: [1-9]/);
    expect(out.text).toContain("state.vscdb");
    expect(out.text).toContain(restoreSafety);
    expect(out.text).toContain("To apply: dryRun=false, force=true (if data exists), confirm=true (live Cursor data).");
    expect(hashTree(userA)).toEqual(before);
    expect(existsSync(restoreSafety)).toBe(false);
  }, 60000);

  it("a non-empty -wal is a CURSOR_RUNNING blocker in the dry run and a typed error with no writes in the real run", async () => {
    // No skip env: the WAL check must fire (a running Cursor would also give CURSOR_RUNNING).
    const client = await connect(userB, false);
    const before = hashTree(userB);
    const dry = await call(client, "cursor_history_restore", { backupPath: archive, force: true });
    expect(dry.error, dry.text).not.toBe(true);
    expect(dry.text).toContain("Blocking conditions");
    expect(dry.text).toContain("[CURSOR_RUNNING]");
    const real = await call(client, "cursor_history_restore", { backupPath: archive, force: true, dryRun: false });
    expect(real.error).toBe(true);
    expect(real.text).toMatch(/^\[CURSOR_RUNNING\]/);
    expect(hashTree(userB)).toEqual(before);
    expect(existsSync(restoreSafety)).toBe(false);
  }, 60000);

  it("a real restore into a custom data dir reports where the safety copy is and how to roll back", async () => {
    const client = await connect(userA);
    const out = await call(client, "cursor_history_restore", { backupPath: archive, force: true, dryRun: false });
    expect(out.error, out.text).not.toBe(true);
    expect(out.text).toContain("Restore completed successfully");
    const match = /Safety copy: (.+)\r?\n/.exec(out.text);
    expect(match, out.text).not.toBeNull();
    const dir = match![1]!.trim();
    expect(resolve(dir).startsWith(resolve(restoreSafety))).toBe(true);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(out.text).toMatch(/Files in safety copy: [1-9]/);
    expect(out.text).toContain("roll back manually");
  }, 60000);

  describe("platform-default (live) target", () => {
    let fakeLiveUser: string;
    beforeAll(() => {
      // The vitest setup points APPDATA at a sandbox; the platform default resolves under it.
      const appData = process.env.APPDATA ?? "";
      expect(resolve(appData).startsWith(resolve(tmpdir()))).toBe(true);
      fakeLiveUser = join(appData, "Cursor", "User");
      expect(existsSync(fakeLiveUser)).toBe(false);
      buildUserTree(fakeLiveUser, project, destination);
    });
    afterAll(() => {
      if (fakeLiveUser && resolve(fakeLiveUser).startsWith(resolve(tmpdir()))) rmSync(dirname(fakeLiveUser), { recursive: true, force: true });
    });

    // CURSOR_DATA_PATH deliberately unset: the reader sees its platform default.
    const connectDefault = () => connectWith({ ...baseEnv(), CURSOR_HISTORY_SKIP_RUNNING_CHECK: "1" });

    it("force without confirm is refused with LIVE_TARGET_NOT_CONFIRMED and nothing is written", async () => {
      const client = await connectDefault();
      const before = hashTree(fakeLiveUser);
      const out = await call(client, "cursor_history_restore", { backupPath: archive, force: true, dryRun: false });
      expect(out.error).toBe(true);
      expect(out.text).toMatch(/^\[LIVE_TARGET_NOT_CONFIRMED\]/);
      expect(out.text).toContain("confirm=true");
      expect(hashTree(fakeLiveUser)).toEqual(before);
      const dry = await call(client, "cursor_history_restore", { backupPath: archive, force: true });
      expect(dry.text).toContain("[LIVE_TARGET_NOT_CONFIRMED]");
    }, 60000);

    it("with confirm it restores and reports the safety copy (or is blocked by a genuinely running Cursor)", async () => {
      const client = await connectDefault();
      const out = await call(client, "cursor_history_restore", { backupPath: archive, force: true, confirm: true, dryRun: false });
      if (out.error) {
        // The skip env is ignored for the platform default, so a developer's open Cursor legitimately blocks this.
        expect(out.text).toMatch(/^\[CURSOR_RUNNING\]/);
        return;
      }
      expect(out.text).toContain("Restore completed successfully");
      expect(out.text).toContain("Safety copy: ");
      expect(out.text).toMatch(/Files in safety copy: [1-9]/);
    }, 60000);
  });

  it("migrate dry run lists the safety copy estimate and warns that it can take minutes", async () => {
    const client = await connect(userA);
    const out = await call(client, "cursor_history_migrate", { sessionIds: [composerId], destination, workspace: project, mode: "copy" });
    expect(out.error, out.text).not.toBe(true);
    expect(out.text).toContain("PREVIEW ONLY");
    expect(out.text).toMatch(/safety copy .*about \d+(\.\d+)? (B|KB|MB|GB)/);
    expect(out.text).toContain("can take minutes");
  }, 60000);

  it("a real copy migration reports the safety copy directory and size", async () => {
    const client = await connect(userA);
    const out = await call(client, "cursor_history_migrate", { sessionIds: [composerId], destination, workspace: project, mode: "copy", dryRun: false });
    expect(out.error, out.text).not.toBe(true);
    expect(out.text).toContain("Successfully copied 1 session(s)");
    const match = /Safety copy: (.+)\r?\n/.exec(out.text);
    expect(match, out.text).not.toBeNull();
    const dir = match![1]!.trim();
    expect(resolve(dir).startsWith(resolve(migrateSafety))).toBe(true);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(out.text).toMatch(/Size: \d+(\.\d+)? (B|KB|MB|GB) in [1-9]\d* file/);
  }, 60000);

  it("backup into Cursor's globalStorage is refused with PROTECTED_PATH and nothing changes", async () => {
    const client = await connect(userA);
    const before = hashTree(userA);
    const inside = join(userA, "globalStorage", "evil.zip");
    const out = await call(client, "cursor_history_backup", { outputPath: inside });
    expect(out.error).toBe(true);
    expect(out.text).toMatch(/^\[PROTECTED_PATH\]/);
    expect(out.text).toContain("outside Cursor's folders");
    expect(existsSync(inside)).toBe(false);
    expect(hashTree(userA)).toEqual(before);
    const named = await call(client, "cursor_history_backup", { outputPath: join(root, "backups", "x.vscdb") });
    expect(named.text).toMatch(/^\[PROTECTED_PATH\]/);
  }, 60000);
});
