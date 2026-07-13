---
'@taujs/react': minor
---

RFC 0004 (H2): `headContent` receives the route's resolved `attr.head` payload as
`headData?: H` on BOTH strategies - streamed pages get dynamic `<head>` data for the first time.
`createRenderer` gains a defaulted third generic (`createRenderer<T, R, H>`; every existing call
site compiles unchanged) and `HeadContext` gains the optional `headData` field beside the
untouched `data: T` (whose semantics are identical to before on both strategies). `headData` is
optional in the type by contract: `undefined` when the route declares no `attr.head` and when the
head loader degraded under the server's signed policy - handle it (typically by falling back to
`meta`). Escape `headData`-derived values with `escapeHtml` like any other dynamic head value.

Contract regularisation: the render functions' contract-facing parameter types are now
honestly BROAD (`Record<string, unknown>` data/headData, `unknown` routeContext) with one
documented internal narrowing seam per value - a renderer instantiated with NON-default generics
is now provably assignable to `@taujs/server`'s contracts under strictFunctionTypes, pinned by a
new non-default conformance type test (the previous default-only test masked this gap). App-facing
typing is unchanged or better: callbacks stay fully narrow-typed via the generics.
