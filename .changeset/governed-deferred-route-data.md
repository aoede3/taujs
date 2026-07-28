---
'@taujs/server': minor
'@taujs/react': minor
'@taujs/vue': minor
'@taujs/solid': minor
---

RFC 0007 - governed deferred route data.

A `render: 'streaming'` route can now declare response-owned work that may complete after
rendering begins, beside the critical `attr.data` snapshot:

```ts
{
  path: '/products/:id',
  attr: {
    render: 'streaming',
    meta: {},
    data: serviceData('catalogue', 'product', ({ id }) => ({ id })),
    deferred: {
      reviews: serviceData('reviews', 'forProduct', ({ id }) => ({ id })),
    },
  },
}
```

The host starts each named loader exactly once per request, outside the component tree, after
route policy has accepted the request. The selected renderer projects the named promise onto its
own Suspense/resource primitive, so late boundary HTML arrives through the framework's own
streaming and patch mechanism - τjs owns no patch protocol, exposes no browser data runtime and
issues no client refetch. Hydration is seeded from the existing end-of-stream write site.

**`@taujs/server`**

- `attr.deferred` on the streaming arm only, with boot hard errors for an `ssr` route, a
  non-plain-object record, a non-function entry and a key failing `^[A-Za-z][A-Za-z0-9_]*$`.
- `DeferredDataOf` and `DeferredDataAttributes` exported from `@taujs/server/config`, so a
  component-facing accessor is typeable from `typeof route` with no re-declared payload shape.
- A settled entry is a stable snapshot: one serialisation attempt at settlement, whose retained
  bytes are what the renderer, the trace and the hydration seed all describe. A value that cannot
  cross that boundary is detail-free `failed` everywhere, with one payload-free operator warning.
- The request graph gains an optional per-route `deferred` array and its `usedBy` contribution;
  traces gain a per-key `deferredData` outcome. Both are additive within schema v1, and a late
  outcome reaches the on-disk trace artefact. No new MCP tool.

**`@taujs/react`, `@taujs/vue`, `@taujs/solid`**

- React and Vue: `useDeferredData`, `useDeferredDataResult`, `createDeferredAccessor`,
  `DeferredDataError`, `DeferredResult`.
- Solid: `useDeferredData`, `createDeferredAccessor`, `DeferredDataError`, `DeferredAccessor` -
  its engine has real server-side error boundaries, so the throwing read already completes the
  response and no result accessor is needed.
- Each package gains one response-level `streamOptions.deferredTimeoutMs` deadline: positive
  finite only, validated at renderer construction, defaulting to 15000ms.

Routes that declare no `deferred` are unchanged, byte for byte.
