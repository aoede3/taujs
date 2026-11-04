---
title: Where a page decides what it needs
description: Why τjs coordinates the initial response at the route, then leaves the running application to its component tree.
author: "John Smith"
date: 2026-11-04
---

The useful question about τjs is not which existing framework it most resembles. It is smaller: where does a page decide what it needs?

For τjs, the answer is the request. A route declares the work that belongs to the initial response. The server resolves what must be known before the response can commit, starts any declared work that may arrive later, and passes the result to the renderer. Once the page has hydrated, the component tree behaves as component trees do: it owns local state, interaction, mutations, optimistic updates and data requested afterwards.

τjs is built around that division. The request coordinates the page. The component tree owns the application.

## Why data moved into components

Server-rendered applications made a page relatively easy to trace. The controller ran the queries, dealt with failure and passed a set of facts to the view. You could usually read it and get a reasonable account of what a request would do.

That legibility came with real costs.

Views were awkward to compose. A partial could render what it was given, but it could not easily say what it needed. Reuse meant remembering to provide the right data in every controller that included it. Interactivity then formed a second system over the first, with another account of state and another set of failure modes.

Components improved that arrangement. They put structure, behaviour and state in the same unit. A piece of interface could be moved without renegotiating every detail with a controller. Letting that unit fetch its own data felt like the natural completion of the model and, locally, it often still is.

The difficulty appears at page scale.

Take a simple question about a product route: what happens before the customer can use it? The answer might be spread across a layout that checks the session, a product component that loads the record, a price component that asks another service, and a recommendation panel that suspends or fails independently. Each decision is reasonable where it was made. Together they form an execution plan that the route itself no longer describes.

To recover that plan, somebody has to follow the render, find every conditional branch and often run the page to see which requests appear. A network waterfall is one possible consequence, but not the only one. The more persistent cost is that the system has become difficult to read without executing it.

Caching, deduplication, Suspense, preloading and server rendering all improve parts of this. They are good engineering aimed at real problems. But an execution plan can be efficient and still be distributed. Moving a wait, sharing it or avoiding it does not necessarily give the request a single account of what it is expected to do.

## What τjs chooses to own

τjs makes a limited trade: work owned by the initial response is declared at the route boundary, while work owned by the interactive application remains with the application.

A route contract can describe the application and renderer that own the response, its rendering and hydration choices, its policy, its head data, and the critical or deferred data it intends to produce. With SSR, critical data settles before rendering. Streaming can hand pending work to the renderer so that independent shell content is not held back. Deferred work is declared and started once by the request, but may settle after the stream has begun. Anything that must prevent, redirect or choose the status of the response belongs in a pre-commit phase.

The service registry is available when named, typed service edges are useful; it is not a toll gate through which every query must pass. A route can use an ordinary loader, coordinate several registry calls, or declare a direct service relationship. The value is that the work has an owner before rendering begins and, where the relationship is declared, it can appear in the request graph.

Nor does τjs forbid components from fetching. Component-started work is still valid; it is simply outside the request contract. It will not be presented as a declared service edge or receive the cancellation, deferred-outcome and hydration guarantees of request-owned work. After hydration, the usual cases remain where they belong: a search box querying as the user types, an infinite list loading another page, a mutation updating optimistically, a live view polling or listening for change.

There is no formula that places every fetch correctly. A useful question is whether the data helps establish the response or belongs to an interaction within it.

If it can change the status or redirect, is needed for the initial page, is shared across the route, or benefits from a visible relationship to authentication and other request policy, there is a good case for declaring it at the request. If it exists because of something the user did after the application arrived, it probably belongs with the component that owns that interaction.

The distinction will not settle every argument. It does at least make the disagreement visible.

## Other answers to the same question

React Server Components answer the same question from another direction. They allow data-dependent components to execute on the server, keep some code and work away from the browser, and make sequential server-local reads much cheaper than the equivalent client round trips. Preloading and request-local caching can also begin or share work outside the component that eventually consumes it. Those are substantial advantages.

They make a different choice about where the system is described. Server execution remains part of the React component model, together with a server/client component boundary that affects how code may be imported and composed. The work can be well coordinated, but the component hierarchy remains one of the places a maintainer has to read to understand it.

τjs does not move the component tree to the server as its organising idea. It keeps response orchestration outside any renderer, in a route contract that React, Vue, Solid or plain HTML can consume.

React Router is the closer comparison. Its Data and Framework modes move route configuration outside React rendering and treat loader data as a route concern. Matched loaders can run in parallel. That is shared ground, not a distinction worth inventing away.

τjs makes a different choice of scope: its route contract is renderer-neutral and sits directly on Fastify. The practical consequence is that several applications using different renderers can share the same server boundary, while the development runtime emits the declared request graph and episodes of observed execution as artefacts. The MCP server reads those artefacts rather than inferring the system from component source.

There is an honest resemblance to a multi-page application too. Both take the document request seriously, and τjs uses full document navigation between separately built applications. Within an application, client routing and hydration can remain entirely conventional. The server owns the production of a response; it does not become the permanent owner of the interface.

## What follows

Once response-owned work is declared before rendering, some of τjs's other choices follow.

Server-owned routes choose between SSR and streaming, with hydration controlled separately. Client-routed screens are omitted from the server route contract and remain with the client router once the application document has loaded.

Several applications can sit under one Fastify host, each with its own renderer, client build and SSR build. They meet at URL and document boundaries rather than negotiating through a runtime federation shell. That means they do not share browser memory across the boundary, which is both a constraint and the reason the boundary remains understandable.

The request graph follows the same logic. It records declared structure: routes, policy, rendering choices and service relationships that have been made statically visible. Development episodes record what a particular response actually did. Arbitrary handlers and component-local work remain outside the declaration. The distinction matters because declared intent and observed execution are different kinds of evidence, and neither should be presented as complete knowledge of the application.

These capabilities do not make the model universally correct. They are what becomes possible once the request has a durable description.

## The cost

The cost is a loss of some component-level colocation.

A component that participates in the initial response cannot always be entirely self-sufficient. Its initial facts may have to appear in a route contract and arrive through the renderer's data channel. The route has to participate, and somebody has to decide whether a piece of work belongs to the response or to the interaction.

That is additional design work at the point where fetching directly from the component would be quicker. On a small application, a prototype, or a page whose data needs are genuinely local, the return may never justify the cost. There is no virtue in creating a request graph that nobody needs to read.

The calculation changes as a system grows.

Eighteen months later, when somebody asks what a route does, an explicit contract gives them somewhere to begin. It helps the developer investigating a failure and the team reviewing an authentication boundary.

For an agent, it changes the task from reconstructing an architecture from source to reading declared evidence and checking it against observed execution.

An explicit contract is not complete knowledge, but it means a render is no longer the only reliable documentation.

τjs gives up some convenience at the beginning to preserve a readable account of the request for later.

Servers are good at coordinating requests. Components are good at owning interactive interfaces. They do not need to compete for the whole application.

Coordinating the page and running the application are different jobs. τjs gives each one an explicit owner.
