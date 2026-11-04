# Cursor History MCP

<p align="center">
  <img src="docs/readme-banner.png" alt="cursor-history-mcp — Search your Cursor history through MCP. MCP-exclusive Year in Review: statistics, topics and report prompts." width="960">
</p>

[![npm version](https://img.shields.io/npm/v/cursor-history-mcp.svg)](https://www.npmjs.com/package/cursor-history-mcp)
[![npm downloads](https://img.shields.io/npm/dm/cursor-history-mcp.svg)](https://www.npmjs.com/package/cursor-history-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2C%2022--26-green.svg)](https://nodejs.org/)

[English](README.md) | [中文](docs/README_zh.md) | [Français](docs/README_fr.md) | [Español](docs/README_es.md)

**Let your AI search your Cursor history.**

Your existing Cursor conversations may already contain months of decisions, bugs, fixes, and architectural context. Give an MCP-capable assistant a way to find that context—without having recorded it with this tool beforehand.

`cursor-history-mcp` connects Claude, Cursor, and other MCP clients to the local history reader in [cursor-history](https://github.com/S2thend/cursor-history). Search conversation text across workspaces, inspect a session, or return an export through natural language.

No embeddings, indexing service, or API key is required by this server. Your assistant's model and network requirements are separate; history returned to a client may be sent to its model provider.

**MCP-exclusive: [Year in Review](#year-in-review).** Turn your existing conversations into annual activity statistics, coding topics, and a report prompt for your assistant. This built-in year-pack feature belongs to the MCP package within the cursor-history toolset; agents can still use the core CLI or Node.js API directly for history access.

> “Have we solved this authentication bug before? Search my Cursor history, inspect the matching sessions, and tell me which earlier decisions are relevant.”

[Quick start](#quick-start) · [Year in Review](#year-in-review) · [Storage support](#compatibility) · [Tools](#tools) · [Safety](#safety) · [CLI / Node.js companion](#companion-project)

<a id="quick-start"></a>
## Quick start

Requires Node.js **20.x or 22.x–26.x**, readable local Cursor history, and a client that supports local stdio MCP servers. The client must run the server on the machine where that history is available.

**Version scope:** these docs describe `cursor-history-mcp@0.3.1`, powered by `cursor-history@0.19.0`. If you are testing a checkout before its npm publication, use [the source setup](#run-from-source) below.

**Client compatibility:** the server uses MCP SDK 1.30.0. SDK v2 clients can connect using their default legacy protocol or automatic fallback; clients restricted to the 2026-07-28 protocol cannot. See [SDK interoperability](docs/sdk-compatibility.md) for the tested scope.

### Configure the npm package

Add this server entry to your client's MCP configuration:

```json
{
  "mcpServers": {
    "cursor-history": {
      "command": "npx",
      "args": ["-y", "cursor-history-mcp@0.3.1"]
    }
  }
}
```

If the client cannot find `npx`, use the absolute path to its executable. Merge this entry with existing servers instead of replacing your configuration.

### Cursor

Use project-local `.cursor/mcp.json` or global `~/.cursor/mcp.json`. Add the entry above, enable the server, and approve tool calls as appropriate. See [Cursor's MCP documentation](https://cursor.com/docs/mcp).

### Claude Code

Register the versioned npm package for your user account:

```bash
claude mcp add --transport stdio --scope user cursor-history -- npx -y cursor-history-mcp@0.3.1
```

See [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp) for scopes and permissions.

### Claude Desktop

Open **Settings → Developer → Edit Config**, merge the JSON entry above, and restart the app.

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

See the [local MCP server setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

The first run may download dependencies from npm. Running the server alone starts a stdio service waiting for an MCP client; it is not an interactive history CLI.

### Run from source

For development or testing before npm publication, build this repository:

```bash
npm ci
npm run build
```

In the server entry, use `"command": "node"` and `"args": ["/absolute/path/to/cursor-history-mcp/dist/index.cjs"]`, replacing the path. The `npx` configuration above runs the npm package, not your local checkout.

<a id="claude-code-vscodium-windows"></a>
### Claude Code in VSCodium on Windows

VSCodium launches the Claude Code process, but it is Claude Code's own MCP client that spawns this server and validates the tool schemas. Everything below is therefore Claude Code configuration, not VSCodium configuration.

Register the server for your user account. On Windows, `npx` is a `.cmd` shim, so wrap it with `cmd /c`:

```bash
claude mcp add --transport stdio --scope user cursor-history -- cmd /c npx -y cursor-history-mcp@0.3.1
```

If you installed the package globally (`npm i -g cursor-history-mcp`), use `cmd /c cursor-history-mcp`. For a local build (see [Run from source](#run-from-source)), call Node directly:

```bash
claude mcp add --transport stdio --scope user cursor-history -- node C:/path/to/cursor-history-mcp/dist/index.cjs
```

Equivalent user-level JSON (`~/.claude.json`, under `mcpServers`):

```json
{
  "mcpServers": {
    "cursor-history": {
      "command": "cmd",
      "args": ["/c", "cursor-history-mcp"]
    }
  }
}
```

For a local build use `"command": "node"` and `"args": ["C:/path/to/cursor-history-mcp/dist/index.cjs"]`.

**Verify that all tools are listed.** Run `claude mcp list` (the server should show as connected), then `/mcp` inside Claude Code and open the server. You should see all eleven tools: `cursor_history_list`, `_show`, `_search`, `_export`, `_backup`, `_restore`, `_migrate`, `_year_pack`, `_workspaces`, `_status` and `_index_refresh`. Ask Claude to call `cursor_history_status` to confirm that history is actually readable, not just that the server is connected.

**Environment variables**

| Variable | Purpose |
|---|---|
| `CURSOR_HISTORY_MCP_TIME_BUDGET_MS` | Per-call time budget for read tools in milliseconds (default `120000`, `0` disables). `CURSOR_HISTORY_MCP_TIME_BUDGET_MS_<TOOL>` (for example `..._SEARCH`) overrides it for one tool. |
| `CURSOR_HISTORY_MCP_AUDIT` | Set to `0` to disable the write-tool [audit log](#write-operations-are-previews-by-default). |
| Catalog variables | See the Catalog section. |

Pass variables with `claude mcp add --env NAME=value ...` or an `"env"` object in the JSON entry.

**Troubleshooting**

- *Some tools are missing:* update to the latest `cursor-history-mcp` and restart Claude Code. Older releases published schemas that Claude Code's validator rejected, so affected tools were silently dropped.
- *The first list is slow:* the first call may be building the catalog of a large history. Narrow with `workspace`, or raise `CURSOR_HISTORY_MCP_TIME_BUDGET_MS`; later calls are faster.
- *"Connection closed" or the server will not start on Windows:* launch it through `cmd /c` (or an absolute path to `node`); a bare `npx` cannot be spawned directly.

<a id="write-operations-are-previews-by-default"></a>
### Write operations are previews by default

The tools that can change local history are safe by default:

| Tool | Default | To apply |
|---|---|---|
| `cursor_history_migrate` | `dryRun: true`, nothing changes | `dryRun: false`; for `mode: "move"` (the default) also `confirm: true`, because a move deletes the originals |
| `cursor_history_restore` | `dryRun: true`, validates the archive and reports what would be restored, any blocking conditions and where the safety copy will go | `dryRun: false`; overwriting existing data additionally needs `force: true`; writing to the live (platform-default) Cursor folder also needs `confirm: true` |
| `cursor_history_backup` | Writes a new archive (it does not modify history); `force` is needed to overwrite an existing file. The output must be outside Cursor's folders and must not be named like a database, otherwise `[PROTECTED_PATH]` | n/a |

A preview says so explicitly: `PREVIEW ONLY. Nothing was changed. To apply: dryRun=false (and confirm=true for move).` A move without `confirm: true` is refused with an `[INVALID_ARGUMENTS]` error that explains why. Store-only, merged-source and ambiguous sessions are still refused by the reader.

**Safety copies and the Cursor-must-be-closed rule.** Before restore or migrate writes anything, the reader makes a verified copy (size and SHA-256 checked, with a `manifest.json`) of every file it is about to replace:

- restore: `%LOCALAPPDATA%\cursor-historyestore-safety\<timestamp>-<id>\` (override with `CURSOR_HISTORY_RESTORE_SAFETY_DIR`)
- migrate: `%LOCALAPPDATA%\cursor-history\migrate-safety\<timestamp>-<id>\` (override with `CURSOR_HISTORY_SAFETY_DIR`)

(on macOS and Linux the same folders live in the platform cache directory.) Safety copies are **never deleted automatically**; remove them yourself when you no longer need them. The real-run output names the folder and the number of files; to roll back by hand, quit Cursor and copy the files listed in its `manifest.json` back. A failed restore is rolled back automatically from the copy. Copying a large global database can take minutes and needs that much free disk space; a migrate preview shows the estimated size. The MCP tools do not let you choose the location or skip the copy.

Cursor must be closed. If it is running, has a non-empty `-wal` file next to a database, or a database is busy, the reader refuses with `[CURSOR_RUNNING]` and nothing is written (previews list it under "Blocking conditions" instead). Restoring over the live Cursor data with `force: true` additionally requires `confirm: true`; without it the call fails with `[LIVE_TARGET_NOT_CONFIRMED]`. If `CURSOR_DATA_PATH` is set, restore targets that folder instead. `allowPartial: true` lets a restore proceed with only the intact files when some archive entries fail their checksum (default: the whole restore is refused).

Other typed refusals: `[PROTECTED_PATH]`, `[SAFETY_COPY_FAILED]`, `[INSUFFICIENT_DISK_SPACE]`, `[SAFETY_COPY_REQUIRED]` and `[RESTORE_ROLLBACK_INCOMPLETE]` (which names the safety copy folder to restore from by hand).

**Audit log.** Each backup, restore and migrate call (previews included) appends one JSON line to `audit.log` in the sidecar directory: the directory of `CURSOR_HISTORY_INDEX_PATH` if set, otherwise `%LOCALAPPDATA%\cursor-history\` on Windows, otherwise the system temp directory. It records only the time, tool, `mode`/`dryRun`/`force`/`confirm`/`allowPartial` flags, whether a safety copy was made (a boolean, never its path), the number of selected sessions, success or failure, the error code and the duration. It never records session ids, titles, message text, backup contents or paths (not even hashed, since paths are low-entropy and a hash would be guessable). A failure to write the log never fails the tool. Disable it with `CURSOR_HISTORY_MCP_AUDIT=0`.

```json
{"time":"2026-01-01T12:00:00.000Z","tool":"cursor_history_migrate","mode":"copy","dryRun":true,"sessions":1,"success":true,"errorCode":null,"durationMs":42}
```

<a id="companion-project"></a>
## Two projects, one history reader

| Use case | Project |
|---|---|
| Run commands, write scripts, or embed history in a Node.js app | [cursor-history: CLI + Node.js API](https://github.com/S2thend/cursor-history#quick-start) |
| Let an assistant call history tools through MCP | **cursor-history-mcp**, this repository |

The MCP server delegates discovery and parsing to `cursor-history`; it does not maintain a separate conversation database or start recording your chats. The two npm packages have independent releases.

Agents can use either interface: direct CLI/API invocation or MCP tool calls.

<a id="compatibility"></a>
## Works across storage generations

With the `0.19.0` reader in MCP `0.3.1`:

| Source | Local files | Read / search / export |
|---|---|---|
| Legacy / Composer | `workspaceStorage/*/state.vscdb` + `globalStorage/state.vscdb` | Supported |
| Agent transcripts | `~/.cursor/projects/**/agent-transcripts/**/*.jsonl` | Available transcript content |
| Store / Agent CLI | `~/.cursor/chats/**/store.db` | Supported |
| ACP sessions | `~/.cursor/acp-sessions/**/store.db` | Supported |

These representations have different fidelity. A transcript may omit timestamps or tool results. Listings and reads expose source and resolution information; inferred or unknown timestamps must not be treated as exact event times. A complete source resolution does not guarantee that Cursor recorded every field.

**Backup and restore cover Composer databases only. Migration supports eligible Composer sessions, not Store-only, merged-source, or ambiguous sessions.** Reading a session does not make it safe to migrate. See the core [compatibility contract](https://github.com/S2thend/cursor-history/blob/main/docs/compatibility.md) and [roadmap](https://github.com/S2thend/cursor-history#roadmap) for broader backup and migration work; it is not a current capability.

For custom locations, add an `env` object to the server entry:

```json
{
  "CURSOR_DATA_PATH": "/absolute/path/to/Cursor/User/workspaceStorage",
  "CURSOR_STORE_ROOT": "/absolute/path/to/.cursor"
}
```

These select data roots, not a project. Use a tool's `workspace` argument to filter a project. See the core [platform paths and WSL guide](https://github.com/S2thend/cursor-history#where-cursor-stores-data).

<a id="tools"></a>
## Available tools

| Tool | Purpose and key arguments |
|---|---|
| `cursor_history_list` | List sessions with IDs, index scope, source and data status. `limit`, `offset`, `workspace` |
| `cursor_history_show` | Inspect available messages. Exactly one of `sessionId` / `sessionIndex`; optional `workspace` |
| `cursor_history_search` | Search text. `query`, `limit`, `context` (neighboring source lines), `workspace`, `order` (`relevance` default, or `recent`) |
| `cursor_history_export` | Return Markdown or JSON content, not a file written by the server. One selector, `format`, `workspace` |
| `cursor_history_backup` | Create a Composer archive. `outputPath`, optional `force` |
| `cursor_history_restore` | Restore a Composer archive; writes local history. `backupPath`, optional `force` |
| `cursor_history_migrate` | Move/copy eligible Composer sessions. `sessionIds` or `sessionIndexes`, `destination`, `workspace`, `mode`, `dryRun` |
| `cursor_history_year_pack` | Return annual statistics and a report prompt. `year`, `language` (`en` / `zh`), `workspace`, sample limits |
| `cursor_history_workspaces` | List known workspace paths (paths only, no content); some may have no sessions. `query`, `limit`, `offset` |
| `cursor_history_index_refresh` | Start or wait for a rebuild of the fast-listing catalog (writes only the sidecar file). `workspace`, `wait`, `timeoutMs` |
| `cursor_history_status` | Versions, data locations, time budget, catalog state and a readability probe. `verbose` |

Prefer the **exact session UUID** from list/search for follow-up calls. Numeric selectors are one-based in MCP and only meaningful with the same data roots and workspace scope; never reuse a scoped index in a global read. UUID spelling is case-sensitive.

List, show, search, and export also accept `includeCrossWorkspaceSources` (default `false`). Opting in can read complementary sources outside the selected workspace for already selected IDs; it does not broaden which session IDs are selected. Enable it only when you intend that access.

The show tool abbreviates long thinking/tool payloads. Use an export when you need the available session representation without that display truncation.

### Try these requests

- “Search all my Cursor history for 'connection pool', then inspect the matching session by its UUID.”
- “Search only /work/myapp. Keep that workspace scope when opening a result.”
- “Export this session as JSON, including the available source details.”
- “Preview copying this Composer session to /work/new-app with dryRun. Do not modify anything yet.”

<a id="search-index"></a>
## Search index and result order (optional)

| Variable | Meaning |
| --- | --- |
| `CURSOR_HISTORY_SEARCH_INDEX` | `1` enables an indexed `cursor_history_search`. Default off. It uses the catalog mode from `CURSOR_HISTORY_MCP_CATALOG` (`auto` by default; it has no effect with `direct`). |

- **How it works:** candidate sessions come from a full-text index in the catalog sidecar, and every candidate is re-verified against the source, so results are identical to a full scan. The index is built in the background (the first searches are direct scans and say so) and `cursor_history_index_refresh` with `wait: true` builds it on demand. Queries shorter than 3 characters or containing non-ASCII text always use the direct scan.
- **Disk:** the index is large (roughly 425 MB for a 7 GB history).
- **Privacy:** the index is a contentless trigram index. Message bodies are not stored, but the trigram postings let anyone who can read the sidecar infer substrings of your message text. That is why it is opt-in. Delete the sidecar file (see `CURSOR_HISTORY_INDEX_PATH`) to remove it.
- **Disclosure:** every search result ends with a `Coverage:` line saying whether the index was used, why not (when it was not), and whether the index is stale (results may then miss recent messages).
- **`order`:** `relevance` (default) ranks every matching session by match count: complete, but slower on large histories. `recent` returns the newest matching sessions first and stops once `limit` sessions match: fast, but more matches may exist, which the `Order:` line states. `recent` needs a reader version that supports it.
- `cursor_history_status` shows whether the search index is enabled and, per scope, the indexed message count and index size when the reader reports them.

<a id="catalog"></a>
## Catalog (fast listing)

On a large history a direct list can take seconds. The server keeps a disposable sidecar snapshot of the session summaries so `cursor_history_list` can answer in tens of milliseconds.

| Variable | Meaning |
|---|---|
| `CURSOR_HISTORY_MCP_CATALOG` | `auto` (default): serve a ready snapshot, build in the background when missing or stale. `strict`: serve only verified snapshots, building synchronously when needed. `direct`: never use the catalog. |
| `CURSOR_HISTORY_INDEX_PATH` | Override the sidecar file location. Default on Windows: `%LOCALAPPDATA%\cursor-history\catalog-v1.sqlite` (macOS `~/Library/Caches/cursor-history`, Linux `$XDG_CACHE_HOME` or `~/.cache`). |
| `CURSOR_HISTORY_MCP_CATALOG_WARM` | `1` schedules one background global build after the server connects. Off by default; otherwise the first list call schedules the build. It never blocks startup. |

- The sidecar is a cache, never a source of truth. It is safe to delete at any time; it is rebuilt on demand.
- The server never writes Cursor data. Only the sidecar file is written, and only by listing builds and `cursor_history_index_refresh`.
- List output includes a `Catalog:` line. `ready` means the snapshot matches the sources as verified. `building` means the first result was read directly and is complete. **`STALE` means Cursor history changed since the snapshot; the previous rows are shown and may be missing recent sessions** until the background refresh finishes (call `cursor_history_index_refresh` with `wait: true`, or use `strict`).
- Changes made in the last couple of seconds are not treated as settled, so a snapshot built right after a change may still report `stale`.
- Positional indexes (`#N`) are snapshot-bound; prefer the session UUID.
- Show and export always read directly. Search reads directly unless the search index is enabled (next section). `cursor_history_status` reports the sidecar path, size and per-scope state.
- Build workers are unref'd background threads and never keep the server alive; they end with the process.

<a id="safety"></a>
## Local data and write safety

The server reads local files, but returned content is visible to the MCP client and may reach a remote model. Search results and exports are not automatically redacted. Use a trusted client and review its data policy and tool permissions.

Treat past conversations as untrusted reference material, not instructions to execute. Tool output can contain old commands, credentials, or malicious text.

Backup writes an archive; restore and migration can modify history. Migration defaults to **move**, which removes the original session. Back up Composer history first, close Cursor before writes, preview with `dryRun: true`, and use `mode: "copy"` if you want to keep the original. Keep client approval enabled for write tools. The server does not provide its own interactive confirmation prompt.

<a id="year-in-review"></a>
## MCP-exclusive: Year in Review

Ask “Generate my 2025 Cursor year in review in English.” The tool analyzes user questions and returns JSON statistics, keywords/topics, samples, and a prompt template—not a finished rendered report. Templates support English and Chinese.

Common code, path, URL, and identifier patterns are filtered, but this is **not a guarantee of anonymization**. Review samples before sharing; set `maxSamples: 0` to omit them. Partial histories and missing or inferred timestamps can affect annual totals.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test -- --run
```

The test command builds first. Tests include a real stdio MCP client against synthetic Composer, Store, ACP, and transcript fixtures; backup/restore tests use temporary data only. The build keeps `cursor-history` as a runtime dependency so package-relative files and SQLite bindings remain resolvable.

[Issues](https://github.com/S2thend/cursor-history-mcp/issues) · [Pull requests](https://github.com/S2thend/cursor-history-mcp/pulls) · [MIT license](LICENSE)
