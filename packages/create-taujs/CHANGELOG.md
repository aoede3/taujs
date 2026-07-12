# @taujs/cli

## 0.3.1

### Patch Changes

- [#17](https://github.com/aoede3/taujs/pull/17) [`63446d7`](https://github.com/aoede3/taujs/commit/63446d75e6553c10a8b6751e0cc17decda0f3b64) Thanks [@aoede3](https://github.com/aoede3)! - Remove `@changesets/cli` from runtime dependencies. It was never imported, so every `npx @taujs/create-taujs` was downloading the entire changesets toolchain for nothing. Releases continue to use the copy provided by the workspace root.

## 0.3.0

### Minor Changes

- [#10](https://github.com/aoede3/taujs/pull/10) [`dafd344`](https://github.com/aoede3/taujs/commit/dafd3444fe50ea7e09347cb892b0333b7bae4c32) Thanks [@aoede3](https://github.com/aoede3)! - Add a Vue framework option to the scaffolder (V2-02). `create-taujs` now prompts
  "Framework: React / Vue" (React default) and accepts a non-interactive
  `--framework react|vue` flag. The Vue template scaffolds an app equivalent to the React
  one — same `/` (ssr) and `/streaming` (streaming) routes, same shared server half, same MCP
  wiring — using `@taujs/vue`: `App.vue` with a route switch, `HomePage.vue` (`useSSRData` +
  `v-if`) and `StreamingPage.vue` (`await useSSRDataAsync` under `<Suspense>`), `.ts` client
  entries, a `*.vue` type shim, `plugins: [pluginVue()]` in `taujs.config.ts`, and `vue-tsc`
  for client typechecking. React output is unchanged (byte-identical, golden-tested).

## 0.2.0

### Minor Changes

- [#6](https://github.com/aoede3/taujs/pull/6) [`a6d3c6c`](https://github.com/aoede3/taujs/commit/a6d3c6c9608d17c98481a76e6334ac93d5adfba2) Thanks [@aoede3](https://github.com/aoede3)! - P1-04: scaffolded projects wire the τjs MCP adapter — `.mcp.json` in the pinned package-manager-specific local-bin form (`pnpm exec taujs-mcp` / `npx --no-install taujs-mcp` / `yarn exec taujs-mcp`, never registry-latest), `@taujs/mcp` as a devDependency, and a short `CLAUDE.md` pointer telling agents to prefer the MCP tools over reading config by hand — the substance lives in the package so it improves with upgrades.

## 0.1.10

### Patch Changes

- [#4](https://github.com/aoede3/taujs/pull/4) [`8a8ea77`](https://github.com/aoede3/taujs/commit/8a8ea77c0f5e6c0746f82d929ad924f973ebe80e) Thanks [@aoede3](https://github.com/aoede3)! - Remove `@changesets/cli` from runtime dependencies. It was never imported, so every `npx @taujs/create-taujs` was downloading the entire changesets toolchain for nothing. Releases continue to use the copy provided by the workspace root.

v0.1.9 - 16/04/2026

feat: align to @taujs/server

v0.1.8 - 05/04/2026

feat: align to @taujs/server

v0.1.7 - 29/12/2025

feat: align to @taujs/server

v0.1.6 - 19/12/2025

feat: update entry-server output; config streaming meta

v0.1.5 - 18/12/2025

feat: update meta; css; output

v0.1.4 - 11/12/2025

chore: align with taujs/server 0.5.0

v0.1.3 - 11/12/2025

feat: Update clientRoot path

v0.1.2 - 10/12/2025

feat: update package.json
feat: update tags

v0.1.1 - 07/12/2025

Updating copy

v0.1.0 - 07/12/2025

Initial @taujs/create-taujs
