# @taujs/solid

## 0.6.0

### Minor Changes

- [#77](https://github.com/aoede3/taujs/pull/77) [`511b38a`](https://github.com/aoede3/taujs/commit/511b38a19ceff25e222d63a39569783ae0525061) Thanks [@aoede3](https://github.com/aoede3)! - feat: Vite 8 baseline - synchronised upgrade to Vite 8.2.1

  **BREAKING CHANGES** (released as `minor` under the repository's pre-1.0 convention - these
  packages are pre-1 and a `major` bump would declare τjs stable 1.0, which this work does not
  decide).

  **You must upgrade Vite to `^8.2.1` and Node to `^20.19.0 || >=22.12.0`.**

  The four Vite-bearing packages move their `vite` dependency and peer baseline to `^8.2.1`,
  and the workspace Node engine rises to `^20.19.0 || >=22.12.0` to match Vite's own
  requirement. Renderer plugin peer FLOORS rise with it, because every previous floor admitted
  a plugin release that cannot work with Vite 8: `@vitejs/plugin-react ^5.2.0`,
  `@vitejs/plugin-vue ^6.0.3`, `vite-plugin-solid ^2.11.11`. The scaffolder emits the new pins.

  BREAKING - the `manualChunks` OBJECT form is removed. Vite 8/Rolldown does not support it, so a
  build declaring it would not chunk as written. taujs rejects it at the
  configuration boundary with a migration error rather than letting that happen, and
  deliberately does NOT translate it (exact Rollup object semantics involve module resolution
  and dependency capture, so an approximation could produce different bundles).

  ```ts
  // before - no longer supported
  export default defineConfig({
    vite: { build: { rollupOptions: { output: { manualChunks: { vendor: ['react', 'react-dom'] } } } } },
  });

  // after - canonical Vite 8 chunking
  export default defineConfig({
    vite: { build: { rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'vendor-react', test: /node_modules/ }] } } } } },
  });

  // also still accepted, deprecated: the FUNCTION form
  export default defineConfig({
    vite: { build: { rollupOptions: { output: { manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : null) } } } },
  });
  ```

  Declaring both the deprecated and canonical paths now fails with an error naming both, rather
  than letting the bundler ignore one of them.

  fix: the React compiler's plugin scope is intersected with transformable JS/TS extensions.
  A tsconfig claim such as `src/client/**/*` legitimately covers `.css` and `.html` for
  type-checking, and Vite 8's transform parses whatever the plugin claims as JavaScript - which
  broke development SSR for any application importing CSS. Ownership claims are unchanged; only
  the plugin scope is narrowed.

## 0.5.0

### Minor Changes

- [#59](https://github.com/aoede3/taujs/pull/59) [`7bcf176`](https://github.com/aoede3/taujs/commit/7bcf176b9e88bc71f4ce6496a995ef235be28632) Thanks [@aoede3](https://github.com/aoede3)! - BREAKING: the renderer contribution protocol becomes lazy-only v2. `@taujs/server` and the
  three renderers (`@taujs/react`, `@taujs/vue`, `@taujs/solid`) are one coordinated train -
  upgrade the paired packages together. No application source changes: `reactRenderer()`,
  `vueRenderer()` and `solidRenderer()` keep their exact synchronous signatures, and the
  render-module contract does not move.

  What changes underneath:

  - the renderer-contribution brand is the protocol discriminator; v2 is the lazy protocol
    and the only one the server accepts. A v1 (eager) contribution - an older renderer
    against this server - fails at boot and build with an error naming the renderer package
    and the required upgrade
  - renderer factories no longer import their compiler machinery at declaration time. The
    compiler contribution is loaded through an async loader invoked only by build and
    development; a production process never resolves the compiler toolchain
    (`@vitejs/plugin-react`, `@vitejs/plugin-vue`, `vite-plugin-solid`, and Solid's Babel
    stack all leave the production module graph)
  - the contribution type is a discriminated union on `managedCompilation`: a managed
    renderer (React/Solid) carries `loadCompiler`, a non-managed renderer (Vue) carries
    `loadEnvironmentPlugins` - exactly one, enforced structurally and at runtime
  - Vue's plugin pack stays FRESH per Vite environment exactly as before; only the module
    import behind the loader is cached
  - no `@taujs/server` peer metadata is declared by the renderers: measurement showed npm's
    handling of an optional-but-mismatched peer is topology-dependent (warning on a two-step
    add, but a hard `ETARGET` failure on a fresh install while the range is unsatisfiable
    from the registry), so the pairing is enforced by the runtime protocol check alone -
    which is the authoritative failure in every topology

  Declaring a renderer without its compiler peers installed now succeeds (identity is
  synchronous and peer-free); the compiler peer is demanded, by name, only when build or
  development actually loads the compiler.

## 0.4.0

### Minor Changes

- [#43](https://github.com/aoede3/taujs/pull/43) [`25a1dfe`](https://github.com/aoede3/taujs/commit/25a1dfe5305c61192f9342033aa03e91da05fb79) Thanks [@aoede3](https://github.com/aoede3)! - RFC 0007 - governed deferred route data.

  A `render: 'streaming'` route can now declare response-owned work that may complete after
  rendering begins, beside the critical `attr.data` snapshot:

  ```ts
  {
    path: '/products/:id',
    attr: {
      render: 'streaming',
      meta: {},
      data: serviceData('catalogue', 'product', ({ id }) => ({ id })),
      deferred: {
        reviews: serviceData('reviews', 'forProduct', ({ id }) => ({ id })),
      },
    },
  }
  ```

  The host starts each named loader exactly once per request, outside the component tree, after
  route policy has accepted the request. The selected renderer projects the named promise onto its
  own Suspense/resource primitive, so late boundary HTML arrives through the framework's own
  streaming and patch mechanism - τjs owns no patch protocol, exposes no browser data runtime and
  issues no client refetch. Hydration is seeded from the existing end-of-stream write site.

  **`@taujs/server`**

  - `attr.deferred` on the streaming arm only, with boot hard errors for an `ssr` route, a
    non-plain-object record, a non-function entry and a key failing `^[A-Za-z][A-Za-z0-9_]*$`.
  - `DeferredDataOf` and `DeferredDataAttributes` exported from `@taujs/server/config`, so a
    component-facing accessor is typeable from `typeof route` with no re-declared payload shape.
  - A settled entry is a stable snapshot: one serialisation attempt at settlement, whose retained
    bytes are what the renderer, the trace and the hydration seed all describe. A value that cannot
    cross that boundary is detail-free `failed` everywhere, with one payload-free operator warning.
  - The request graph gains an optional per-route `deferred` array and its `usedBy` contribution;
    traces gain a per-key `deferredData` outcome. Both are additive within schema v1, and a late
    outcome reaches the on-disk trace artefact. No new MCP tool.

  **`@taujs/react`, `@taujs/vue`, `@taujs/solid`**

  - React and Vue: `useDeferredData`, `useDeferredDataResult`, `createDeferredAccessor`,
    `DeferredDataError`, `DeferredResult`.
  - Solid: `useDeferredData`, `createDeferredAccessor`, `DeferredDataError`, `DeferredAccessor` -
    its engine has real server-side error boundaries, so the throwing read already completes the
    response and no result accessor is needed.
  - Each package gains one response-level `streamOptions.deferredTimeoutMs` deadline: positive
    finite only, validated at renderer construction, defaulting to 15000ms.

  **Authoring notes**

  - Vue streams in order, so in an in-order renderer place deferred boundaries AFTER the independent
    content that should stream immediately - a boundary awaiting a deferred value stalls every byte
    behind it. React streams out of order and is unaffected.
  - An unconsumed entry whose loader rejects after the response terminal reads as `aborted`, not
    `failed`.

  Routes that declare no `deferred` are unchanged, byte for byte.

## 0.3.0

### Minor Changes

- [#31](https://github.com/aoede3/taujs/pull/31) [`d2abc7d`](https://github.com/aoede3/taujs/commit/d2abc7db344facfb19e7c89c9fe8ac52189a97ff) Thanks [@aoede3](https://github.com/aoede3)! - Add client hydration observability options to `hydrateApp`

  `hydrateApp` now accepts `logger`, `enableDebug`, `onStart` and `onSuccess` alongside the existing
  `onHydrationError`, bringing `@taujs/solid` to the same client-hydration lifecycle contract as
  `@taujs/react` and `@taujs/vue`:

  - `onStart` observes the start of hydration (hydrate path only); `onSuccess` observes successful
    root establishment on both the hydrate and CSR-fallback paths; `onHydrationError` observes a
    failed root establishment. Exactly one of `onSuccess` | `onHydrationError` settles per call, each
    at most once, and every observer is isolated - a callback throw is logged and never alters
    settlement or tears down the root.
  - `logger` receives the lifecycle; `enableDebug` gates verbose start/success logs (warnings and
    errors are never gated). With no logger supplied, warnings and errors fall back to the browser
    console. The route-data snapshot is never logged.
  - The internal `hydration:*` beacons remain hydration-only and always precede the matching user
    callback.

  `dataKey` is deliberately not added - `window.__INITIAL_DATA__` is the single snapshot authority.
  React-specific (`identifierPrefix`) and Vue-specific (`setupApp`) options are not inherited by
  analogy either; `renderId` remains Solid's framework-native identity option.

## 0.2.0

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
