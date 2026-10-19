---
title: When to Use τjs
description: The situations τjs is built for, the ones it is not, and the guide that explains each in full.
---

τjs is an application-response orchestration layer built on Fastify and Vite. Fastify owns HTTP
dispatch and the host lifecycle; τjs owns the declared application response after Fastify selects a
τjs route; the renderer the application chose turns that response into HTML. The
[architecture guide](/guides/architecture/) explains how those layers fit. This page is for the
question before that one: is your situation one τjs serves well?

## Reach for τjs when

### An existing application needs a request boundary without a rewrite

You do not convert an application. Put τjs around what you have, keep the component tree, the
client router and the query library, and declare request contracts only for the routes whose
initial response benefits from server coordination. A contract moves initial-response data, policy
and rendering decisions to the request boundary one route at a time; everything after hydration
stays where it is.

[Incremental Migration](/guides/incremental-migration/) ·
[Request Contracts and Data Ownership](/guides/request-contracts/)

### A URL area wants a different renderer from the rest

A renderer belongs to an application, not a route. One Fastify host can serve a React storefront
and a Solid account area, each with its own client and SSR build, each a real Fastify route.
Moving a URL area from one framework to another means moving it into an application that declares
the other renderer, while the services, policy and route-data shape that supply it stay shared.
Navigation across that seam is a document navigation.

[Micro-Frontends](/guides/micro-frontend/) ·
[Incremental Migration: one renderer per app](/guides/incremental-migration/#the-important-boundary-one-renderer-per-app)

### A same-framework upgrade should land one URL area at a time

Applications under one host do not share a browser runtime, so two of them may run different
framework versions within the range each renderer package supports. That gives a framework upgrade
the same shape as a renderer change: move one URL area to an application on the new version,
verify it, move the next. Shared code crossing the boundary stays framework-neutral, and the peer
ranges on the renderer pages bound what each side may run.

[Dependency Management: version coordination](/guides/dependency-management/#version-coordination) ·
[Getting Started: prerequisites](/guides/getting-started/)

### Render strategy is a route decision, not a component one

`ssr`, `streaming`, hydration on or off, and client-only rendering by omitting the route: the same
component tree serves all of them, and the choice lives in the route record. Critical data resolves
before the response commits, where a failure can still become an HTTP status. Deferred data starts
with the request, never delays independent shell content and cannot decide the status.

[Data Loading](/guides/data-loading/) ·
[Request Contracts and Data Ownership](/guides/request-contracts/)

### Several applications share one host, one service layer and one policy

A storefront, an account area and an operations console can each be a separate application with
its own renderer, module graph and output bundle, composed through Fastify routes and assembled
build output rather than a browser-side shell or runtime module federation. Typed services,
authentication and Content Security Policy are declared once and apply across them. Every URL
belongs to exactly one application.

[Micro-Frontends](/guides/micro-frontend/) · [Services](/guides/services/) ·
[Authentication](/guides/authentication/) ·
[Content Security Policy](/guides/content-security-policy/) ·
[App Shell Pattern: when not to use a shell](/guides/app-shell-pattern/#when-you-should-not-use-an-app-shell)

### You already own Fastify

Supply your instance and τjs installs into an encapsulated application scope: your not-found
handling, host-wide policy and request identity stay yours, and the boot summary states which
installation shape is active. Omit it and τjs creates the host with whole-server defaults. The same
contracts carry development through a supervisor, gateway or ingress.

[Host Ownership](/guides/host-ownership/) ·
[Supervisors and Gateways](/guides/supervisors-and-gateways/)

### A route has no component tree

A static marketing page, a generated document, or an application that owns its own client-side
rendering and wants τjs only for routing, service-data resolution and streaming: `@taujs/html` is
the framework-free implementation of the renderer contract for a page with nothing to compile.

[@taujs/html: when to use it](/renderers/html/#when-to-use-it)

### You want the development record, not a guess

Every development request leaves an episode, and the request graph records what the configuration
declares. An agent working on a τjs application reads blast radius, failing routes and hydration
mismatches from files the dev server already emitted, over MCP, rather than inferring them from
source. There is no production collector; production observability stays with your own tools.

[MCP Server](/reference/mcp/) · [Logging and Telemetry](/guides/logging-telemetry/)

## Do not reach for τjs when

- **A transition must keep in-memory client state across the seam.** Applications do not share
  browser memory; the boundary between them is a document navigation. Cookies, sessions and URL
  state cross it, component state does not.
- **A renderer must switch inside one component root.** One response selects one application and
  one renderer. `renderer` is never a per-route option.
- **You want a replacement for your client framework or router.** τjs does not translate
  components between frameworks, make framework-specific UI libraries portable, or replace
  application navigation, caching and mutation logic.
- **You want a second HTTP router.** Fastify is the host. τjs adds no parallel plugin system and
  no routing layer of its own.
- **You want runtime module federation.** Applications compose through routes and assembled build
  output; shared code is bundled through ordinary imports.

The migration guide lists [what τjs does not migrate for you](/guides/incremental-migration/#what-τjs-does-not-migrate-for-you)
in full.

## Choosing a first seam

The best first slice is a real boundary, not the smallest component you can extract. Good
candidates are an account or admin area with its own URL prefix, a marketing or documentation
surface, a route with little shared client state, or a domain already behind a clear service
contract. Avoid a modal buried in the existing root, a route that leans on the old app's client
store, or the most operationally critical page before the new path is proven.

[Incremental Migration: choosing a good first seam](/guides/incremental-migration/#choosing-a-good-first-seam)

## Related guides

- [Getting Started](/guides/getting-started/)
- [τjs Architecture](/guides/architecture/)
- [Incremental Migration](/guides/incremental-migration/)
- [Micro-Frontends](/guides/micro-frontend/)
- [MCP Server](/reference/mcp/)
