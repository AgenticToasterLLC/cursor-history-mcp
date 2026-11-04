# Publishing cursor-history-mcp

The workflow `.github/workflows/publish.yml` runs when a GitHub Release is
**published**, not when a commit or tag is pushed. It builds and tests this
package, publishes it to npm, then publishes its metadata to the MCP Registry.

Both registries use GitHub OIDC, but they have separate authentication steps:

- npm uses Trusted Publishing with the workflow's `id-token: write` permission.
- The MCP Registry uses `mcp-publisher login github-oidc`.

## One-time npm configuration

In the **cursor-history-mcp** package settings on npmjs.com, add a GitHub Actions
Trusted Publisher with these exact values:

| Field | Value |
|---|---|
| Organization or user | `S2thend` |
| Repository | `cursor-history-mcp` |
| Workflow filename | `publish.yml` (not its full path) |
| Environment name | Leave empty; the workflow does not declare an environment |
| Allowed actions | Enable direct publishing with `npm publish` |

Changing this YAML does not create the npm-side trust relationship. Configure it
before publishing a release. Allowing only `npm stage publish` does not authorize
the direct publish command used by this workflow.

The job uses a GitHub-hosted runner, Node.js 24 and npm >=11.5.1 within major 11.
It does not reference `NPM_TOKEN` or set `NODE_AUTH_TOKEN`. npm obtains short-lived
credentials from GitHub OIDC and automatically generates provenance for the
public package/repository. No npm login step is required.

After a successful OIDC release, review and revoke obsolete npm publishing
tokens, and remove unused secrets if no other workflows need them. Do not revoke
credentials shared by unrelated packages without checking their users.

See the [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/)
and the [MCP Registry GitHub Actions guide](https://modelcontextprotocol.io/registry/github-actions).

## Release checklist

1. Choose an unused **MCP package** version. Keep `package.json`,
   `package-lock.json`, and both version fields in `server.json` synchronized.
   The release tag must be `v` followed by that same version; the workflow does
   not bump the npm package version automatically.
2. Update the changelog and release-boundary text in all four READMEs.
3. Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test -- --run`, and
   `npm pack --dry-run`. The test command builds first.
4. Commit and push the release changes and version tag, then publish the GitHub
   Release for that tag. Watch both registry publication steps in Actions.
5. Verify the published package's version and `cursor-history` dependency with
   `npm view cursor-history-mcp@<version> version dependencies.cursor-history`.

The core `cursor-history` package is released independently. Documentation-only
changes there do not require publishing a new core version for an MCP release;
the MCP dependency already points to the published `cursor-history@0.18.0`.

If npm publication succeeds but MCP Registry publication fails, do not blindly
rerun the entire workflow: it would try to republish the existing npm version.
Repair the registry-specific failure and resume that publication separately.

Local checks cannot prove npm-side OIDC authorization. That requires the exact
trusted-publisher binding above and a real GitHub-hosted release run.

## Prerelease tarballs (fork betas)

A prerelease such as `0.4.0-beta.0` is distributed as GitHub release assets
instead of npm packages, so it can be tested before an upstream pull request.
The publish job skips GitHub releases marked **pre-release**.

1. Reader: set the version (`npm version <v> --no-git-tag-version`, then
   `node scripts/generate-package-version.mjs`), run its gate, and `npm pack`.
   Upload that exact `cursor-history-<v>.tgz` to a pre-release on the reader
   repository tagged `v<v>`. Note: pushing a `v*` tag starts the reader's npm
   workflow, which runs its checks and then fails at `npm publish` without
   credentials; nothing is published.
2. MCP: point `dependencies.cursor-history` at the asset URL
   (`https://github.com/<owner>/cursor-history/releases/download/v<v>/cursor-history-<v>.tgz`).
   Install the local tarball, then set the lockfile entry's `resolved` field to
   that URL. Keep the `integrity` hash: it is the hash of the exact file you
   upload, and `npm ci` fails if the uploaded file differs.
3. Set the MCP version in `package.json`, `package-lock.json` and `server.json`,
   run the gate, `npm pack`, and upload `cursor-history-mcp-<v>.tgz` to a
   pre-release tagged `v<v>`. Upload the reader tarball first: installs of the
   MCP tarball download it.
4. Before the upstream pull request, replace the URL dependency with the
   published reader version.
