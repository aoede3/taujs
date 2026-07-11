# τjs &nbsp;[ taujs ]

> τjs is an orchestration layer built on Fastify, Vite, and React / Vue. Developer-first with declarative configuration for building modern web apps with per-route control over CSR, SSR, and Streaming SSR.

[![@taujs/server](https://img.shields.io/npm/v/@taujs/server?label=%40taujs%2Fserver)](https://www.npmjs.com/package/@taujs/server)
[![@taujs/react](https://img.shields.io/npm/v/@taujs/react?label=%40taujs%2Freact)](https://www.npmjs.com/package/@taujs/react)
[![@taujs/mcp](https://img.shields.io/npm/v/@taujs/mcp?label=%40taujs%2Fmcp)](https://www.npmjs.com/package/@taujs/mcp)
[![node](https://img.shields.io/badge/node-%E2%89%A520.11-brightgreen)](.nvmrc)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Website:** https://taujs.dev

## Packages

| Package                                        | Description                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@taujs/server`](packages/server)             | Fastify plugin & render orchestration - CSR / SSR / Streaming SSR for SPA, MPA, and build‑time micro‑frontends (MFE). React 19, Vite HMR + tsx in dev. |
| [`@taujs/react`](packages/react)               | React renderer: CSR, SSR, Streaming SSR. Standalone and runtime‑agnostic.                                                                              |
| [`@taujs/vue`](packages/vue)                   | Vue renderer: CSR, SSR, Streaming SSR. Standalone and runtime‑agnostic.                                                                                |
| [`@taujs/mcp`](packages/mcp)                   | MCP server for AI agents: reads the dev‑emitted request graph and live request traces (filesystem‑only stdio adapter). Wired by the scaffolder.        |
| [`@taujs/create-taujs`](packages/create-taujs) | Scaffolder for a new τjs application.                                                                                                                  |

Current versions are shown by the badges above.

Packages share a common render‑surface / streaming protocol.

## Scaffold an app

```bash
npx @taujs/create-taujs        # or: npm create @taujs/taujs
```

Or add a package to an existing project:

```bash
pnpm add @taujs/server @taujs/react   # npm install / yarn add also fine
```

## Repository layout

```
taujs/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .changeset/
├── fixtures/
│   └── playground/     # private fixture app (introspection e2e + demos)
└── packages/
    ├── server/         # @taujs/server
    ├── react/          # @taujs/react
    ├── vue/            # @taujs/vue
    ├── mcp/            # @taujs/mcp
    └── create-taujs/   # @taujs/create-taujs
```

## Development

Requires **Node ≥ 20.11** (the repo uses `22.17.0` - see [`.nvmrc`](.nvmrc)) and **pnpm** (pinned via `packageManager`; `corepack enable` will provide it).

```bash
pnpm install          # single root install for the whole workspace

pnpm build            # pnpm -r build          - build every package (tsup)
pnpm test             # pnpm -r test           - run every package's tests (vitest)
pnpm typecheck        # pnpm -r typecheck      - tsc across packages
pnpm check-format     # prettier --check .
pnpm format           # prettier --write .
pnpm check-exports    # pnpm -r check-exports  - attw packaging check
pnpm check            # build → typecheck → check-format → check-exports → test
```

Target a single package with a filter, e.g. `pnpm --filter @taujs/server test`.

## Releasing

Versioning and publishing run through [Changesets](https://github.com/changesets/changesets) (independent versioning, provenance‑enabled).

```bash
pnpm changeset        # describe the change + choose semver bumps
```

Merging the changeset to `main` opens a **Version Packages** PR; merging that PR publishes the bumped packages to npm via the release workflow.

## License

MIT © John Smith | Aoede. Attribution appreciated.
