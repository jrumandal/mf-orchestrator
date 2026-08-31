# mf-orchestrator

Cross-repo **CI/CD coordination** for the multi-repo micro-frontend architecture.

This is a **private, non-published** meta-repo. It does not ship any runtime code — it
holds the **repo registry** (`repos.json`) and a small set of **Node scripts** that
coordinate releases across the 11 sibling repositories in **topological order**
(dependencies first).

## Why

Each repo has its own independent CI/CD pipeline (see the per-repo `.github/workflows/`).
But a *release* must respect cross-repo dependencies:

- `shared` (frontend libs) must be published **before** the MFs (`cart`, `catalog`, `user`) and `shell` consume it.
- `server-shared` must be published **before** `gateway` and the services consume it.
- `shell` must be built **before** `mobile` wraps it.

The orchestrator encodes that ordering once (in `repos.json`) and drives it.

## Repo registry

`repos.json` is the single source of truth for the repo graph. Each entry:

| field | meaning |
| --- | --- |
| `name` | sibling repo directory / GitHub repo name |
| `type` | `library` \| `mf` \| `gateway` \| `service` \| `host` \| `mobile` |
| `publish` | `true` if the repo publishes an npm package (drives the publish fan-out) |
| `dependsOn` | names of repos that must be released **before** this one |
| `packages` | (optional) npm package names published by this repo |

### Current registry (11 repos)

| # | repo | type | publish | depends on |
| --- | --- | --- | --- | --- |
| 1 | `shared` | library | ✅ | — |
| 2 | `server-shared` | library | ✅ | — |
| 3 | `cart` | mf | — | `shared` |
| 4 | `catalog` | mf | — | `shared` |
| 5 | `user` | mf | — | `shared` |
| 6 | `gateway` | gateway | — | `server-shared` |
| 7 | `catalog-svc` | service | — | `server-shared` |
| 8 | `cart-svc` | service | — | `server-shared` |
| 9 | `user-svc` | service | — | `server-shared` |
| 10 | `shell` | host | — | `shared`, `cart`, `catalog`, `user` |
| 11 | `mobile` | mobile | — | `shell` |

## Release order (topological)

`scripts/topo-sort.mjs` runs **Kahn's algorithm** over `dependsOn` and emits the release
order (dependencies first). The current resolved order:

```
1. shared          [publish]
2. server-shared   [publish]
3. cart
4. catalog
5. user
6. gateway
7. catalog-svc
8. cart-svc
9. user-svc
10. shell
11. mobile
```

## Scripts

| script | purpose |
| --- | --- |
| `scripts/topo-sort.mjs` | Print the topological release order (`--json` for JSON). |
| `scripts/bump-version.mjs` | Bump a single repo's `package.json` version (`<repoDir> <major\|minor\|patch> [--package <name>] [--dry-run]`). |
| `scripts/orchestrate.mjs` | Bump **all** repos in topological order + emit the publish fan-out plan (`<bump> [--root <dir>] [--dry-run]`). |
| `scripts/trigger-release.mjs` | **Fan-out**: dispatch each repo's `ci.yml` (in topo order) via the GitHub REST API, waiting for each to finish before the next. Aborts if any repo's CI fails. |

## Usage

```bash
# See the release order
node scripts/topo-sort.mjs

# Dry-run a patch release across all repos (no writes)
node scripts/orchestrate.mjs patch --dry-run

# Actually bump all repos (run from the workspace root that contains the siblings)
node scripts/orchestrate.mjs patch

# Fan-out: trigger each repo's CI in order (needs a GITHUB_TOKEN with `workflow` scope)
GITHUB_TOKEN=*** OWNER=jrumandal node scripts/trigger-release.mjs patch
```

### `pnpm` scripts

| command | runs |
| --- | --- |
| `pnpm topo` | `node scripts/topo-sort.mjs` |
| `pnpm topo:json` | `node scripts/topo-sort.mjs --json` |
| `pnpm bump` | `node scripts/bump-version.mjs` |
| `pnpm orchestrate` | `node scripts/orchestrate.mjs` |
| `pnpm validate` | topo-sort + `orchestrate patch --dry-run` (CI check) |

## CI / CD

- **`ci.yml`** (on push/PR to `main`): validates the graph — runs the topological sort,
  a dry-run orchestrate, and `node --check` on every script. **No publish** (this repo
  publishes nothing).
- **`release.yml`** (manual `workflow_dispatch`): runs `trigger-release.mjs` to fan out a
  release across all repos in topological order. Requires a `GITHUB_TOKEN` with
  `workflow: write` (a repo-admin PAT is recommended, since the default `GITHUB_TOKEN`
  cannot dispatch workflows on other repos).

## Notes & gotchas

- **Tolerant of missing siblings.** `bump-version.mjs` skips a repo gracefully when its
  `package.json` is absent — so the dry-run works both locally (siblings present) and in
  CI (only the orchestrator is checked out).
- **GitHub Packages (free account).** `npm publish` to `npm.pkg.github.com` returns
  `403 permission_denied: create_package` on a free account with no org. The **ci** jobs
  of the publishable repos (`shared`, `server-shared`) still pass, but the **publish**
  job fails — so the overall workflow run concludes `failure`. The orchestrator's
  fan-out treats any non-`success` conclusion as fatal and aborts, so on a free account
  the fan-out will stop at the first publishable repo. On an account with GitHub
  Packages enabled, the fan-out completes end-to-end.
- **Not part of the pnpm workspace.** The orchestrator has no runtime dependencies and is
  intentionally **not** listed in the parent `pnpm-workspace.yaml` — it is a standalone
  coordination tool.
