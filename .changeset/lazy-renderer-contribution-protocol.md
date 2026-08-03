---
'@taujs/server': minor
'@taujs/react': minor
'@taujs/vue': minor
'@taujs/solid': minor
---

BREAKING: the renderer contribution protocol becomes lazy-only v2. `@taujs/server` and the
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
