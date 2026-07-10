---
"@taujs/server": minor
---

Export the render-contract types for framework renderer packages (V1-05):
`RenderCallbacks`, `RenderSSR`, `RenderStream`, `RenderModule`, `RendererLogger`.
Framework packages (e.g. `@taujs/vue`) can now type-check their `createRenderer(...)`
output against `RenderModule` cast-free. `RenderStream`'s sink parameter is typed as a
node `Writable` (which the server has always passed as a `PassThrough`, and both renderers
have always consumed), and `opts.logger` on `RenderSSR`/`RenderStream` uses the new minimal
`RendererLogger` structural type in place of the internal `Logs`. Additive and
backward-compatible; the previously-unexported `StreamSink` type is removed.
