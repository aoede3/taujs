---
"@taujs/server": minor
"@taujs/react": minor
---

ESC-1: managed compiler-plugin scoping for multi-framework apps

`@taujs/server` gains an additive config surface. An app's `plugins` array may now
carry an opaque managed compiler contribution alongside ordinary Vite plugins, and a
renderer-neutral host pre-pass constructs correctly-scoped framework compilers so
React and Solid apps compose in one project without cross-framework contamination.
A fail-closed ownership diagnostic hard-errors on ambiguous ownership (a file claimed
by two compilers, or one compiled by none) before Vite builds. Vue remains an
ordinary raw plugin and coexists unaffected. The new `@taujs/server/config` exports
are a first-party integration contract - only `TaujsManagedPluginContribution` is
stable; the rest are unstable and versioned by the brand.

`@taujs/react` gains `scopedPluginReact({ project })`, a managed contribution whose
ownership is derived from the given tsconfig project. `pluginReact()` is unchanged
for single-framework/standalone use, but now attaches a non-enumerable tag so the
host can detect a raw compiler running chain-globally alongside managed ownership.
