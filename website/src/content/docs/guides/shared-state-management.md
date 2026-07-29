---
title: Shared State Management
description: How code, browser state and server state cross τjs application boundaries
---

A τjs application owns one browser runtime for the current document. Navigating to another configured
application starts another document and another runtime. The applications may import the same source
code, but they do not share an in-memory store instance.

Start by separating four concerns:

| Concern | Scope | Suitable mechanism |
| --- | --- | --- |
| Shared implementation | Build time | Shared module or workspace package |
| Ephemeral UI state | Current application document | Framework-native store or component state |
| Non-sensitive preference | Browser profile | `localStorage` or another browser store |
| Authoritative or sensitive state | User/session/server | Secure session plus database or service |

## Shared code is not shared memory

A utility imported by two applications is built into both application graphs:

```ts
// src/shared/preferences.ts
export type ColourScheme = "light" | "dark";

export function readColourScheme(): ColourScheme {
  const stored = localStorage.getItem("colour-scheme");
  return stored === "dark" ? "dark" : "light";
}

export function writeColourScheme(value: ColourScheme): void {
  localStorage.setItem("colour-scheme", value);
}
```

Both applications can use the same storage key and rules, but each creates its own state objects and
reads the persisted value when it starts. Updating an in-memory store in one application does not
update another application that is not currently running.

Keep shared code framework-neutral when applications use different renderers. React hooks, Vue
composables and Solid signals are reusable only within compatible applications; schemas, contracts,
design tokens and plain functions cross renderer boundaries more cleanly.

## Browser persistence

Browser storage is useful for non-sensitive preferences such as colour scheme, locale, dismissed UI
notices or table density.

Treat it as untrusted input:

- validate values when reading them
- namespace keys and version stored shapes
- tolerate storage being unavailable
- do not store access tokens, session identifiers or authoritative permissions there
- do not rely on a browser storage event as a security or consistency boundary

A normal document navigation gives the destination application a chance to read the latest value.
If two applications are simultaneously open in different tabs, browser storage events can improve UI
freshness, but the server remains the authority for important state.

## Sessions and authoritative state

Credentials belong in the host's authentication layer, normally using Secure, HttpOnly and SameSite
cookies or another server-controlled mechanism. Client code should not need to read a session token
in order to share state.

For identity-dependent route data, validate the request through application-owned code using the
trusted request headers available to the handler:

```ts
async function loadPreferencesForRequest(headers: Record<string, string>) {
  const session = await verifySession(headers);

  if (!session) {
    throw new Error("Authentication required");
  }

  return preferencesRepository.findForUser(session.userId);
}

const preferencesData = async (_params, ctx) => ({
  preferences: await loadPreferencesForRequest(ctx.headers ?? {}),
});
```

This example keeps credential interpretation in server code and returns only the preference data the
page needs. Do not put credentials or unnecessary identity records into initial or deferred data.

A protected τjs route still runs the Fastify `authenticate` decorator before rendering. That
decorator may attach `req.user` for Fastify hooks and handlers, but τjs does not currently copy
`req.user` into the route data context or populate `ServiceContext.user` automatically. See
[Authentication](/guides/authentication/#identity-in-route-data-and-services).

## Critical route data

`attr.data` resolves before rendering and seeds the selected application for that response:

```ts
{
  path: "/account",
  attr: {
    render: "ssr",
    data: async (_params, ctx) => ({
      preferences: await loadPreferencesForRequest(ctx.headers ?? {}),
    }),
  },
}
```

Use critical data when the result can redirect, determine HTTP status, prevent the response or is
required to render the initial application state.

The rendered snapshot belongs to this response. A navigation into another τjs application starts a
new request and resolves that application's contract again.

## Deferred route data

`attr.deferred` declares response-owned work that may complete after the shell begins streaming:

```ts
{
  path: "/account",
  attr: {
    render: "streaming",
    meta: { title: "Account" },
    data: async (_params, ctx) => ({
      preferences: await loadPreferencesForRequest(ctx.headers ?? {}),
    }),
    deferred: {
      recommendations: async (_params, ctx) => ({
        items: await loadRecommendations(ctx.headers ?? {}),
      }),
    },
  },
}
```

Deferred work is still declared in `taujs.config.ts`; a component cannot promote its own promise into
the response registry. Each renderer exposes the declared entry through its native asynchronous
primitive. See [Data Loading](/guides/data-loading/#deferred-route-data) and the renderer reference for the
accessor used by that application.

The registry, delivery envelope and result are scoped to the one selected application and response.
They do not cross a micro-frontend document boundary. A link to another application creates a new
registry from that application's declarations.

Deferred entries are not HTTP-status-bearing. Any condition that must prevent or redirect the
response, or choose its status, belongs in critical route resolution.

## Within one application

Component state and a framework-native store are appropriate within one application's client
runtime. Initialise the store from route data during SSR and hydration, then let client navigation
inside that application update it normally.

Keep the distinction explicit:

- route data is the server-owned snapshot for a response
- the client store is mutable UI state after hydration
- a full-document application boundary discards that store
- persistence must be deliberate if the next application needs a value

Do not turn every store field into persistent state. Most interaction state, open panels, drafts and
optimistic updates should remain local. If a draft must survive a document boundary, save it to a
suitable server-side or browser persistence layer before navigating.

## Cross-application communication

Prefer durable, inspectable mechanisms:

1. Server state and sessions for authoritative data.
2. URL path and query parameters for navigation intent and shareable state.
3. Browser storage for small, non-sensitive preferences.
4. `postMessage` only when applications genuinely coexist in separate browsing contexts such as an
   iframe, with strict origin and payload validation.

Avoid using window globals, hidden DOM events or a runtime event bus to simulate shared memory across
separate applications. Those mechanisms reintroduce the client orchestrator that the document
boundary is intended to avoid.

## Choosing the seam

A document boundary works when the destination can reconstruct what it needs from its URL, route
contract, server session and explicitly persisted preferences.

If a playing video, live socket, unsaved editor or transaction must survive the transition, keep the
routes in one application or move the boundary. Persistence can preserve data, but it cannot preserve
an executing component tree.

Related guides:

- [Micro-Frontends](/guides/micro-frontend/) for build and navigation boundaries
- [Dependency Management](/guides/dependency-management/) for shared source and bundles
- [Request Contracts & Data](/guides/request-contracts/) for response ownership
- [Authentication](/guides/authentication/) for the Fastify authentication boundary
