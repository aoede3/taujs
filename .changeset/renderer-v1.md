---
"@taujs/server": minor
"@taujs/react": minor
"@taujs/vue": minor
---

Renderer v1: declare an app's framework with a required singular `renderer:`

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
