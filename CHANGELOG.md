# Changelog

## Unreleased

### Breaking changes for MCP callers

- **`cursor_history_migrate` is a preview by default.** `dryRun` now defaults to `true`; a real migration needs `dryRun: false`. With `mode: "move"` (the default) it also needs `confirm: true`, otherwise the call is refused with `[INVALID_ARGUMENTS]` (a move deletes the originals). Previews print `PREVIEW ONLY. Nothing was changed.`
- **`cursor_history_restore` is a dry run by default.** New `dryRun` option (default `true`) validates the archive and reports what would be restored without writing. A real restore needs `dryRun: false`; overwriting existing data still also needs `force: true`.
- Errors from every tool, including backup, restore, migrate and year_pack, now arrive as `[CODE] message` plus a remedy (for example `[INVALID_ARGUMENTS] ...`) instead of bare text.

### Added

- Claude-compatible tool schemas: `cursor_history_show`, `cursor_history_export` and `cursor_history_migrate` publish plain `type: "object"` root schemas (no root `oneOf`), which Claude Code previously dropped silently. Exactly-one-of selector rules are enforced in the handlers with actionable messages; Zod validation errors are readable text.
- `cursor_history_list` renders from message-free summaries (`listSessionSummaries`), shows ambiguous sessions with an explicit note, surfaces library diagnostics and prints pagination metadata; reader bumped to `cursor-history@0.19.0`.
- Bounded reads: `cursor_history_show` pages with `messageOffset`/`maxMessages`/`maxChars`; `cursor_history_search` bounds output with `maxChars` and reports coverage; `cursor_history_export` chunks with `chunkOffset`/`maxChars`. Small exports are unchanged.
- Per-call time budget for read tools (`CURSOR_HISTORY_MCP_TIME_BUDGET_MS`, default 120000, `0` disables; per-tool `..._<TOOL>` override) combined with client cancellation. Over-budget results are returned with a warning rather than discarded.
- Typed errors with a `[CODE] message` line plus a remedy, including `INVALID_ARGUMENTS`, `TIME_BUDGET_EXCEEDED`, `CANCELLED`, `SOURCE_LIMIT_EXCEEDED`, `WORKSPACE_AMBIGUOUS`, `SESSION_AMBIGUOUS`, `SESSION_SCOPE_MISMATCH` and `INTERNAL_ERROR`.
- New tools `cursor_history_workspaces` (paths-only inventory, paginated) and `cursor_history_status` (versions, data roots, time budget, readability probe).
- list/search render the reader's workspace scope outcome (empty versus not found with suggestions); search skips divergent-replica sessions and discloses them instead of failing.
- Content-free audit log (`audit.log`) for backup, restore and migrate; opt out with `CURSOR_HISTORY_MCP_AUDIT=0`.
- README: "Claude Code in VSCodium on Windows" setup and "Write operations are previews by default".
- Catalog-backed listing: `cursor_history_list` uses the reader's sidecar catalog by default (`CURSOR_HISTORY_MCP_CATALOG=auto`; `strict` or `direct` also accepted).
  - Each listing reports one of four catalog states:
    - `ready`: a verified-unchanged snapshot, which is complete.
    - `building`: a direct read, which is also complete.
    - `STALE`: the previous snapshot, explicitly *not* guaranteed complete, while a refresh runs.
    - `unavailable`.
  - There is no build at startup; `CURSOR_HISTORY_MCP_CATALOG_WARM=1` opts into one background refresh.
  - New tool `cursor_history_index_refresh`; `cursor_history_status` reports the sidecar and its scopes.
- Opt-in indexed search (`CURSOR_HISTORY_SEARCH_INDEX=1`). Every hit is verified against the source, so results are identical to a full scan.
  - New `order` parameter: `relevance` (the default, a complete match-count ranking) or `recent` (the newest matching sessions; fast; stops early).
  - Coverage lines state exactly what was searched and why the index was or wasn't used.

### Changed

- `docs/sdk-compatibility.md` updated for eleven tools and root schemas without `oneOf`.
- Reader bumped to the unreleased `cursor-history` with the catalog, search index, workspace inventory and backup fixes. Publish the reader first, then pin its version here.

### Fixed

- Backup/restore through MCP no longer reads the real default Cursor directory when `CURSOR_DATA_PATH` is set (a reader fix). The test suite now sandboxes `APPDATA`, `LOCALAPPDATA`, `USERPROFILE` and `HOME` for every test and spawned server, so no test can reach real data.

### Performance (real 7.26 GB Cursor history, 507 sessions, over stdio)

| Scenario | 0.3.1 (reader 0.18) | Unreleased |
| --- | --- | --- |
| Startup + `tools/list` | 8 of 11 tools usable; show/export/migrate hidden from Claude | 220 ms, all 11 tools |
| `cursor_history_list` (limit 20) | 15+ min | 2.8 s cold (complete) / p95 29 ms warm |
| Workspace-scoped list | 20 min (measured 1,181 s) | 0.7 s cold / 24 ms warm |
| Unknown or known-empty workspace | 20 min | 54 ms / 22 ms, with suggestions or an "empty" notice |
| `show` / `export` by UUID | unavailable in Claude | 2.6 s / 3.7 s |
| `search` (limit 10, indexed) | 30-83 s (when it didn't fail on ambiguity) | `recent` 3-6 s; `relevance` 4-29 s |

## 0.3.1

- Refresh development dependencies to patched releases: Vitest 4.1.11, tsup 8.5.1, Node 22 type definitions 22.20.1 and compatible transitive security updates. Existing application and test code is unchanged by this toolchain refresh. See [Development toolchain](docs/development.md) for setup and override maintenance.
- Override only tsup's esbuild dependency to 0.28.1 to address GHSA-g7r4-m6w7-qqqr, since tsup 8.5.1 still requests the affected 0.27.x line. Remove the override once tsup's declared range includes a patched release. Build, watch rebuild and stdio interoperability are regression-tested; runtime dependency pins and Node.js support are unchanged.
- Upgrade the MCP SDK from 1.0.0 to 1.30.0 and Zod from 3.24.1 to 3.25.76; keep the history reader pinned to 0.18.0.
- Add stdio interoperability coverage using the v2.0.0 client in default and automatic protocol-negotiation modes, alongside the v1 client. The v2 client is a development-only test dependency, not the server runtime.
- Document that SDK major versions do not need to match: v2 clients can use the legacy protocol, while clients restricted to the 2026-07-28 protocol require a v2 server migration.

## 0.3.0

- Upgrade the pinned `cursor-history` reader from 0.9.1 to 0.18.0, adding its Composer, Agent transcript, Store and ACP discovery/read support to MCP.
- Add exact native session UUID selectors and explicit workspace scope to reads and exports; retain one-based MCP indices with scoped semantics.
- Fix migration index conversion: the 0.18 migration API takes one-based indices, unlike the zero-based read API. Add UUID migration, source workspace and dry-run options.
- Preserve typed integrity/capability failures, source resolution state and timestamp provenance in tool responses. Keep complementary cross-workspace sources opt-in.
- Return JSON exports without double encoding; expose search match coordinates and neighboring lines.
- Reuse the hydrated sessions returned by the reader for year-pack generation instead of rescanning the catalog for every session. Resolve sparse rows by UUID within their selected workspace, never by an unscoped positional index.
- Honor `maxSamples: 0` in year-pack output; the sample selector previously returned its first eligible question even when samples were disabled.
- Keep `cursor-history` external in the build so package-relative files and native SQLite drivers resolve correctly. Report the MCP package version at initialization and align Node.js engine requirements with the reader.
- Add adapter regression tests and real stdio tests using synthetic Composer, Store, ACP and transcript databases. Tests build the server first.
- Refresh English, Chinese, French and Spanish READMEs, add the MCP companion banner, and link the CLI/library project.
- Publish npm packages through GitHub OIDC Trusted Publishing with Node.js 24 and npm >=11.5.1, alongside the existing MCP Registry OIDC flow.

Backup/restore remain Composer-only. Store-only, merged-source and ambiguous session migration remain unsupported; broader coverage is tracked in the core project's roadmap.

The MCP package version is 0.3.0; its reader remains pinned to the independently published `cursor-history@0.18.0`. See [Publishing](docs/publishing.md) for the OIDC setup and release checklist.
