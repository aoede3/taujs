---
'@taujs/server': minor
---

RFC 0004 (H1): routes may declare `attr.head = { data, timeoutMs?, optional? }` - a dynamic head
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
