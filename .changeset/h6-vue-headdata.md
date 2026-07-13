---
'@taujs/vue': minor
---

RFC 0004 (H6, adoption signed): `headContent` receives the route's resolved `attr.head` payload
as `headData?: H` - vue's single, pre-render head build (timing unchanged, by design) can now see
dynamic data on BOTH strategies, closing the gap where the renderer-agnostic `attr.head` route
config was silently dead on vue. `createRenderer` gains a defaulted third generic
(`createRenderer<T, R, H>`; existing call sites compile unchanged) and `HeadContext` gains the
optional `headData` field beside the untouched `data: T`. `headData` is `undefined` when the
route declares no `attr.head` and when the head loader degraded under the server's signed
policy, so handle it (typically by falling back to `meta`); escape `headData`-derived values
with `escapeHtml`.

Contract regularisation (the react H2 model): the render functions' contract-facing parameter
types are now honestly broad with documented internal narrowing seams, and the conformance type
test additionally instantiates NON-default generics - closing vue's own latent
strictFunctionTypes assignability gap that the default-only test masked.
