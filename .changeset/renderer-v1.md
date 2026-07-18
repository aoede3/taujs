---
"@taujs/server": minor
"@taujs/react": minor
"@taujs/vue": minor
---

Renderer v1: declare an app's framework with a required singular `renderer:`

Every app now declares a REQUIRED singular `renderer:` - an opaque contribution from
`reactRenderer({ project })` (`@taujs/react/renderer`), `vueRenderer()`
(`@taujs/vue/renderer`), or `solidRenderer({ project })` (`@taujs/solid/renderer`,
compiler-only for now). The `plugins` array returns to meaning ordinary Vite plugins
only. React and Solid coexist safely on one Vite dev server by construction (the host
computes each framework's scope after seeing all apps and constructs correctly-scoped
compilers, with a fail-closed ownership diagnostic); Vue is a first-class renderer that
supplies its `pluginVue` pack fresh per environment without ownership machinery. Every
render module is identity-validated against its declared renderer (both `renderSSR`
and `renderStream` are brand-checked - at boot in production, after `ssrLoadModule` in
development) with a hard error and migration guidance on a mismatch.

The shared render-options bag is now a named `RenderOptions` on both `renderSSR` and
`renderStream`, carrying `cspNonce` (authoritative; the positional stream argument is
removed) and the host-resolved `shouldHydrate`.

Migration:
- Replace `plugins: [pluginReact()]`/`plugins: [pluginVue()]`-style framework wiring with
  `renderer: reactRenderer({ project: './tsconfig.json' })` / `renderer: vueRenderer()`.
- `scopedPluginReact()`/`scopedPluginSolid()` are removed; use the renderer factories.
- Raw `pluginReact()`/`pluginSolid()`/`pluginVue()` remain exported and portable for
  plain-Vite/standalone use.
- Entry-server files are unchanged: `createRenderer(...)` now brands its returned
  functions so the host can validate framework identity.
- If you consume `renderStream` directly, pass `cspNonce` via `opts.cspNonce` instead of
  the removed positional argument.
