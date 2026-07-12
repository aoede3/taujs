---
'@taujs/react': patch
---

R3-05 (Q6): client bundles no longer include `react-dom/server`. The dist previously shipped as a
single module whose top-level imports coupled the SSR renderer into the client entry, so every
production browser bundle of `import { hydrateApp } from '@taujs/react'` retained react-dom's CJS
browser server build (measured: -49% raw / -48% gzip after the fix, with `react-dom/server`
provably absent from the module graph). The dist now preserves the source module graph (explicit
`.js` specifiers + unbundled build); the public API, exports map, and `create-taujs` scaffold are
unchanged - no consumer migration needed. Durable guards added: a module-graph absence test that
builds a real production browser bundle, and a specifier-extension lint test. Also documents the
official `useSyncExternalStore` suspension caveat on `useSSRStore` (R3-03 §0).
