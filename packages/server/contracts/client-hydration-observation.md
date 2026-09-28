# Client hydration observation

Contract id: `server:client-hydration-observation`. Owner: `@taujs/server` (this document's
version is the installed package's version).

Participants: `@taujs/server` owns the observation and its episode field. `@taujs/react`,
`@taujs/vue` and `@taujs/solid` are standard producers. `@taujs/html` does not hydrate and is
outside the producer path.

## How the client report is produced

On a development boot, the host stamps the page with its request ID, the per-boot token and a
devtools hook. The hook records `hydration:start`, then sends at most one report to the
base-path-aware `POST /__taujs/beacon` endpoint when it receives `hydration:success` or
`hydration:error` ([stamp implementation](../src/utils/Templates.ts#L257)).

The React, Vue and Solid `hydrateApp` adapters emit those events on their hydration paths. A CSR
fallback emits no hydration events: it is a client mount, not hydration. A route with
`hydrate: false` receives no client bootstrap module, so no standard adapter runs. HTML has no
hydration adapter and emits no report. The presence of the stamped hook therefore does not prove
that hydration ran ([host bootstrap gate](../src/utils/HandleRender.ts#L195),
[React CSR cell](../../react/src/test/HydrationBeacon.test.tsx#L87),
[Vue adapter contract](../../vue/src/SSRHydration.ts#L47),
[Solid CSR cell](../../solid/src/test/SSRHydration.test.ts#L145), and
[HTML client boundary](../../html/src/client.ts#L1)).

## How an accepted report amends an episode

The endpoint first applies the development guards, then requires JSON with a safe `requestId` and
a boolean `ok`. It returns `204` without amendment for an unknown or evicted episode and `409` for
a duplicate. Only the first valid report for a retained episode reaches the recorder
([endpoint implementation](../src/core/introspection/DevEndpoints.ts#L75),
[beacon implementation](../src/core/introspection/DevEndpoints.ts#L163), and
[endpoint cell](../src/core/introspection/test/DevEndpointsFiles.test.ts#L287)).

The recorder may amend either a pending episode or a finalised episode still in the retained ring;
it does not require a particular request outcome. It stores `hydrated`, optional elapsed time and
the capped client error, and marks a finalised episode dirty so the bounded on-disk mirror is
rewritten. A non-null `client` therefore means that one report was accepted and recorded;
`client.hydrated` says whether the reported hydration succeeded
([recorder implementation](../src/core/introspection/DevIntrospection.ts#L359),
[late-amendment cell](../src/core/introspection/test/DevIntrospection.test.ts#L135), and
[persistence cell](../src/core/introspection/test/DevIntrospection.test.ts#L183)).

## What client null means

`client: null` means:

> This persisted episode snapshot contains no accepted hydration report.

It does not establish why. The browser may not have run, hydration may have been disabled, the
adapter may have taken its CSR fallback, or a report may be absent, refused, lost or late. Null is
also the expected value for an HTML application. Conversely, a non-null value records an accepted
observation, not necessarily a success; read its `hydrated` and `error` fields for that outcome
([episode default](../src/core/introspection/DevIntrospection.ts#L225)).

`taujs_get_episode` reads the `episodes.ndjson` mirror rather than the in-memory ring. By default,
the server rewrites that mirror on a 500 ms polling interval when the episode revision changes, so
an accepted report can first appear on a later read
([mirror implementation](../src/core/introspection/DevFiles.ts#L11) and
[MCP reader](../../mcp/src/SubstrateReader.ts#L311)).
