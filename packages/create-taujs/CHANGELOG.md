# @taujs/cli

## 0.5.0

### Minor Changes

- [#51](https://github.com/aoede3/taujs/pull/51) [`08e1522`](https://github.com/aoede3/taujs/commit/08e152283b5d3929bf3e794b80daf2f9443af42b) Thanks [@aoede3](https://github.com/aoede3)! - Generated projects now demonstrate the derived type chain from `taujs.config.ts` through the renderer to the store. A type-only `src/client/app-types.ts` exports `AppRouteContext = RouteContext<typeof config>` and `AppData = RouteData<typeof config>`; the generated config declares registry-typed `serviceData()` edges instead of a hand-built descriptor; `createRenderer` receives `<AppData, AppRouteContext>` in all three frameworks; and every hand-written payload type is replaced by the derived `AppData`. The lifecycle gate typechecks a generated project end to end against packed tarballs.

## 0.4.0

### Minor Changes

- [#28](https://github.com/aoede3/taujs/pull/28) [`2f92f07`](https://github.com/aoede3/taujs/commit/2f92f073bf6626905648b9cb9f58a2d928dba2db) Thanks [@aoede3](https://github.com/aoede3)! - Solid is now a full τjs renderer

  `@taujs/solid` ships `createRenderer`, `createSSRStore`, `useSSRStore` and `hydrateApp`, and
  `@taujs/solid/renderer` exposes `solidRenderer({ project })`. Declare a Solid app the same way as
  React and Vue:

  ```ts
  import { solidRenderer } from '@taujs/solid/renderer';

  renderer: solidRenderer({ project: './tsconfig.solid.json' }),
  ```

  `create-taujs` gains `--framework solid`, and the CLI is now scriptable:

  ```sh
  create-taujs my-app --framework solid --package-manager pnpm --no-install
  ```

  `--package-manager npm|pnpm|yarn` and the mutually exclusive `--install` / `--no-install` suppress
  only their own prompts; omit them and the prompts behave exactly as before. With all four supplied
  the CLI never needs a TTY, so CI, scripts and agents can drive it. There is deliberately no
  `--yes`: its defaults, and whether it would install from the network, would be ambiguous.

  What is worth knowing before you write Solid components:

  - **Route data comes from the store, not a resource.** `useSSRStore<T>().data()` is a Solid
    accessor. The server commits route data before rendering, so it reads synchronously; the client
    seeds it from `window.__INITIAL_DATA__`. The documented trade is that τjs route data is not
    streamed through Solid's `$df` patch channel - it travels in the single `__INITIAL_DATA__`
    authority instead. Application-owned `createResource` values still stream normally.
  - **The renderer owns the compiler.** `solidRenderer({ project })` supplies `vite-plugin-solid`
    internally with `ssr: true` forced; do not add it to `plugins` yourself. Point `project` at a
    tsconfig that claims only your client TSX. Raw `pluginSolid()` from `@taujs/solid/plugin` remains
    the portable escape hatch for plain Vite, with the full option surface.
  - **`renderId` must match between entries.** Export one constant and import it into both
    entry-server and entry-client.
  - **Serialised errors are redacted.** Every `Error` that Solid serialises into the page becomes
    exactly `{ name: 'Error', message: '[redacted]' }` - message, stack, cause and custom properties
    are stripped in development and production alike, because they otherwise reach the browser
    verbatim. This applies to ordinary `Error` values in your data too, so send a safe DTO such as
    `{ code: 'NOT_FOUND', publicMessage: 'Item unavailable' }` rather than an `Error` when you want
    detail on the client. Server-side detail belongs in server logs.
  - **Solid never calls `onRenderError`.** A rejected resource after the shell has flushed is
    indistinguishable, through Solid's supported APIs, from an ordinary serialised `Error` value, so
    τjs does not guess: the response completes, the rejection is redacted, and your client
    `ErrorBoundary` handles it at hydration. Report resource failures where you create the resource.
    The callback stays in the shared contract because React genuinely supplies it.
  - **`hydrateApp` is deliberately lean** - `app`, `renderId`, `rootElementId`, `onHydrationError`.
    A hydration failure reports and stops rather than silently remounting, so a server/client
    divergence stays visible instead of hiding behind a page that looks fine.

  Also fixed in `create-taujs`, for React and Vue as well as Solid - three defects that meant no
  generated project of any framework fully worked:

  - `src/server/types.d.ts` now imports `@taujs/server/config` before augmenting it. Without the
    import the block was an ambient module declaration that replaced the real module, so
    `defineConfig`/`defineService`/`defineServiceRegistry` failed to resolve and route `data`
    callbacks fell to implicit `any`. Generated projects did not typecheck.
  - `esbuild` is now a declared devDependency; `build:server` invokes its binary and failed with
    "command not found".
  - The Vite builds pin `NODE_ENV=production`. Without it the bundle followed the caller's
    `NODE_ENV` - and CI commonly sets `NODE_ENV=test` - which baked React's development JSX runtime
    into the production SSR bundle and crashed the production server.

## 0.3.2

### Patch Changes

- [#25](https://github.com/aoede3/taujs/pull/25) [`f825c9a`](https://github.com/aoede3/taujs/commit/f825c9aaaa124332493794dde40072d80d74b9c9) Thanks [@aoede3](https://github.com/aoede3)! - Scaffold a commented `vite` / `alias` stub in the generated `taujs.config.ts`, pointing at the declared Vite customisation surface (RFC 0005, VS7). This is the discoverability moment for the new fields - no `vite.config.ts` is ever scaffolded, since τjs never reads one.

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
