# @taujs/server

## 0.29.1

### Patch Changes

- [#105](https://github.com/aoede3/taujs/pull/105) [`d635460`](https://github.com/aoede3/taujs/commit/d635460b1080f623193e3c09eef65fe77d97aba2) Thanks [@aoede3](https://github.com/aoede3)! - When no app matches the build filter, or an app's Vite build or pre-build cleanup fails inside the build loop, `taujsBuild` now sets `process.exitCode = 1` and returns instead of calling `process.exit(1)`. `process.exit` discards what a piped stderr has not yet flushed, so a long diagnostic under CI or `pnpm -r build` was cut at 64 KiB. A failure in the loop also names the apps not attempted, in build order. Failures before the loop body's try (entry resolution, `vite` callbacks, plugin composition) still reject as before.

  A failed build emits no new graph. An existing `dist/.taujs/graph.json` is left as it was wherever the build mode preserves `dist` (SSR and filtered builds); an unfiltered client build removes `dist` before building, as it always has, so no previous graph survives a failure there.

## 0.29.0

### Minor Changes

- [#103](https://github.com/aoede3/taujs/pull/103) [`f6c6c75`](https://github.com/aoede3/taujs/commit/f6c6c75c09c4fdc2a17e3943349695c864f52f80) Thanks [@aoede3](https://github.com/aoede3)! - The request graph now models a route's declared head-data edge (`route.head.data`) and counts it
  in `services[].methods[].usedBy`. Before, a method reached only through `attr.head.data` was
  emitted with `usedBy: []`, so the graph claimed no route used a method a route declared. Additive,
  schema v1.

## 0.28.1

### Patch Changes

- [#101](https://github.com/aoede3/taujs/pull/101) [`99f6bc6`](https://github.com/aoede3/taujs/commit/99f6bc60b1bc0ec45f35aed1b9ce83adc74d4c2c) Thanks [@aoede3](https://github.com/aoede3)! - The fallthrough (SPA shell) arm recorded `sent` when `reply.send()` returned, before the response
  lifecycle had said anything, so an abandoned fallthrough page was recorded as delivered.

  It now classifies at `finish` from the captured socket's state, as the SSR arm already does, and
  records `aborted` on a client disconnect. Introspection consumers (`taujs_get_recent_episodes`,
  `taujs_doctor`) no longer see an abandoned fallthrough as a 200.

## 0.28.0

### Minor Changes

- [#97](https://github.com/aoede3/taujs/pull/97) [`599516b`](https://github.com/aoede3/taujs/commit/599516b3aa2b708d0a4f2c97619b84b9a2aa3331) Thanks [@aoede3](https://github.com/aoede3)! - Browser asset hints come from the client manifest, and `ssr-manifest.json` is no longer generated

  Production SSR pages emitted `<link rel="modulepreload">` tags built from `ssr-manifest.json`, which taujs generated on the SSR build. That manifest describes the SSR bundle's own private chunk graph: a directory that is never served, with content hashes unrelated to the client build's. Every tag it produced pointed at a URL that does not exist under `dist/client`, so any app with a dynamic `import()` in its client tree served a console 404 and a wasted request on every server-rendered page. A second defect sat in the same path: Vite bakes the configured `base` into every ssr-manifest value inside its own plugin, while the client `manifest.json` carries no prefix, and taujs applied one prepending convention to both - so the emitted URL gained the base segment twice.

  Browser asset information now comes exclusively from the client build's `.vite/manifest.json`, the artefact taujs already reads for the entry script and stylesheets. `ssr-manifest.json` is no longer generated, read or retained.

  The preload policy is now stated rather than implied:

  - the client entry ships as the bootstrap `<script type="module">`, and is never additionally preloaded;
  - its recursive **static**-import closure is emitted as `<link rel="modulepreload">`;
  - `dynamicImports` are not followed. A dynamically imported route or component may well have taken part in the server render, but taujs cannot yet identify which ones did, so preloading them all would be guessing at the browser's expense. Render-used lazy modules need every renderer to report the modules a render touched, which is deferred to its own RFC;
  - module preloads are emitted only when the route's effective `hydrate` is true. A route that does not hydrate has no client execution graph to accelerate;
  - images and fonts are no longer preloaded, for the same evidential reason as dynamic imports.

  Stylesheets are deliberately unchanged in scope: every stylesheet the client build emitted for the app is still applied. Narrowing CSS to the static closure in the same change would leave a server-rendered lazy component unstyled until hydration fetched its CSS, which is a visual regression, so the existing behaviour is kept and the trade-off recorded: until render-used module reporting exists across all renderers, taujs favours SSR styling correctness over route-level CSS selectivity.

  The stylesheet tag itself changes from `rel="preload stylesheet" as="style"` to `rel="stylesheet"`. taujs has no separate CSS-preload policy here: HTML processes multiple `rel` keywords as separate link relationships (`as` belongs to the `preload` one), so combining `preload` and `stylesheet` does not create a special mode, and a stylesheet in the head already initiates its own fetch. Every emitted `href` is now HTML-attribute-escaped, matching the bootstrap script tag.

  `build.ssrManifest` remains a protected field. Its framework-owned value is now `false`, and it stays protected so an override cannot reintroduce an unmanaged manifest.

  If you have a post-build workaround that empties or deletes `dist/ssr/**/.vite/ssr-manifest.json`, it can be removed - but make it tolerate the file's absence before upgrading.

### Patch Changes

- [#95](https://github.com/aoede3/taujs/pull/95) [`4d860a1`](https://github.com/aoede3/taujs/commit/4d860a110329000fbad0a3b8a71a5c241f33dc2c) Thanks [@aoede3](https://github.com/aoede3)! - A filtered build no longer destroys the output of the apps it was not asked to build

  Selecting apps with `--app`/`--apps`/`-a` or `TAUJS_APP`/`TAUJS_APPS` was destructive twice over, and both paths were invisible until serve time. First, the `dist` deletion that opens a client build ran unconditionally, so a selective build removed every unselected app's previously built client and SSR output along with `dist/.taujs`. Second, and independently of that deletion, each app builds with Vite's `emptyOutDir`, whose skip list is derived from the output directories of the same `build()` call - and taujs calls `build()` once per app. A parent app therefore emptied its descendants' directories: building the root app alone deleted a nested app's output even after the first path was fixed. An unfiltered build repairs that through the ancestry reorder, because every descendant is rebuilt after its parent; a filtered build has no such pass.

  When a filter is active the `dist` tree is now kept, and an app that contains a declared descendant has its own output directory emptied by taujs - preserving every declared descendant by name, the way Vite's own `emptyDir` skip list works - with `emptyOutDir` then disabled for that build so Vite does not empty it again. The preservation set is computed from every DECLARED app rather than the selected ones, which is the point: the output being preserved belongs to apps this run was not asked to build. Both decisions are stated in the build log rather than happening silently. The cleanup runs immediately before `build()` rather than at the top of the per-app loop, so a failure in entry resolution, a `config.vite` callback or plugin construction cannot destroy the previous output of a build that never starts. Any cleanup failure other than a missing directory now fails the build instead of being swallowed, because Vite has already been told not to empty the directory itself.

  `build.emptyOutDir` becomes a protected build field: the merge allowlist never copied it, so this changes no resolved configuration, but an override attempt now warns exactly as `build.outDir` does rather than disappearing silently, and it is a framework invariant on this path.

  Unfiltered builds are unchanged: the full `dist` deletion still runs, so a removed app's stale output cannot survive into the next deploy, and Vite still empties each output directory itself. The graph artefact is still re-emitted from the complete configuration after a filtered build, so it continues to describe every declared app.

  Covered at three levels, each verified to fail against the pre-fix tree: unit cells for the preservation set and the cleanup, including that a non-`ENOENT` failure propagates; behaviour cells over a real temporary project asserting an unselected app's output survives a filtered client build and a filtered SSR build in both the parent-selected and child-selected directions, that selecting parent and child together still rebuilds the child, that a failing build leaves the descendant intact, and that the exact `emptyOutDir` value handed to Vite is correct in each case; and an integration suite that runs REAL Vite builds, proving Vite honours `emptyOutDir: false` without going on to destroy the preserved descendant.

- [#99](https://github.com/aoede3/taujs/pull/99) [`08152ea`](https://github.com/aoede3/taujs/commit/08152ea3eb39677619061bfe89bc0a7c9a222d8a) Thanks [@aoede3](https://github.com/aoede3)! - The dev boot advances `dev.json`'s mtime on its existing poll tick, so a reader can tell a running boot from a crashed one

  `dev.json` is removed only on graceful close, so after a crash it survives with a pid that may since have been recycled - and a reader had no way to tell that boot was over. The dev-files poller now touches `dev.json` on each tick, inside the same serialised write chain and close barrier as every other dev-file write, and it is non-fatal in the same way.

  No new field and no negotiation: liveness is the mtime, which any reader can check with one stat. Development-only, as with the rest of the introspection substrate. `@taujs/mcp` uses it to stop reporting a dead boot as active.

## 0.27.0

### Minor Changes

- [#92](https://github.com/aoede3/taujs/pull/92) [`2c620ed`](https://github.com/aoede3/taujs/commit/2c620edd3f0e7ed1e2356828cc65bc24d45ececd) Thanks [@aoede3](https://github.com/aoede3)! - Reset the mutable introspection files at boot and attribute observed counts per route

  The dev-file emitter now resets `episodes.ndjson`, `logs.ndjson` and `observations.json` when the server starts listening. Previously the poller only rewrote them on the first current-boot change, so until then the files on disk were the previous boot's - an early reader could be served old observed edges as if they were seen this boot. Previous-boot content stays legitimately readable while no boot is running (stale-mode answers cite their freshness); it is not legitimately consumed once a new boot is active (episode reads are bootId-filtered, and runtime tools refuse without an active boot), which is exactly when the reset happens - so nothing applicable is lost.

  Observed edges also gain a per-route `count` (spec 03 §4 additive field, schema version unchanged): each entry in an edge's `routes` array now carries the calls attributed to that route, alongside the existing method-wide edge `count`. Route counts need not sum to the method total - a call recorded before route match increments the method total only.

  The emitter's close path is also made write-safe: `listen()` resolves before the async `onListen` hook runner completes, so a fast boot-then-close could reach close while the boot writes were still in flight - and before the poller existed, so the poll timer then started after close and kept writing into a directory the caller was removing (an intermittent `ENOTEMPTY` in CI teardowns). Close now awaits the tracked boot work, the timer never starts once close has run, and every flush - polled or final - joins one awaited chain, so no write can land after `close()` resolves.

### Patch Changes

- [#94](https://github.com/aoede3/taujs/pull/94) [`662219e`](https://github.com/aoede3/taujs/commit/662219e4d77f0ef4dab26f3dc786eb720d07cd9c) Thanks [@aoede3](https://github.com/aoede3)! - No introspection dev-file write can land after `close()` resolves

  `listen()` resolves before the async `onListen` hook runner completes (Fastify sequences the hook promises, but the listen caller is not waiting on them), so a fast boot-then-close could reach close while the dev-file boot writes were still in flight - and before the poll timer existed, so the timer then started after close and kept writing into a directory the caller was removing (an intermittent `ENOTEMPTY` in CI teardowns). Close now awaits the tracked boot work, the timer never starts once close has run, and every flush - polled or final - joins one awaited chain. The boot graph emission, a second `onListen` writer, gets the same barrier: its write is tracked and awaited at close, and a boot that close has overtaken never starts it. Deterministic gate-held regression cells cover the boot write, a polled write, the graph write, and the composed production wiring.

## 0.26.2

### Patch Changes

- [#89](https://github.com/aoede3/taujs/pull/89) [`259ff4b`](https://github.com/aoede3/taujs/commit/259ff4bb42b66abcca084c9d3b1f3fa8075ca99d) Thanks [@aoede3](https://github.com/aoede3)! - Ownership boot line and request-graph wording: the created host's implicit document is now called the SPA fallback rather than a shell, and the wildcard warning no longer classifies a terminal wildcard route as the app-shell pattern. Log and introspection text only; no behaviour change.

## 0.26.1

### Patch Changes

- [#86](https://github.com/aoede3/taujs/pull/86) [`1bd96fc`](https://github.com/aoede3/taujs/commit/1bd96fc2af8e851aef9a4cae7294489810ca71c6) Thanks [@aoede3](https://github.com/aoede3)! - feat(server): the ownership boot line states the terminal wildcard, and is mount-aware

  Caller-owned hosts now report whether a terminal `/*` τjs page is declared and what owns the
  remaining GET paths. A declared wildcard owns GET paths not claimed by a more-specific route
  within the mount, including API-like and asset-like paths.

  Mounted τjs-created hosts now report that their shell is confined to the mounted subtree.
  Structured ownership metadata adds `mounted` and `terminalWildcard`. Routing behaviour is
  unchanged.

## 0.26.0

### Minor Changes

- [#80](https://github.com/aoede3/taujs/pull/80) [`44af7eb`](https://github.com/aoede3/taujs/commit/44af7eb37909d139dee9b163a07d14bce122180d) Thanks [@aoede3](https://github.com/aoede3)! - feat(server): declared host admission for the development introspection surface

  Adds `introspection.allowedHosts?: string[]` (post-freeze ruling 2026-08-08 on the
  introspection security model), so development behind a reverse proxy that presents a
  non-localhost `Host` can admit the proxy's hostname to the `/__taujs/*` overlay endpoints
  and the hydration beacon. Without a declaration the behaviour is unchanged: localhost-only.

  Entries are exact DNS hostnames - no wildcards, IP literals, schemes, ports or paths - and
  matching is case-insensitive, ignoring the request port; subdomains are never implied.
  Invalid entries are rejected at `createServer` entry in EVERY mode, before any host state
  exists, so a shared configuration cannot hide a typo in production. `localhost`,
  `*.localhost` and IP-literal hosts remain admitted intrinsically.

  The admission extends only the `Host` check. The remote-address guard
  (`introspection.allowNonLoopback`), the per-boot token and production absence are unchanged,
  and neither flag implies the other: a same-host gateway needs only `allowedHosts`, a proxy
  on another machine needs both. Behind a rewriting proxy τjs sees only the declared upstream
  hostname and reads no forwarding headers, so browser-facing host validation belongs to the
  proxy - a non-empty declaration shouts exactly that in the boot summary, and the first
  refusal of an undeclared hostname logs a warning naming the field instead of failing
  silently. Declare the hostname as seen at the τjs hop: a rewriting proxy substitutes its
  upstream name (behind a Platformatic gateway, `web.plt.local`, not the public host).

## 0.25.0

### Minor Changes

- [#77](https://github.com/aoede3/taujs/pull/77) [`e807b32`](https://github.com/aoede3/taujs/commit/e807b320be15c402e7caee0cc56b244788864c9e) Thanks [@aoede3](https://github.com/aoede3)! - feat(server): optional attached HMR transport for development (RFC 0013)

  Adds `server.hmrTransport?: 'fixed-port' | 'attached'`, defaulting to `'fixed-port'` so
  standalone development is unchanged.

  `'attached'` carries the development HMR WebSocket on the application's own HTTP server
  instead of a dedicated port, so it flows wherever that channel flows. This is what makes
  development work where a second fixed port cannot be reached: a supervisor that virtualises
  worker binds, a firewall, or a proxy forwarding only one channel. The served client then
  derives its socket from the origin that served it rather than a hard-coded port.

  The transport is never inferred - τjs does no host detection and reads no environment to
  decide - and `'attached'` requires a τjs-created Fastify host. Supplying your own instance
  with `'attached'` is rejected at configuration time, before any listener is installed or
  reordered, rather than being silently ignored. Unknown values are rejected rather than
  falling back. `hmrPort`, `HMR_PORT` and `--hmr-port` remain accepted so an existing
  configuration can switch transport without being rewritten, but they do not select or alter
  the attached channel.

  Running an attached channel behind a proxy is host configuration, not τjs machinery: the host
  must expose a real upstream, preserve the path prefix so the pathname reaching Vite matches
  its base, and exclude client sources from its restart watcher. It also requires a trusted
  development network, because proxies commonly drop `Origin` and rewrite `Host`, and Vite's
  WebSocket admission checks depend on those headers. See the configuration reference.

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

## 0.24.1

### Patch Changes

- [#75](https://github.com/aoede3/taujs/pull/75) [`6610800`](https://github.com/aoede3/taujs/commit/66108000f10a04926c7142fbf04868d0fbc17635) Thanks [@aoede3](https://github.com/aoede3)! - fix(server): SSR episodes classify from the response lifecycle - `finish` on a healthy socket
  records `complete`, `finish` on a socket already destroyed or errored records `aborted`, a close
  before any terminal records `aborted` at the current stage, and a mid-delivery disconnect now logs
  a warning. Previously `sent` was recorded when `reply.send()` returned, so a partially delivered
  SSR response was recorded as a successful 200 with no disconnect log. Detection covers socket
  failure observed by the time `finish` runs; a failure the server never observes is not claimed.

## 0.24.0

### Minor Changes

- [#73](https://github.com/aoede3/taujs/pull/73) [`c648536`](https://github.com/aoede3/taujs/commit/c648536130787771978655aa9d8aca517b897888) Thanks [@aoede3](https://github.com/aoede3)! - feat(server): non-root base paths - installation-level mountPrefix and publicBasePath (RFC 0012)

  A taujs installation can now be mounted under a non-root prefix and addressed behind a
  reverse proxy, in both proxy topologies. Two new optional fields on the config server block:

  - `mountPrefix` - where Fastify RECEIVES the installation: one scope prefix under which every
    declared route (all apps), taujs static and the development introspection surface register.
  - `publicBasePath` - what taujs EMITS in front of every URL it generates (asset, preload and
    CSS links, the bootstrap module URL, the dev beacon) and what the Vite base derives from,
    composed around the existing per-app entryPoint spelling. Defaults to `mountPrefix`; the
    two differ exactly when the proxy STRIPS the public prefix before forwarding
    (`mountPrefix: ''` with the public prefix declared here).

  Defaults are unchanged behaviour byte-for-byte. Coordinates are validated at function entry
  to a canonical form (`''` or `/segment(/segment)*`, URI-unreserved segment characters) and
  rejected, never silently normalised; explicit `publicBasePath: ''` alongside a non-empty
  mount is rejected as unsupported. On a taujs-created host the SPA fallback is confined to
  the mounted subtree, with an ordinary 404 outside it. Caller-supplied static registrations
  compose with the mount as normal Fastify nested routes; host-root static remains available
  via `staticAssets: false` plus a caller registration. In development the shared Vite base
  derives from `publicBasePath`, carrying module URLs and the HMR pathname; Vite's middleware
  mode natively accepts both public-prefixed and proxy-stripped request paths, so taujs owns
  only the base derivation and the confinement of dev delegation to the mounted subtree. HMR
  socket origin and port under supervisors, and reverse-proxy host admission for the
  introspection endpoints, remain separate follow-ups.

## 0.23.1

### Patch Changes

- [#70](https://github.com/aoede3/taujs/pull/70) [`86414ae`](https://github.com/aoede3/taujs/commit/86414ae97ee508eae911de935c9d2536be0c7fcb) Thanks [@aoede3](https://github.com/aoede3)! - On a caller-owned development host, Vite no longer answers requests Fastify selected for a caller route.

  The development delegator runs Vite's middleware from an `onRequest` hook. On a caller-owned host that hook sits on the caller's own root instance, so Vite saw every request - including ones the caller's routes were selected to serve, and it answered some of them. The visible symptom was Vite's 403 block page returned for a **caller's own route** whenever the incoming `Host` was one Vite does not allow, which a reverse proxy or supervisor commonly presents.

  Selected **caller** routes now bypass the middleware. Declared τjs pages deliberately do not: they are selected too, but they stay in the middleware path so Vite's host check keeps applying to them - the bypass narrows who Vite answers for without weakening the DNS-rebinding posture for τjs's own documents, and both ownership modes keep the same posture. Anything unmatched still reaches Vite, so `/@vite/client`, source modules and assets are unaffected, and an unmatched URL Vite does not claim still falls through to the caller's own 404 handler.

  The classification is two reads rather than a lookup: `request.is404` is a public Fastify getter over the route context Fastify already selected, and the τjs page identity is the one the same request already carries for rendering, auth and CSP. Nothing re-resolves a URL, so nothing can disagree with Fastify's own selection on wildcards, constraints or decoded parameters.

  Unchanged: τjs-created hosts, and Vite's host posture - an undeclared `Host` is still rejected for τjs pages and for the resources Vite owns. Declare `vite.server.allowedHosts` to allow one.

  Note the ownership consequence: caller routes now follow the **caller host's own** Host-validation policy, whatever that is. `vite.server.allowedHosts` protects τjs pages and Vite resources; it does not govern caller-owned routes, and never sensibly did - a caller route answered by Vite's host check was the defect.

## 0.23.0

### Minor Changes

- [#68](https://github.com/aoede3/taujs/pull/68) [`183d94d`](https://github.com/aoede3/taujs/commit/183d94d9655e2f322854e8daca177e4ddf7b3389) Thanks [@aoede3](https://github.com/aoede3)! - A declared `vite.server.allowedHosts` now reaches the development server, so τjs can run behind a proxy.

  Vite 6.1+ rejects any request whose `Host` is not localhost-like unless `server.allowedHosts` permits it - a DNS-rebinding defence. A reverse proxy or process supervisor commonly presents such a host, and development behind one then answered Vite's 403 block page instead of the application, with no supported way to allow it: τjs composed its dev config by writing `server` as a whole object **after** the user's, silently discarding the declared field.

  The composition now merges. The framework stays authoritative for exactly two fields:

  - `server.middlewareMode` stays `true` - τjs owns the request pipeline;
  - `server.hmr` is derived from the resolved dev host and port, and is replaced **whole** rather than deep-merged. A partly-user, partly-framework `hmr` would pair a user port with a framework host and fail in a way that looks like a τjs bug.

  Both remain warned-and-dropped invariants if declared, alongside `root`, `configFile` and the rest.

  The admitted surface is deliberately one field, `server.allowedHosts`:

  ```ts
  // taujs.config.ts
  export default {
    vite: {
      server: { allowedHosts: ['app.internal'] },
    },
  };
  ```

  Everything else under Vite's `server` stays withheld, each for a reason: `ws: false` would disable the WebSocket connection HMR runs on; `host`, `port`, `strictPort`, `https` and `open` configure Vite's own HTTP listener, which does not exist in middleware mode because Fastify owns it; and `proxy` overlaps caller-route ownership. Supplying any of them **in development** warns and is not applied; in a build the whole `server` object is stripped silently, so nothing under it warns there. More can be admitted later, one at a time, with evidence that each works in middleware mode.

  The security posture is narrowed, never removed: a host you have not declared is still refused.

  `server` is development-only, and now behaves like `optimizeDeps` on the build side: absent from client and SSR builds **silently**. `config.vite` is one declaration feeding the development server and every app build, so warning there would report the recipe above as misuse, once per app, on every build.

## 0.22.0

### Minor Changes

- [#66](https://github.com/aoede3/taujs/pull/66) [`7637866`](https://github.com/aoede3/taujs/commit/76378662c18c19b95a2b9906ddf3c61fdfe43106) Thanks [@aoede3](https://github.com/aoede3)! - Streaming responses are now sent through Fastify rather than by taking over the raw socket.

  τjs previously called `reply.hijack()` for a streaming route and wrote the response itself. It now returns a document for Fastify to send, which means Fastify owns the transport, the head and the socket for every render strategy.

  **`onSend` now runs for streamed responses.** It was silently skipped before, so an `onSend` policy applied to SSR pages and ordinary routes while missing every streamed page. Hosts that assumed that gap should re-read the [hook matrix](https://taujs.dev/guides/host-ownership/#response-policy-and-lifecycle-hooks): `onRequest` and `preHandler` remain the recommended points for security and cache policy, and `onSend` is now usable for deliberate transformation of the final response.

  Two consequences worth knowing before you write hooks:

  - Once Fastify has been handed the document, a streamed response that then fails **before yielding its first byte** gives the host **two send passes** - the document that was about to be sent, then the error representation Fastify sends instead. (A request that fails earlier, before any document is returned, still takes Fastify's ordinary single error path.) `onResponse` describes the request once either way. Write `onSend` hooks so they are safe across response attempts.
  - A hook may wrap the payload, but the wrapper must propagate source errors to the stream it returns. Node's `.pipe()` alone does not, and a wrapper built with it leaves a failed response hanging. The guide carries a worked example.

  Failure boundaries are now stated by the byte rather than by a renderer callback: before the first document byte reaches Fastify a failure can still become a real 500; after it, the transfer aborts with whatever was delivered. Each renderer reaches that boundary on its own terms, and no framework-specific code exists in the server.

  Observable improvements:

  - a renderer failure that used to race the raw socket - sometimes discarding a shell that had already been written - now delivers what was produced and then aborts the transfer;
  - a payload replaced by an `onSend` hook means the renderer never starts at all, and the response is recorded as complete while the superseded deferred work is recorded as aborted;
  - a streamed response that fails before its first byte sends its error as JSON explicitly, instead of inheriting the HTML content type the abandoned response had already declared;
  - a renderer that fails in the same tick as it publishes its head now answers with a real 500. Publishing a head previously entered raw-socket commitment and teardown, so the outcome depended on what had already been flushed; the boundary is now the first byte **yielded to Fastify**, and a head is not one. This changes Vue most visibly, since Vue publishes its head before rendering any component;
  - a client that disconnects before the response can be wired at all - while a host hook is still awaiting - is now recorded as `aborted`, and the deferred work that had already started is released rather than stranded.

  `reply.hijack()` remains in the development introspection SSE endpoint only, which is intentionally out of scope for this change rather than inherent to SSE.

## 0.21.1

### Patch Changes

- [#63](https://github.com/aoede3/taujs/pull/63) [`8b37f90`](https://github.com/aoede3/taujs/commit/8b37f90c25c272b017ff610839623e27b188ca35) Thanks [@aoede3](https://github.com/aoede3)! - Streaming no longer duplicates pre-handoff headers by re-adding them under different casing.

  `reply.getHeaders()` returns lowercase keys, and the head write added `Content-Security-Policy` back under its canonical casing, which Node serialises as a separate header line. Any CSP set before the raw handoff was therefore emitted twice on a streamed response, including the one τjs's own CSP plugin sets in `onRequest`. Both lines always carried the same value, so the policy in force was unchanged, but the duplicate is invalid hygiene in a security header and hosts and proxies may flag or reject it.

  The 200 and pre-head 500 paths now commit one normalised, lowercase-keyed object, so every header the reply already carried is preserved under its canonical lowercase name. Hijacking, stream timing, failure handling, deferred settlement and telemetry are untouched.

## 0.21.0

### Minor Changes

- [#61](https://github.com/aoede3/taujs/pull/61) [`8689e32`](https://github.com/aoede3/taujs/commit/8689e321436bd63786dc10863cec19a4d81946ff) Thanks [@aoede3](https://github.com/aoede3)! - One runtime-mode derivation replaces the scattered `NODE_ENV` comparisons. Development must be
  requested explicitly; `production`, `test`, unset and any other value (`staging`, `ci`, a typo)
  are one production mode, resolved once and snapshotted at module evaluation.

  This fixes a real boot failure. Two derivations disagreed about every value that was neither
  literal: the client root partitioned on `=== 'production'` (so `test` and unset selected
  `src/client`) while asset loading partitioned on `=== 'development'` (so the same values took the
  production branch). The result was a development client root with production asset loading, i.e. a
  guaranteed `src/client/.vite/manifest.json` ENOENT at boot - an infinite crash-loop under a
  supervisor that restarts failed workers, and the reason `NODE_ENV`-unset hosts such as
  Platformatic Watt workers could not boot a τjs application at all.

  An unset `NODE_ENV` now selects production mode consistently. With built assets present, the
  application boots from `dist/client` instead of incorrectly reading production manifests from
  `src/client`. An explicitly supplied `clientRoot` remains authoritative in every mode.

  Intentional behaviour changes when `NODE_ENV` is `test`, unset, or any value other than
  `development` and `production`. Each was previously treated as non-production:

  - the client root is `dist/client`, not `src/client`
  - the runtime logger minimum level is `info`, not `debug`, in both fallback constructions. Debug
    records are a development facility, so `debug` options no longer produce debug output in these
    environments
  - log timestamps are ISO, not `HH:mm:ss.SSS`
  - warning records strip stacks by default
  - a missing global CSP raises the production advisory, in the boot summary and in the security
    contract report (status `warning` with the production tail note)

  Set `NODE_ENV=development` for the development loop, as the scaffolded scripts already do. No
  public API changes: the derivation is internal, and `resolveRuntimeMode` is not exported from the
  package.

## 0.20.0

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

## 0.19.0

### Minor Changes

- [#57](https://github.com/aoede3/taujs/pull/57) [`4f2e015`](https://github.com/aoede3/taujs/commit/4f2e015f39238fbef8bc86a25787d4080769a6b2) Thanks [@aoede3](https://github.com/aoede3)! - BREAKING: `taujsBuild` is no longer exported from the `@taujs/server` root. Its only public
  home is the dedicated build entry, `@taujs/server/build`.

  Migration is a one-line import-path change with no behavioural change:

  ```diff
  - import { taujsBuild } from '@taujs/server';
  + import { taujsBuild } from '@taujs/server/build';
  ```

  The removal separates the production runtime from the build toolchain. Importing
  `@taujs/server` for `createServer` previously executed the build module's static
  `import { build } from 'vite'` through a shared chunk, loading the whole Vite build toolchain
  (Vite, Rollup, esbuild) into every production process. Three changes close that seam:

  - the root entry no longer exports `taujsBuild`, so the runtime chunk no longer contains the
    build module
  - the render path imports `resolveEntryFile` from its runtime home instead of reaching it
    through the build module
  - the development-only Vite helpers (dev-server setup, dev Vite config resolution, plugin
    ownership preparation) are loaded dynamically inside the development branch, never at module
    scope

  Importing the `@taujs/server` runtime no longer resolves Vite, and no production
  Vite-toolchain resolution is attributable to `@taujs/server`. Application production boots
  may still load renderer compiler tooling until the coordinated renderer contribution change.
  Development and build behaviour are unchanged; `@taujs/server/build` keeps the entire build
  surface as it was.

  `create-taujs` scaffolds generate `build.ts` with the subpath import.

## 0.18.0

### Minor Changes

- [#55](https://github.com/aoede3/taujs/pull/55) [`205c023`](https://github.com/aoede3/taujs/commit/205c0231cb6841f8106217b9abed19db52944462) Thanks [@aoede3](https://github.com/aoede3)! - Fastify `req.id` is now the canonical request-correlation identity in both host modes (SC-09).

  Behaviour changes:

  - τjs no longer reinterprets an inbound correlation header after Fastify has created the request.
    The request identity is always `String(req.id)`; header adoption is a construction-time decision.
  - On a τjs-created host, τjs now configures `genReqId` at Fastify construction: a single valid
    inbound `x-request-id` becomes `req.id`, otherwise a UUID is generated. Previously the created
    host used Fastify's default counter (`req-1`), so created-host identities visibly change shape.
  - On a caller-owned host, τjs adopts whatever `req.id` the host produced. Hosts that previously
    sent `x-trace-id` and relied on τjs echoing it must now adopt inbound correlation themselves at
    Fastify construction with a validating `genReqId` (not `requestIdHeader`, which takes the header
    unvalidated).
  - Request log bindings collapse to the Fastify-native `reqId` alone, and `reqId` has ONE meaning
    and ONE representation: the current Fastify request, in its native type, bound once by the
    request logger and inherited through child-logger lineage. Service-dispatch children and
    deferred-data warnings no longer rebind it (a rebind stringified numeric host identities), the
    not-found fallback context carries the native `req.id`, and the hydration-beacon debug record
    names the episode it updates as `episodeRequestId` - the beacon POST is its own request. Episode
    records use `requestId`; log correlation uses `reqId`.
  - τjs no longer invents a fallback identity: if a host violates Fastify's guarantee of a string or
    number `req.id`, request-context creation fails explicitly with a `TypeError` instead of
    silently generating a UUID that could never match the host's own records.

  Renames, with no compatibility aliases:

  - request-context and structured-record field `traceId` becomes `requestId`
  - header `x-trace-id` becomes `x-request-id`, inbound and outbound; inbound `x-trace-id` is no
    longer recognised
  - `REGEX.SAFE_TRACE` becomes `REGEX.SAFE_REQUEST_ID`
  - browser stamp `__TAUJS_TRACE_ID__` becomes `__TAUJS_REQUEST_ID__`; the hydration beacon field
    `traceId` becomes `requestId`, and its rejection reason `invalid_trace_id` becomes
    `invalid_request_id`
  - MCP tool argument and returned field `traceId` become `requestId`; `sampleTraceIds` becomes
    `sampleRequestIds`

  `requestId` is application request correlation, not a W3C or OpenTelemetry trace ID. A future
  distributed-tracing integration uses `traceparent` and its own trace and span identities.

- [#55](https://github.com/aoede3/taujs/pull/55) [`69a840b`](https://github.com/aoede3/taujs/commit/69a840bb2bb165cd2628395123e451d6ba2913e3) Thanks [@aoede3](https://github.com/aoede3)! - The recorder subsystem stops using "trace": the settled concept word is "episode" (SC-09 ruling 9).

  This is a behaviour-preserving surface migration - the recorder's behaviour is unchanged, but
  observable interfaces change, with no compatibility aliases:

  - MCP tools: `taujs_get_recent_traces` becomes `taujs_get_recent_episodes`, `taujs_get_trace`
    becomes `taujs_get_episode`, `taujs_get_trace_logs` becomes `taujs_get_episode_logs`; the
    recent-episodes response key `traces` becomes `episodes`, the `taujs_doctor` report field
    `failedTraces` becomes `failedEpisodes`, and the not-found reason `trace_not_found` becomes
    `episode_not_found`
  - development endpoint `/__taujs/traces` becomes `/__taujs/episodes`, and its response key
    `traces` becomes `episodes`
  - development artefact `traces.ndjson` becomes `episodes.ndjson`; `dev.json` exposes
    `paths.episodes` and no longer exposes `paths.traces`. A stale legacy `traces.ndjson` from an
    earlier boot is removed explicitly at the next boot so it can never be mistaken for current-boot
    evidence, and current MCP never reads the old file
  - TypeScript types: `TraceRecorder` becomes `EpisodeRecorder`, `noopTraceRecorder` becomes
    `noopEpisodeRecorder`, `TraceRecord` becomes `EpisodeRecord`, `TraceTimeline` becomes
    `EpisodeTimeline`; `getTraces()` becomes `getEpisodes()`, `findTrace()` becomes `findEpisode()`
    and `tracesRevision` becomes `episodesRevision`
  - an episode carries no `episodeId`: its key is the canonical `requestId`

  The word "trace" is reserved in the τjs observability model for genuine distributed tracing
  (`traceparent`, OpenTelemetry trace and span IDs), which remains a separate future capability.

## 0.17.1

### Patch Changes

- [#53](https://github.com/aoede3/taujs/pull/53) [`1e7e13a`](https://github.com/aoede3/taujs/commit/1e7e13aced04821775d297adbede165902c1561a) Thanks [@aoede3](https://github.com/aoede3)! - Correct route-data failure ownership. `attr.data` now awaits service dispatch, so a service
  rejection receives the same classification and HTML-response hint as a handler or invalid-result
  failure. Data resolution classifies but does not log. The SSR and streaming response terminals emit
  one `component: 'fetch-initial-data'` response record - a stackless warning for expected domain,
  validation and auth failures, or an error with a stack otherwise - while HTTP conversion, trace
  recording, aborts and teardown remain unconditional if logging fails. Service-call and renderer
  advisory diagnostics remain separate intentional records. Application-supplied `details.logged`
  no longer influences terminal logging. The internal route-data resolver is simplified to one awaited
  handler-validation-dispatch path; head and deferred-data semantics are unchanged. React now
  preserves the original route-data rejection through its server-side store so the streaming terminal
  can retain that classified failure's ownership.

## 0.17.0

### Minor Changes

- [#50](https://github.com/aoede3/taujs/pull/50) [`6e1f9c3`](https://github.com/aoede3/taujs/commit/6e1f9c3e51345c841617ba2813e097210307fc2d) Thanks [@aoede3](https://github.com/aoede3)! - Align the public RouteContext type with the runtime value - the context is `{ appId, path, attr, params }`, exactly what renderers receive. The `data` field is removed from the type (it was never supplied at runtime; route data reaches the renderer store) and the runtime-supplied `params` is typed as `RouteParams`.

  This also repairs the public aliases: `RouteContext` and `RouteData` from `@taujs/server/config` previously collapsed to `never` (optional `routes` on the broad config failed an internal array test), so neither was usable; there were no in-repository consumers of the collapsed aliases. `RouteContext` is now generic with a broad default - bare for the runtime shape, `RouteContext<typeof config>` for per-route precision - and a route without `attr` types its context `attr` as `undefined` rather than `never`. `RoutesData` and `RouteData` derive the same data unions as before from route declarations; path-specific `RouteData` lookup requires the concrete config type. Minor rather than patch because removing the declared `data` field can break downstream code typed against it, even though that field was always `undefined` at runtime.

### Patch Changes

- [#51](https://github.com/aoede3/taujs/pull/51) [`b839dd8`](https://github.com/aoede3/taujs/commit/b839dd8db843cf8b57959a26fc41024930429bb2) Thanks [@aoede3](https://github.com/aoede3)! - `RouteData` now resolves `serviceData()` routes to the selected service method's result instead of the runtime descriptor - the `RouteDataOf` brand arm the `SERVICE_RESULT` comment always promised, mirroring `HeadDataOf`. Hand-built descriptor closures collapse to `Record<string, unknown>` (the dispatch result is untyped), plain closures are unchanged, and a route without `attr.data` resolves to the new exported `EmptyRouteData` (`Record<string, undefined>` - the honest type of the `{}` the server supplies), so a data-less route unions cleanly into an app-wide `RouteData` instead of collapsing it to `unknown`. All arms pinned by the internal and public type gates.

## 0.16.1

### Patch Changes

- [#47](https://github.com/aoede3/taujs/pull/47) [`0c03792`](https://github.com/aoede3/taujs/commit/0c037924950e387aa58185a9225b8a9241b89eec) Thanks [@aoede3](https://github.com/aoede3)! - Honour `staticAssets: false` as a production opt-out - explicit `false` now installs no static plugin in production or development, while omitting the option keeps the default `@fastify/static` registration. Previously a falsy value was treated the same as omission and the default plugin was installed anyway, so a CDN-only deployment could not disable Fastify static serving.

## 0.16.0

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

## 0.15.0

### Minor Changes

- [#40](https://github.com/aoede3/taujs/pull/40) [`6a077a0`](https://github.com/aoede3/taujs/commit/6a077a07039df0d5945029a0320ef43ab13996a2) Thanks [@aoede3](https://github.com/aoede3)! - Respect a caller-supplied Fastify instance (RFC 0010)

  τjs now derives one internal ownership fact from whether you passed `fastify` to `createServer`.

  **Bring your own Fastify and τjs respects it.** When you supply an instance, τjs registers its
  routes, CSP, trace, auth, static assets, introspection and error conversion into a single
  encapsulated Fastify scope. It no longer replaces your error handler or not-found handler, applies
  no CSP or trace to your routes, claims no root decorators, prints no banner or presentation output,
  and adds no `onReady` hook. It still registers under its own name, so it appears in your plugin
  tree. In development a single root `onRequest` hook delegates otherwise-unmatched requests to the
  τjs-owned Vite server and returns control unchanged; production installs no root hook at all.

  **Let τjs create Fastify and it provides the complete experience.** Omit `fastify` and behaviour is
  unchanged: whole-server CSP and trace, the implicit application shell, the banner and configured
  line.

  No new ownership option or mode is introduced. Standalone applications are unaffected; embedded
  applications should read the migration notes below, since some may need to declare a wildcard page
  or establish host-wide CSP on their own instance.

  ### Behaviour changes for embedded hosts

  These previously applied to your whole server and now apply only to τjs-owned responses:

  - **The implicit application shell is gone.** Unmatched URLs fall to your own not-found policy. If
    you want τjs to render them, declare a terminal wildcard page route (`path: '/*'`), which is an
    ordinary τjs page and now also owns asset-like URLs it matches.
  - **Configured τjs CSP no longer applies to your routes.** Host-wide policy belongs to Fastify;
    τjs CSP, nonces and route-level `merge`/`replace` continue to apply to τjs pages.
  - **`x-trace-id` no longer appears on your routes**, and no τjs trace episode opens for them. For
    its own responses τjs still adopts an inbound `x-trace-id`, or otherwise your Fastify `req.id`,
    so your records and τjs's join on one identity in the logs. The shared value is not on the wire:
    your routes carry no trace header.

  `req.id` adoption now also accepts a numeric `genReqId`. Previously only a string identity was
  adopted and a counter-based `genReqId` silently fell through to an unrelated random UUID, breaking
  that correlation without warning.

  Two boot failures are also fixed: supplying an instance that already owns a not-found handler, or
  that has already registered `@fastify/static`, previously prevented τjs from booting.

  The boot summary now states which ownership mode is in effect.

## 0.14.1

### Patch Changes

- [#38](https://github.com/aoede3/taujs/pull/38) [`985cf55`](https://github.com/aoede3/taujs/commit/985cf552f6275a0db1d3ee97ba6304ec495d02c4) Thanks [@aoede3](https://github.com/aoede3)! - Converge τjs runtime logging on the selected Fastify, explicit, or standalone
  logger, preserving request correlation, Pino policy, and CSP reporting across
  the server lifecycle.

  Custom structured sinks now receive the raw semantic message instead of a
  τjs-formatted timestamp and level prefix. This corrects the documented
  `BaseLogger` contract; consumers parsing the previous embedded prefix should
  use their sink's structured timestamp and level fields instead.

  Pre-shell streaming failures now preserve the response's existing headers,
  including `x-trace-id` and Content Security Policy, on the resulting 500
  response.

## 0.14.0

### Minor Changes

- [#36](https://github.com/aoede3/taujs/pull/36) [`d1e2f65`](https://github.com/aoede3/taujs/commit/d1e2f651302b29b85867e75fdfdcb6d54f49a348) Thanks [@aoede3](https://github.com/aoede3)! - Register declared τjs page paths as native Fastify routes. Fastify now owns route syntax,
  matching, decoded parameters, precedence, and router policy; τjs applies application orchestration
  after selection. Exact duplicate τjs paths fail at startup, and the private `path-to-regexp`
  dispatcher has been removed.

  This changes existing route semantics to those of the supplied Fastify instance, including case
  sensitivity, trailing-slash handling and malformed-URL policy. Replace path-to-regexp-only forms
  such as optional brace groups, named wildcards and parameter `*`/`+` modifiers; τjs now rejects
  known stale forms at startup rather than registering them with different semantics.

  Route auth and route-level CSP now apply only to the Fastify-selected τjs route, never
  incidentally to host-owned routes or unmatched case variants. Dotted values such as `logo.png`
  are valid declared page-route parameters; asset-like URLs still 404 when no declared page or
  static route owns them.

  The MCP route explanation now labels its schema-v1 specificity value as a deterministic
  declaration score, not Fastify runtime precedence. The graph schema is unchanged.

## 0.13.0

### Minor Changes

- [#28](https://github.com/aoede3/taujs/pull/28) [`c61c3c1`](https://github.com/aoede3/taujs/commit/c61c3c1a54f44b977725f858e2b88e684d6d3ab9) Thanks [@aoede3](https://github.com/aoede3)! - Renderer v1: declare an app's framework with a required singular `renderer:`

  **BREAKING CHANGE.** Existing apps must migrate (see Migration below): every app now needs a
  `renderer:` field, and any direct `renderStream` caller must move `cspNonce` from the removed
  positional argument onto `opts`. The bump is `minor` because these packages are pre-1.0, where a
  minor is the semver-correct level for a breaking change; it is nonetheless breaking for consumers.

  Every app now declares a REQUIRED singular `renderer:` - an opaque contribution from
  `reactRenderer({ project })` (`@taujs/react/renderer`) or `vueRenderer()`
  (`@taujs/vue/renderer`). `renderer:` is required at runtime: an app without a valid
  renderer fails at boot and build. The `plugins` array returns to meaning ordinary Vite
  plugins only.

  React is a JSX renderer with scoped compiler ownership (the host computes each framework's
  scope after seeing all apps and constructs a correctly-scoped compiler, with a fail-closed
  ownership diagnostic); Vue supplies its `pluginVue` pack fresh per environment without
  ownership machinery. Every declared renderer ships a render module that is
  identity-validated against its declaration (both `renderSSR` and `renderStream` are
  brand-checked - at boot in production, after `ssrLoadModule` in development) with a hard
  error and migration guidance on a mismatch. There is no incomplete-renderer mode.

  The shared render-options bag is now a named `RenderOptions` on both `renderSSR` and
  `renderStream`, carrying `cspNonce` (authoritative; the positional stream argument is
  removed) and the host-resolved `shouldHydrate`, delivered on both rendering strategies.

  Migration:

  - Replace `plugins: [pluginReact()]`/`plugins: [pluginVue()]`-style framework wiring with
    `renderer: reactRenderer({ project: './tsconfig.json' })` / `renderer: vueRenderer()`.
  - Raw `pluginReact()`/`pluginVue()` remain exported and portable for plain-Vite/standalone use.
  - Entry-server files are unchanged: `createRenderer(...)` now brands its returned functions
    so the host can validate framework identity.
  - If you consume `renderStream` directly, pass `cspNonce` via `opts.cspNonce` instead of the
    removed positional argument.

### Patch Changes

- [#28](https://github.com/aoede3/taujs/pull/28) [`d734dc7`](https://github.com/aoede3/taujs/commit/d734dc7cafaa132e7156dd183b6f403dfc3f3bd0) Thanks [@aoede3](https://github.com/aoede3)! - Fix: `__proto__` in route data now round-trips as an ordinary own property

  Route data is injected into the page as `window.__INITIAL_DATA__ = <value>`. That value was
  always emitted as a JavaScript object literal, and in an object literal a quoted `"__proto__":`
  key SETS THE CREATED OBJECT'S PROTOTYPE (ES Annex B.3.1) rather than adding an own property. So a
  route that legitimately returned a `__proto__` key produced a client value whose shape differed
  from the server's: the key was an own property on the server and landed on the prototype in the
  browser, at any depth.

  This was never global prototype pollution - `Object.prototype` was untouched, and it remains
  untouched - but it was silent semantic drift in the single shared serialisation boundary, and
  "the global prototype was not polluted" is not the same guarantee as "the client received the
  value the server sent".

  Now, when a payload contains a `__proto__` key at any depth, the value is emitted as
  `JSON.parse("…")`. `JSON.parse` creates the key as an ordinary own data property at every depth,
  the object's prototype stays `Object.prototype`, and the global prototype is still untouched.
  Breakout escaping is unchanged in both forms.

  Every other payload keeps the object-literal form and is byte-identical to before, so ordinary
  responses and cached pages see no difference. The one exception is a string value exactly equal to
  `"__proto__"`, which also selects the `JSON.parse` form: the two forms are semantically identical,
  so this costs a few bytes and changes nothing observable.

## 0.12.0

### Minor Changes

- [#25](https://github.com/aoede3/taujs/pull/25) [`0e7186c`](https://github.com/aoede3/taujs/commit/0e7186cfa1a257178a629e0bb19f5c3dfa69e185) Thanks [@aoede3](https://github.com/aoede3)! - Declared Vite customisation surface (RFC 0005): one config file owns the whole Vite surface, applied symmetrically to dev and build.

  - `config.vite` - a new first-class field on `taujs.config.ts`, typed as an allowlisted `TaujsViteConfig` (or a `(ctx) => TaujsViteConfig` function form receiving a discriminated serve/build context). Admitted fields (`plugins`, `define`, `css.preprocessorOptions`, `esbuild`, `logLevel`, dev-only `optimizeDeps`, non-`alias` `resolve`, and build tuning such as `build.sourcemap`/`minify`/`rollupOptions.external`/`output.manualChunks`) now reach the shared dev server and every production build through one merge engine and one precedence chain (framework invariants -> `config.vite` -> `taujsBuild({ vite })`).
  - `config.alias` - the declarative home for aliases, sourced by both dev and build. Relative values normalise against the project root; absolute values pass through. The programmatic `createServer({ alias })` and `taujsBuild({ alias })` options remain as escape hatches, layered on top.
  - `configFile: false` is now pinned in both dev and build, so no stray `vite.config.*` is ever auto-discovered. A `vite.config.*` left in a formerly probed location (the client base root or a per-entry root) triggers a targeted migration warning at dev boot and at build start, naming the file and pointing at the `config.vite` recipe. Project-root files were never read and are exempt.
  - Plugin composition rule (dev and build): concatenate in declared order, dedupe by plugin name with the first occurrence winning, and report every cross-source collision once at warn level with the name, each declaring source, and the winner. The `τjs-` framework prefix is reserved - a user plugin carrying it is dropped with a warning. Cross-app plugin collisions in the shared dev server are promoted from debug to warn.
  - Protected-field warnings: supplying a framework-owned field (`root`, `base`, `publicDir`, `configFile`, `server.*`, `appType`, `build.outDir`/`ssr`/`ssrManifest`/`format`/`target`/`manifest`, `rollupOptions.input`, `resolve.alias`) through the override channels is rejected and logged at warn in both dev and build, never silently applied or dropped. The typed `TaujsViteConfig` surface excludes these, so only a JS config or `as any` cast can reach the runtime guard.
  - `optimizeDeps` is a development-only subset (`include`/`exclude`/`esbuildOptions`); the same package in both `include` and `exclude` is a config-validation error, and nothing from `optimizeDeps` reaches production builds.
  - Fix: multi-app builds are now ordered parent-first (root app before named entry points), so a root app declared after a named MFE no longer empties `dist/client`/`dist/ssr` and deletes the MFE's already-emitted output. Per-app `emptyOutDir` behaviour is unchanged. The reorder is ancestry-aware and minimal: an app moves only to sit immediately before the first app whose output directory it contains (ancestry derived from resolved paths, so non-canonical entry points such as trailing-slash parents order correctly). An ancestor moves immediately before its first already-placed descendant, crossing unrelated apps when required; otherwise declared order - which callback and plugin execution observe - is retained, and a collection containing no ancestry relationships is never reordered.

## 0.11.0

### Minor Changes

- [#21](https://github.com/aoede3/taujs/pull/21) [`3e69316`](https://github.com/aoede3/taujs/commit/3e693165c523b598e434eee55acc8a3c8b99735b) Thanks [@aoede3](https://github.com/aoede3)! - RFC 0004 (H1): routes may declare `attr.head = { data, timeoutMs?, optional? }` - a dynamic head
  data loader resolved BEFORE the renderer starts on BOTH strategies and delivered to the renderer
  as `opts.headData` (an additive optional field on the `RenderSSR`/`RenderStream` contracts). This
  gives streamed pages dynamic `<head>` data for the first time; `attr.meta` remains the static
  layer, and head data is never serialised into `__INITIAL_DATA__`.

  Semantics (signed policy): the loader is bounded by `timeoutMs` (default 3000 ms, positive finite
  only - validated at boot); on deadline expiry with the request still live the render proceeds
  with `headData: undefined` plus an advisory log; a caller abort never proceeds into the renderer;
  an ordinary loader rejection fails the request through the existing error path unless the route
  opts in with `optional: true`. On the streaming branch a head failure terminates the hijacked
  reply deterministically (500 before headers, destroy after) instead of rethrowing into a response
  Fastify no longer owns.

  Type inference: `serviceData()` now returns a phantom-branded `ServiceDataHandler<Result>`
  (type-level only - the runtime value is still the honest service descriptor), and the new
  `HeadDataOf<Route>` helper (exported from `@taujs/server/config` with `HeadAttributes`) infers
  the actual selected service method result for `headContent` typing.

## 0.10.0

### Minor Changes

- [#15](https://github.com/aoede3/taujs/pull/15) [`a1a627a`](https://github.com/aoede3/taujs/commit/a1a627a16fdc9aba8b8d33198be053e092c28053) Thanks [@aoede3](https://github.com/aoede3)! - R0-01: export `RenderStreamHandle` (`{ abort(): void; done: Promise<void> }`) as the return
  type of `RenderStream`, and observe `done` at the streaming render call site.

  Both framework renderers already returned `{ abort, done }` at runtime, but the published
  `RenderStream` type promised only `{ abort(): void }`, so the server could not capture `done`.
  A fatal stream error rejects `done`; left unobserved, that surfaced as an `unhandledRejection`
  — which Node's default mode turns into a process-terminating `uncaughtException`. The server
  now captures and acknowledges `done` (fatal errors remain fully handled via the `onError`
  callback; the acknowledgement is also defence in depth if a renderer omits its own handler).

  Type-level breaking change for third-party `RenderStream` implementers: they must now return a
  `done` promise. Both first-party renderers already conform. Bumped `minor` as an additive
  contract type (precedent: V1-05), keeping `@taujs/server` below 1.0.0.

### Patch Changes

- [#15](https://github.com/aoede3/taujs/pull/15) [`1b251fa`](https://github.com/aoede3/taujs/commit/1b251fa10adc055013c9692f8f5c093bcc02ddab) Thanks [@aoede3](https://github.com/aoede3)! - R0-02: origin-aware benign-error classification in `HandleRender`. Replaces the broad
  `REGEX.BENIGN_NET_ERR` substring match (now removed) with a strict socket taxonomy — disconnect
  `code`, `AbortError` name, or exact node/undici socket message.

  Fixes a hung-request hole: a `renderSSR` failure is render-origin, so it is benign only when the
  request was actually aborted. A disconnect-shaped render error on a live request previously
  returned silently without sending a response (hanging the request); it now produces a real 500.
  Socket-origin paths (send failure, PassThrough/HTTP socket errors, stream `onError`) use the same
  strict socket check, so an application error whose message merely contains "aborted"/"premature"
  is no longer mistaken for a client disconnect.

- [#15](https://github.com/aoede3/taujs/pull/15) [`d629017`](https://github.com/aoede3/taujs/commit/d629017837553f2b0196aed330cd975edc581689) Thanks [@aoede3](https://github.com/aoede3)! - R0-04: eliminate the second process-crash class — a `JSON.stringify` failure thrown from the
  streaming `finish` listener, which runs on a stream tick OUTSIDE the request `try/catch`, so an
  uncaught throw becomes an `uncaughtException` → process exit.

  A single server-owned `serializeInlineData` boundary now serializes the inline
  `window.__INITIAL_DATA__` script for BOTH render modes. It escapes `<` (output is byte-identical
  to the previous inline expression for every valid input, so cached pages are unaffected), treats
  circular references, `BigInt`, a throwing `toJSON`, and `undefined` as deterministic failures, and
  NEVER throws. The SSR path throws an `AppError.internal` into the existing 500 machinery on
  failure; the streaming path logs, records (`recorder.failed`), and terminates the response
  deterministically without a data script — with the entire listener wrapped in a `try/catch` belt.
  The JSON data contract is unchanged (no new serializer dependency).

- [#15](https://github.com/aoede3/taujs/pull/15) [`55ace30`](https://github.com/aoede3/taujs/commit/55ace30371dccde96cc8151c17ec838a11c3b700) Thanks [@aoede3](https://github.com/aoede3)! - R0 gate recheck fix — a throwing host `onError` callback can no longer veto stream
  cleanup/settlement:

  - **Renderers** (`@taujs/react`, `@taujs/vue`): every fatal path now routes through a single
    helper that invokes the host `onError` under `try/catch` (the throw is logged and swallowed) and
    ALWAYS runs `controller.fatalAbort`. So a throwing callback — or one called from a shell timer or
    a writable EventEmitter listener — can neither skip cleanup / `done` settlement nor escape as an
    `uncaughtException`; the ORIGINAL render error stays the rejection reason. React additionally no
    longer double-fires `onError` for a fatal writable error.
  - **Server** (`@taujs/server`): the streaming render `onError` callback is now non-throwing for an
    arbitrary/hostile `unknown`. Telemetry (message / kind / normalise / reason) is extracted through
    safe, never-throwing helpers and belted, so formatting a hostile error (a throwing `message`
    getter or `Symbol.toPrimitive`) can no longer prevent the deterministic response teardown
    (500 / socket destroy).

- [#15](https://github.com/aoede3/taujs/pull/15) [`9bbc4b7`](https://github.com/aoede3/taujs/commit/9bbc4b70ee9ab069bd8688338018cace9b753a2d) Thanks [@aoede3](https://github.com/aoede3)! - R0 gate-review fixes:

  - **Server:** the streaming render `onError` is the renderer's FATAL channel and is now trusted —
    benign classification uses ACTUAL request-abort state, not the shape (`code`/`name`/exact
    message) of an application-controlled error. This closes an origin-blind reclassification at the
    renderer/server join: a render/data failure that happens to look like a disconnect (e.g.
    `code: 'EPIPE'`, `name: 'AbortError'`, or the exact message `"aborted"`) now enters the failure
    path and is recorded, instead of being silently treated as a client disconnect.
  - **Renderers** (`@taujs/react` upstream, `@taujs/vue` byte-identical drift-copy): the shared UI
    logger is now NON-THROWING — formatting arbitrary `unknown` values (`BigInt`, circular objects,
    symbols, a throwing `toJSON`/`Symbol.toPrimitive`) and calls to a user-provided logger method are
    isolated, so a diagnostic on an error path can never break control flow. The stream controller
    additionally cleans up and settles `done` even if its logger throws. Together these make R0-03's
    always-on `warn`/`error` safe for arbitrary thrown values.

- [#15](https://github.com/aoede3/taujs/pull/15) [`caaa160`](https://github.com/aoede3/taujs/commit/caaa160636e807d7d495180e3284f80345d59323) Thanks [@aoede3](https://github.com/aoede3)! - R1-01: add the additive `onRenderError` render-error contract and propagate the request
  `AbortSignal` into route data resolution.

  - **`RenderErrorInfo` + `onRenderError`** are added to the exported `RenderCallbacks` contract. This
    is the advisory, NON-FATAL structured render-error channel (notably for post-shell boundary errors
    the renderer recovers client-side). The server wires it to the request logger at `warn` with a
    message keyed on `recoverable` (`phase`/`recoverable`/`clientRoot`/`url` as structured fields), so a
    recoverable render error is surfaced without being escalated to a fatal response and without
    double-logging a pre-shell error at `error` level (the fatal channel owns that). Callback-policy
    JSDoc documents which callbacks are fatal vs advisory.
  - **AbortSignal into data context.** The request `AbortController.signal` is now threaded into the
    data-resolution context for both the SSR and streaming branches, so loaders can observe client
    disconnects — proven end-to-end by a test that fires the streaming disconnect handler and asserts
    the loader's `ctx.signal.aborted` flips. Non-throwing error formatting on the logging path is
    preserved.

  `onRenderError` is OPTIONAL and non-breaking in either direction (unlike R0-01's `RenderStream`
  return-type change), so existing `RenderCallbacks` users are unaffected — `patch` per the R1-01
  changeset plan, keeping `@taujs/server` below 1.0.0.

- [#15](https://github.com/aoede3/taujs/pull/15) [`952afd0`](https://github.com/aoede3/taujs/commit/952afd04feaf990c256d493ea17c1b7236b4a9a7) Thanks [@aoede3](https://github.com/aoede3)! - R2-02 (SEC2): attribute-escape the bootstrap-module `src` at both server emission sites.

  A new server-local `escapeHtmlAttribute` (the server is renderer-agnostic and does not import the
  renderers' `escapeHtml`) now escapes the config-controlled bootstrap-module URL where it is
  interpolated into a `<script … src="…">` tag — the SSR-path tag in `HandleRender` AND
  `injectBootstrapModule` in `Templates` (used by the not-found path). Defence-in-depth: the value is
  config-controlled, so a normal module URL is unchanged; this closes the raw-attribute interpolation.
  `patch` per the versioning cap (no server major/minor for this).

## 0.9.1

### Patch Changes

- [#13](https://github.com/aoede3/taujs/pull/13) [`5ffd5b8`](https://github.com/aoede3/taujs/commit/5ffd5b8f938b12d27b5ec91a16003201c677fa49) Thanks [@aoede3](https://github.com/aoede3)! - Fix Vue streaming routes rendering the app twice in dev. The dev introspection stamp
  was written as the first child of `#root` (before the streamed app HTML), which Vue
  hydration reports as a node mismatch - it re-renders the whole app as a duplicate
  sibling of the server-rendered tree. The stamp now lands in `<head>` on the streaming
  path. React is unaffected either way (its hydration skips unexpected scripts) and was
  verified against both playgrounds; production HTML never carried the stamp. The ssr
  path (stamp after the app HTML, tolerated by both renderers) is unchanged.

## 0.9.0

### Minor Changes

- [#10](https://github.com/aoede3/taujs/pull/10) [`ff2db9a`](https://github.com/aoede3/taujs/commit/ff2db9aebfe3da2cd987dbfab6c8da0141150608) Thanks [@aoede3](https://github.com/aoede3)! - Export the render-contract types for framework renderer packages (V1-05):
  `RenderCallbacks`, `RenderSSR`, `RenderStream`, `RenderModule`, `RendererLogger`.
  Framework packages (e.g. `@taujs/vue`) can now type-check their `createRenderer(...)`
  output against `RenderModule` cast-free. `RenderStream`'s sink parameter is typed as a
  node `Writable` (which the server has always passed as a `PassThrough`, and both renderers
  have always consumed), and `opts.logger` on `RenderSSR`/`RenderStream` uses the new minimal
  `RendererLogger` structural type in place of the internal `Logs`. Additive and
  backward-compatible; the previously-unexported `StreamSink` type is removed.

## 0.8.0

### Minor Changes

- [#6](https://github.com/aoede3/taujs/pull/6) [`b82056a`](https://github.com/aoede3/taujs/commit/b82056a7667a06dd6dd64e9f3ca436221952242b) Thanks [@aoede3](https://github.com/aoede3)! - P0A-03: add `createRequestGraph(config, { source, emittedAt, serviceRegistry? })` — a pure, deterministic, no-I/O serialisation of the resolved config into request-graph schema v1: apps, routes (effective render/hydrate values with `defaulted` flags, specificity, conservative auth/CSP blocks, declared `data.kind`), services with declared param/result schema kinds and `usedBy` edges when a registry is supplied (`null` otherwise), security summary, fallthrough model, and a structured warnings registry. Declared route → service edges are read via the P0A-01/P0A-02 metadata accessors — no data handler is ever executed. Exported from the package root.

- [#6](https://github.com/aoede3/taujs/pull/6) [`c52b80b`](https://github.com/aoede3/taujs/commit/c52b80b72c13fc9acbd6b170f4bf7fbc24bbadc3) Thanks [@aoede3](https://github.com/aoede3)! - P0B-03: dev introspection files, overlay endpoints, and the `introspection` config surface. Dev boot now writes `node_modules/.taujs/dev.json` (bootId, per-boot token, pid, actual bound socket, artifact paths — removed on graceful close) and mirrors the in-memory rings to `traces.ndjson` / `logs.ndjson` / `observations.json` with atomic non-fatal writes. `/__taujs/graph|observations|traces` (plain + SSE) and `POST /__taujs/beacon` are registered only inside the structural dev gate, each enforcing loopback remote-address → Host validation (DNS-rebinding safe) → per-boot token, in that order. New public config: `introspection.allowNonLoopback` (relaxes only the remote-address check and shouts in the boot summary) and `introspection.redaction.denyKeys`/`replaceDefaultDenyKeys`.

- [#6](https://github.com/aoede3/taujs/pull/6) [`fb34d5f`](https://github.com/aoede3/taujs/commit/fb34d5f0d5ef2e2f121ac91ff219e8fa5c13150b) Thanks [@aoede3](https://github.com/aoede3)! - P0A-04: wire request-graph emission. Dev boot writes `node_modules/.taujs/graph.json` (`source: 'boot'`, registry-enriched) from a Fastify `onListen` hook — registered only inside the structural development gate via lazy dynamic import, so production never loads the introspection code at all. `taujsBuild` writes `dist/.taujs/graph.json` (`source: 'build'`, `services: null`) after successful builds. All artifact writes go through a shared `writeTaujsArtifact` helper: directory ensured, atomic tmp+rename, and non-fatal by contract — a failure warns once per boot and never breaks boot or build.

- [#6](https://github.com/aoede3/taujs/pull/6) [`2368d09`](https://github.com/aoede3/taujs/commit/2368d09619aa1b89d4f0fb9546b48925dde61526) Thanks [@aoede3](https://github.com/aoede3)! - P0A-01: add `createServiceData()` / `serviceData()` — typed sugar over the service-descriptor best practice. The returned handler is an ordinary async `DataHandler` that builds the `ServiceDescriptor` at request time (runtime dispatch through `fetchInitialData` is unchanged) and carries non-enumerable `{ serviceName, serviceMethod }` metadata readable via the internal `getServiceDataMetadata()` accessor, so tooling can see declared route → service edges without executing handlers. Exported from `@taujs/server/config` alongside `defineService`.

- [#6](https://github.com/aoede3/taujs/pull/6) [`6f557bd`](https://github.com/aoede3/taujs/commit/6f557bdd2fd49c1f4c5b4af9ec020933aebac7a1) Thanks [@aoede3](https://github.com/aoede3)! - P0B-01: trace context is now created in a shared `onRequest` hook (registered deliberately before the auth hook), so every request — rendered, fallthrough, or asset-like — has a `traceId` before route matching. Behaviour addition: fallthrough (client-rendered) responses now carry the `x-trace-id` response header, and fallthrough logs carry the request's trace context. Rendered-route behaviour is observably unchanged; `handleRender`/`handleNotFound` invoked without the hook (direct composition) behave exactly as before.

- [#6](https://github.com/aoede3/taujs/pull/6) [`0bf8d9b`](https://github.com/aoede3/taujs/commit/0bf8d9b7adec50ae1292f02971a3ba9b4407ced4) Thanks [@aoede3](https://github.com/aoede3)! - P0B-02: `TraceRecorder` interface (no-op default) with a dev-only ring-buffer assembler behind the structural gate. Rendered, fallthrough, failed, and aborted requests each assemble a trace record (200-trace ring) with URL hygiene — pathname + surviving query key names only, denylisted keys dropped entirely, values never stored. The request child logger is teed into a logs annex (2000-record ring, debug excluded, redaction-filtered meta), and observed service edges accumulate into an observations document (shapes deferred — the `serviceCall` event deliberately never carries result data). Recorder calls are synchronous fire-and-forget and safety-wrapped: a throwing recorder implementation warns once and never affects a response.

### Patch Changes

- [#6](https://github.com/aoede3/taujs/pull/6) [`f7035b6`](https://github.com/aoede3/taujs/commit/f7035b6e8b037e246e4a5c91c305ad30b58db81f) Thanks [@aoede3](https://github.com/aoede3)! - P0A-02: `defineService` now retains the declared schema shape of each normalised method as non-enumerable metadata — `{ params, result }`, each `{ declared, kind? }` where `kind` is `'parse' | 'function'` (the only distinction `NarrowSchema` honestly reveals; never claimed as "zod"). Bare-function and schemaless entries record `{ declared: false }`. Runtime behaviour is unchanged: `runSchema` dispatch, container freezing, and method identity are all as before; the metadata is readable only via the internal `getServiceMethodMetadata()` accessor (exported from `@taujs/server/config`), so tooling can see declared param/result schemas without executing handlers.

- [#6](https://github.com/aoede3/taujs/pull/6) [`bc98103`](https://github.com/aoede3/taujs/commit/bc981030836f811028518b0d2c471e3d04c1c5b9) Thanks [@aoede3](https://github.com/aoede3)! - P0B-04: dev boots stamp `window.__TAUJS_TRACE_ID__` + the per-boot token and inject the beacon script (nonce-aware) into rendered pages — alongside `__INITIAL_DATA__` on SSR, in the head write on streaming, and into the fallthrough shell, which has no data script to ride with. The script listens to `hydrateApp`'s internal events and POSTs `{ traceId, ok, ms?, error? }` to `/__taujs/beacon` once, with the token header. Present only when the structural dev gate holds; production HTML never carries any of it.

## 0.7.1

### Patch Changes

- [#2](https://github.com/aoede3/taujs/pull/2) [`5f0720c`](https://github.com/aoede3/taujs/commit/5f0720c30d6cf5e19ff453b060f784eaa3730428) Thanks [@aoede3](https://github.com/aoede3)! - Declare `picocolors` as a dependency. It is imported at runtime (logging, network, and server bootstrap) but was previously undeclared and resolved only via package hoisting — which fails under pnpm's strict `node_modules` layout and for consumers installing the package on its own.

v0.7.0 - 06/07/2026

fix: fastify is a peer dependency again
chore: constructible mocks use function implementations
fix: AppError identity survives duplicate class copies

v0.6.6 - 06/07/2026

fix: no success log when the auth decorator sends its own rejection
fix: CSP error path fails closed for routes that declared CSP
docs: state the auth enforcement boundary in the hook
chore: surface dropped duplicate plugins; tidy contract report; document SPA fallback
refactor: one route-specificity algorithm
fix: streaming commits status on first output, 500s on early failure
fix: no dev-grade CSP fallback in production
fix: fail boot when SSRServer registration throws
fix: asset short-circuit tests the pathname, not the full URL
fix: restore stem semantics for defaultEntryClient
fix: per-request CSP nonce; never mutate shared directives

v0.6.5 - 29/06/2026

chore(deps): bump vite from 7.3.2 to 7.3.6
chore(deps-dev): bump @babel/core from 7.28.5 to 7.29.7
chore(deps-dev): bump form-data from 4.0.5 to 4.0.6
chore(deps-dev): bump vitest, @vitest/coverage-v8 and @vitest/ui
feat: aligning alias / baseClientRoot

v0.6.4 - 10/05/2026

chore(deps): bump fast-uri from 3.1.0 to 3.1.2
chore(deps): bump postcss from 8.5.6 to 8.5.14

v0.6.3 - 16/04/2026

chore(deps): bump @fastify/static from 8.3.0 to 9.1.3

v0.6.2 - 16/04/2026

chore(deps): bump fastify from 5.8.3 to 5.8.5
chore(deps): bump fastify from 5.6.1 to 5.8.5

v0.6.1 - 05/04/2026

chore(deps): bump vite from 7.3.1 to 7.3.2

v0.6.0 - 05/04/2026

feat: type augmentation
feat: type augmentation prettier

v0.5.9 - 05/04/2026

chore(deps): bump fastify from 5.7.3 to 5.8.3
chore(deps): bump brace-expansion
chore(deps): bump path-to-regexp from 8.3.0 to 8.4.0
chore(deps-dev): bump flatted from 3.3.3 to 3.4.2
chore(deps-dev): bump picomatch from 2.3.1 to 2.3.2

v0.5.8 - 27/02/2026

chore(deps): bump rollup from 4.53.3 to 4.59.0
chore(deps): bump ajv from 8.17.1 to 8.18.0
chore(deps): bump fastify from 5.6.2 to 5.7.3
chore(deps): bump @isaacs/brace-expansion from 5.0.0 to 5.0.1
chore(deps): bump minimatch

v0.5.7 - 22/01/2026

feat: consolidate template utilities
chore: consolidate template utilities - formatting

v0.5.6 - 14/01/2026

feat: streaming vite plugins; hmr; tests
chore: update packages

v0.5.5 - 11/01/2026

feat: remove resolve route data

v0.5.4 - 04/01/2026

feat: core
feat: core tests
feat: logging, constants
feat: logging, constants, resolver
feat: core orchestration
feat: build / asset management; tests
feat: core types

v0.5.3 - 29/12/2025

feat: rename \_\_taujs/data to \_\_taujs/route as explicit route data contract

v0.5.2 - 19/12/2025

feat: align streaming ownership boundary to template

v0.5.1 - 17/12/2025

feat: plugin alignment
feat: .ts, .tsx file extensions for entry points

v0.5.0 - 11/12/2025

feat: update path resolution

v0.4.9 - 03/12/2025

feat: static assets dev/prod; default paths, prod serving

v0.4.8 - 02/12/2025

feat: build types readonly

v0.4.7 - 01/12/2025

test: RouteContext streaming test
feat: RouteContext; tests

v0.4.6 - 25/11/2025

chore: update packages; clean
feat: remove FastifyStatic dependancy; test

v0.4.5 - 24/11/2025

feat: serviceRegistry change to optional; tests
feat: Build isolated app; tests
test: Logger coverage in hasMeta

v0.4.4 - 23/11/2025

feat: logger wrap strings; tests

v0.4.3 - 23/11/2025

feat: ctx.call functionality
feat: Logging fixes for logging: false; Updates to abort logging
feat: Build system; user vite configuration; ssr manifest isolation; tests
feat: render logging; barrel exports; tests
feat: RouteData; \_\_taujs/data route; tests
feat: align HandleRender / Logger; tests

v0.4.2 - 04/11/2025

feat: CSP reporting
feat: auth routeMeta; decorator
feat: Logger; silent Pino
feat: ServiceDescriptor standardisation
feat: CSP plugin cleanup; test
feat: DataServices cleanup; test
test: CreateServer coverage

v0.4.1 - 25/10/2025

feat: Focus on Pino as first class logger; associated files, tests
feat: Add friendly attr.data error; suppress duplicate errors when already logged by component
feat: tightening api surface
chore: update vite-plugin-node-polyfills
feat: static asset registration; tests

v0.4.0 - 20/10/2025

chore: update vite
chore: update packages vite; vitest; tests
feat: HandleNotFound logger
feat: onHead raw.write callback return
chore: sorting import hierarchy
feat: csr rendering; tests
chore: package updates
feat: Associated file updates; tests; project details
feat: Associated file updates; tests; project details
feat: Logger; AppError, Parser; associated file updates
feat: Logger; associated file updates
feat: csp routes; observability
feat: createConfig; network; banner; debug
feat: CreateServer; logging; verification; startup; types
feat: Logging / Telemetry
feat: file splitting; optimisation
feat: file splitting; optimisation
feat: data; services, schema addition

v0.3.7 - 16/08/2025

chore(deps): bump tmp and @changesets/cli
feat: csp test types
feat: csp updates; plugin; tests

v0.3.6 - 22/07/2025

chore(deps-dev): bump form-data from 4.0.3 to 4.0.4

v0.3.5 - 16/07/2025

sec: env; remove await; tests

v0.3.4 - 16/07/2025

sec: fastify dependencies static

v0.3.3 - 16/07/2025

sec: fastify dependencies

v0.3.2 - 15/07/2025

sec: fetch network access; typing; tests
feat: rename fetch to data
sec: fetch network access; types

v0.3.1 - 10/07/2025

feat: url matching; test; cleanup

v0.3.0 - 10/07/2025 - Orchestration Foundations

- Introduced middleware as an orchestration-layer primitive
- Added attribution notice and clarified τjs [ taujs ] system scope
- Consolidated route and config handling under `taujs.config.ts`
- Moving toward a formal build-time orchestration model

feat: middleware intro; auth; tests; cleanup
feat: taujs.config
feat: selective hydration; types; constants; tests
feat: attribution

v0.2.9 - 08/07/2025

feat: middleware intro; auth; tests; cleanup

v0.2.8 - 07/07/2025

feat: taujs.config
feat: selective hydration; types; constants; tests

v0.2.7 - 05/07/2025

feat: SSRServer clean up typing
feat: utils; service method typing
test: utils service method coverage

v0.2.6 - 03/07/2025

feat: Security csp dev standard

v0.2.5 - 03/07/2025

feat: Security csp
test: Security csp
test: build
feat: Security csp

v0.2.4 - 01/07/2025

feat: service typing; cleanup

v0.2.3 - 30/06/2025

feat: Integrate build; tsup config; clean up package.json;
chore: update to node 22.17.0
feat: defer dynamic module injection

v0.2.2 - 17/06/2025

chore(deps): bump brace-expansion from 2.0.1 to 2.0.2

v0.2.1 - 10/07/2025

feat: split renderer to own package
chore: update vite 6.3.5

v0.2.0 - 09/07/2025

chore: update vite 6.3.5

v0.1.9 - 09/07/2025

test: Vite createViteRuntime -> ssrLoadModule
chore: Update Fastify 5.2.0 --> 5.3.3
feat: Introducing picolors and associated messaging
chore: Update Vite 5.4.2 -> 6.3.5

v0.1.8 - 24/01/2025

chore(deps-dev): bump vite from 5.4.7 to 5.4.14
chore(deps-dev): bump vite from 5.4.7 to 5.4.14 - release

v0.1.7 - 19/12/2024

chore: Update React to v19 + associated packages

v0.1.6 - 17/12/2024

chore: Update Fastify + associated packages

v0.1.5 - 12/12/2024

feat: Micro-frontend; processConfigs utill; testing; CHANGELOG; README
feat: Micro-frontend; testing; utils
feat: Micro-frontend; server orchestration; utility alignment

v0.1.4 - 02/12/2024

fix: ssr css and preload links in header

v0.1.3 - 22/22/2024

chore(deps): bump cross-spawn and @changesets/cli
chore: Update README; cleanup debug

v0.1.2 - 08/11/2024

release: 0.1.2; type change; audit, cleanse; ReadMe update

v0.1.1 - 31/10/2024

feat: SSRHydration createRoot + hydrateRoot; tests; vite css modern; clearup

v0.1.0 - 31/10/2024

fix: fastify dependency change to 4.28.1 compatibililty between static/compress

v0.0.9 - 31/10/2024

Merge branch 'integrate-spa-ssr' Integrated @taujs/server SPA, SSR, Streaming SSR, SSRDataStore; Hydration

v0.0.8 - 03/10/2024

Merge branch 'integrate-hydration' SSRHydration; Logger; updated build, package

v0.0.7 - 23/09/2024

Optional 'alias' on plugin registration
CI @testing-library/dom for 'screen'

v0.0.6 - 21/09/2024

Fastify upgrade 4.28.0 to 5.0.0; test suite; cleanup

v0.0.5 - 12/09/2024

path-to-regex upgrade 7.0.0 to 8.1.0
path-to-regexp outputs backtracking regular expressions - https://github.com/advisories/GHSA-9wv6-86v2-598j

v0.0.4 - 08/09/2024

SSRRender readme

v0.0.3 - 08/09/2024

SSRRender; tsup config

v0.0.2 - 08/09/2024

Custom alias

v0.0.1 - 07/09/2024

Initial taujs-server
