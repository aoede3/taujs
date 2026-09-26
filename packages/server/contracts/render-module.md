# Render module seam

Contract id: `server:render-module`. Owner: `@taujs/server` (this document's version is the
installed package's version).

Participants: `@taujs/react`, `@taujs/vue`, `@taujs/solid`, `@taujs/html`.

Evidence labels: **implementation** means production code; **cell** means a test assertion. The
shared interface is the [`RenderModule` declaration](../src/types.ts#L244).

## One response, one renderer

The host selects one `RenderModule` for the application and request. The module exposes
`renderSSR` and `renderStream`; the route selects which one the host calls. This is a server
boundary, not a shared component API. Renderer packages keep their framework-specific component,
hydration and deferred-data primitives ([implementation](../src/utils/HandleRender.ts#L480)).

The shared types are the authority for arguments and host-visible results:

- `renderSSR` receives resolved critical data, location, metadata, the request signal and
  `RenderOptions`. It resolves to `{ headContent, appHtml }` ([type](../src/types.ts#L194)).
- `renderStream` receives a Node `Writable`, callbacks, critical data as an object, promise or
  thunk, location, an optional client entry, metadata, the request signal and `RenderOptions`.
  It returns `{ abort, done }` ([type](../src/types.ts#L209)).
- `headData` is supplied only after host head-data resolution and only when it resolved to a
  value ([host implementation](../src/utils/HandleRender.ts#L868)). `deferredData` is supplied only
  when the route declares entries. Those promises were already started and observed by the host.
  A renderer must not start them again ([host implementation](../src/utils/HandleRender.ts#L763)).
- `shouldHydrate` is the host's resolved policy. The host also passes a client entry only when
  that policy permits it. A renderer must not infer policy from the presence of that entry.
  `cspNonce`, when present, is the request nonce for renderer-owned markup and scripts
  ([type](../src/types.ts#L166), [host call](../src/utils/HandleRender.ts#L988)).

The host consumes only `headContent` and `appHtml` from SSR. Some renderer implementations return
additional fields, including `aborted`; these are not part of `RenderSSR` and the host does not
rely on them. The request signal is the host-visible cancellation input
([SSR call](../src/utils/HandleRender.ts#L494), [stream call](../src/utils/HandleRender.ts#L994)).

## Streaming callback and terminal rules

The host supplies `onHead`. It must be treated as the response-head handoff: invoke it before
writing any application-body bytes. If it throws, stop rendering and take the fatal path. The
callback is optional in the TypeScript shape because renderer methods can be called directly, but
it is operationally required for host integration: the host uses it to compose the document head
and connect the renderer sink ([host callback](../src/utils/HandleRender.ts#L893),
[HTML order cell](../../html/src/test/Streaming.test.ts#L13)).

`onShellReady` and `onAllReady` are advisory notifications. A throw from either is isolated and
must not make a successful stream fatal or suppress a sibling notification. `onAllReady` carries
the resolved critical data used by the host's initial-data envelope. It does not mean that every
renderer has reached the same native rendering milestone or that all deferred entries succeeded.
Callbacks may not fire when the stream aborts or fails before reaching their stage.

This split is fixed by the [shared callback types](../src/types.ts#L104) and renderer cells listed
below.

`onError` is the fatal stream channel. A fatal renderer error rejects `done` with the original
error; the renderer claims that terminal before calling `onError`, and an exception thrown by the
callback must not change the terminal or escape as an unhandled event-listener exception. The
renderer observes `done` internally so ignoring it does not create an unhandled rejection. A
consumer that needs the fatal error must still observe `done` or use `onError`.

The handle semantics are declared in [`RenderStreamHandle`](../src/types.ts#L209) and exercised by
the HTML [fatal](../../html/src/test/Streaming.test.ts#L94) and
[abort](../../html/src/test/Streaming.test.ts#L173) cells.

`onRenderError` is a separate advisory observation implemented by React. It never decides
fatality. React reports the observed phase; `post-shell` is recoverable by the client boundary,
while `pre-shell` remains `unknown` until a fatal channel resolves the response outcome. Vue,
Solid and HTML do not currently emit this callback. Its presence in the shared callback type does
not promise a renderer-independent render-error event.

React's behaviour is pinned by its
[structured-error cells](../../react/src/test/SSRRender.integration.test.tsx#L283); Solid's
deliberate absence is pinned separately ([cell](../../solid/src/test/SSRRender.test.ts#L399)).

The server considers a streaming document committed when its first byte is yielded to Fastify,
not when `onHead` runs. A fatal before that byte can become an HTTP error response. A fatal after
commit cannot replace the status or bytes already sent, so the host terminates delivery. A client
disconnect is benign when observed through the request signal or writable/socket guards; an
application error is not benign because its name, code or message resembles a disconnect.

The distinction is pinned by the [live-request fatality cells](../src/utils/test/HandleRender.test.ts#L1493)
and a [real disconnect cell](../src/utils/test/HandleRenderDeferred.test.ts#L326). Pre- and
post-commit delivery are pinned separately by the
[pre-byte failure cell](../src/utils/test/HandleRender.test.ts#L1539) and
[post-byte failure cell](../src/utils/test/HandleRender.test.ts#L1640).

If `abort()` or the request signal wins while a stream is active, the renderer performs benign
termination and `done` resolves. A fatal terminal that already won remains fatal. An already-aborted
signal may cause the renderer to return a resolved handle without rendering or callbacks. This is
an adapter terminal guarantee, not a promise that every framework stops its internal computation
immediately. The host owns request cancellation, response teardown and the HTTP outcome.

See the [host abort wiring](../src/utils/HandleRender.ts#L760) and the renderer cells below.

## Intentional renderer differences

The common seam does not impose byte parity or identical internal event timing.

| Difference               | Renderer | Contract treatment                                                                                                                                                   | Evidence kind and cell                                                                                                             |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Deferred delivery        | React    | Suspense reads stream out of order; the deadline expires pending reads and asks React to complete those boundaries on the client.                                    | cell: [SSRDeferredData.stream.test.tsx](../../react/src/test/SSRDeferredData.stream.test.tsx#L462)                                 |
| Deferred delivery        | Vue      | Async setup streams in order; expiry settles consumed pending reads as `aborted` and the application renders that branch.                                            | cell: [SSRDeferredData.stream.test.ts](../../vue/src/test/SSRDeferredData.stream.test.ts#L307)                                     |
| Deferred delivery        | Solid    | Solid resources use native `$df` streaming; expiry abandons pending reads through the application's error boundary.                                                  | cell: [SSRDeferredData.test.ts](../../solid/src/test/SSRDeferredData.test.ts#L286)                                                 |
| Deferred delivery        | HTML     | There is no component or Suspense tree. HTML observes the promises and waits for settlement or deadline unless hydration is disabled.                                | cells: [settlement](../../html/src/test/DeferredData.test.ts#L16), [deadline](../../html/src/test/DeferredData.test.ts#L56)        |
| Head and shell timing    | React    | The [shell-ready implementation](../../react/src/SSRRender.tsx#L699) invokes `onHead` before piping and host `onShellReady`; throwing `onHead` prevents body output. | cell: [SSRRender.integration.test.tsx](../../react/src/test/SSRRender.integration.test.tsx#L424)                                   |
| Head and shell timing    | Vue      | The [implementation](../../vue/src/SSRRender.ts#L558) delivers head before starting Vue's stream; host `onShellReady` marks the first body chunk.                    | cell: [SSRRender.test.ts](../../vue/src/test/SSRRender.test.ts#L262)                                                               |
| Head and shell timing    | Solid    | The [shell-complete implementation](../../solid/src/SSRRender.ts#L698) invokes `onHead` before `onShellReady`; final data also waits for Solid completion.           | cells: [head timing](../../solid/src/test/SSRRender.test.ts#L548), [completion latch](../../solid/src/test/SSRRender.test.ts#L187) |
| Head and shell timing    | HTML     | Critical data and application render finish first, then `onHead`, `onShellReady`, body output and `onAllReady` occur in order.                                       | cell: [Streaming.test.ts](../../html/src/test/Streaming.test.ts#L13)                                                               |
| Structured render errors | React    | Emits advisory `onRenderError` observations with pre- or post-shell phase.                                                                                           | cell: [SSRRender.integration.test.tsx](../../react/src/test/SSRRender.integration.test.tsx#L283)                                   |
| Structured render errors | Vue      | Its callback surface has no `onRenderError`; fatal errors use `onError`.                                                                                             | typecheck only: [RenderCallbacks](../../vue/src/SSRRender.ts#L16)                                                                  |
| Structured render errors | Solid    | Deliberately does not emit `onRenderError`; fatal errors use `onError`.                                                                                              | cell: [SSRRender.test.ts](../../solid/src/test/SSRRender.test.ts#L399)                                                             |
| Structured render errors | HTML     | Its callback surface has no `onRenderError`; fatal errors use `onError`.                                                                                             | typecheck only: [RenderCallbacks](../../html/src/SSRRender.ts#L79)                                                                 |

All four adapters use one response-level deferred deadline. React, Vue and Solid release their
renderer-owned deferred holders on terminal paths, covered by the React
[mutation-checked cell](../../react/src/test/SSRDeferredData.release.test.tsx#L20), Vue
[cell](../../vue/src/test/SSRDeferredData.stream.test.ts#L351), and Solid
[cell](../../solid/src/test/SSRDeferredData.test.ts#L375). HTML has no framework holder and observes
the promises directly, as its settlement cell in the table shows.

The host separately owns the authoritative deferred outcome envelope and releases its own registry.
Renderer-native behaviour after a deferred failure or deadline is not interchangeable; consumers
should use the host envelope for the stable outcome (`complete`, `failed` or `aborted`), not infer
it from framework markup. The stable envelope is covered by the
[host deferred cells](../src/utils/test/HandleRenderDeferred.test.ts#L1); each renderer deadline is
covered by the deferred-delivery cells in the table.
