---
'@taujs/server': patch
---

When no app matches the build filter, or an app's Vite build or pre-build cleanup fails inside the build loop, `taujsBuild` now sets `process.exitCode = 1` and returns instead of calling `process.exit(1)`. `process.exit` discards what a piped stderr has not yet flushed, so a long diagnostic under CI or `pnpm -r build` was cut at 64 KiB. A failure in the loop also names the apps not attempted, in build order. Failures before the loop body's try (entry resolution, `vite` callbacks, plugin composition) still reject as before.

A failed build emits no new graph. An existing `dist/.taujs/graph.json` is left as it was wherever the build mode preserves `dist` (SSR and filtered builds); an unfiltered client build removes `dist` before building, as it always has, so no previous graph survives a failure there.
