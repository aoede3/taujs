---
title: Request contracts and data ownership
description: How τjs optionally centralises initial render data at the request boundary rather than in components.
---

It’s common to load data directly from components.

Components fetch what they need, the server renders what it can, and client-side logic handles the rest.

τjs supports this style - but, it also introduces an alternative model for teams that want more explicit control.

### The core idea

In τjs, **initial render orchestration can be owned by the request** rather than by individual components.

Routes _may_ define:

- what data is needed for the initial render
- which backend services are involved
- how that data is made available to renderers

Rendering - whether CSR, SSR, or streaming - then becomes a **consumer** of that orchestration, not the place where orchestration originates.

This creates a clearer separation of concerns:

- **Requests coordinate**
- **Renderers render**
- **Components consume**

You can adopt this model incrementally, per route.

---

## What is a request contract?

A request contract is an explicit description of what happens during a route’s initial render.

When used, it lives at the **route boundary**, not inside component trees, and typically describes:

- the route itself
- the data required for first render
- the backend services involved
- the rendering strategy applied to the result

The goal is not restriction, but **visibility**:

- data dependencies are declared in one place
- service access is intentional rather than incidental
- request behavior can be understood without inspecting component trees

---

## Why a request contract model

Component-owned data loading is familiar and flexible, but as applications grow it can introduce friction:

- **Implicit orchestration**
  Data dependencies emerge from component structure rather than being stated at the route boundary.

- **Accidental waterfalls**
  Nested components can trigger serial requests that are hard to spot early.

- **Diffuse service access**
  Service calls spread across the UI layer, making ownership less clear.

- **Limited observability**
  It becomes harder to answer “what happened during this request?”

τjs does not treat this as a failure - but, as a trade-off.

The request contract model offers a different set of trade-offs.

---

## Initial render data in τjs

When using request contracts, τjs treats **initial render data** as part of request orchestration.

That means:

- data needed for first render can be declared up front
- services are called deliberately, as part of the request
- the orchestration shape is known before rendering begins

This applies regardless of rendering mode:

- CSR
- SSR
- Streaming SSR

Rendering strategy affects _how_ output is delivered - not _where orchestration lives_.

---

## Service access as an orchestration concern

τjs provides a service registry that can be used to mediate backend access during request orchestration.

When used:

- services are accessed through a common interface
- routes define which services are involved
- service calls become part of the request’s execution context

This enables:

- clearer ownership
- consistent telemetry
- predictable failure handling
- future policy decisions around caching, retries, or access control

Direct imports and client-side calls remain possible - the registry exists to support coordination, not to enforce purity.

---

## What about client-side fetching?

τjs fully supports client-side data fetching.

Components can:

- fetch data directly from APIs
- trigger requests in response to user interactions
- subscribe to real-time updates

This works whether a route uses a request contract for initial data orchestration, or is not declared in `taujs.config` at all and remains client-rendered.

The distinction is about **where authority starts**, not what is allowed.

Client-side fetching remains a valid and often appropriate choice.
Request contracts simply provide a way to move critical orchestration earlier, when coordination or visibility becomes valuable.

---

## Trade-offs and adoption

Using request contracts introduces more structure:

- some orchestration decisions move out of components
- routes become more descriptive
- the boundary between orchestration and UI becomes clearer

τjs does not require this model everywhere.

You can:

- start with client-side fetching
- introduce request contracts on selected routes
- evolve toward stricter orchestration only when it pays off

---

## What this enables over time

Anchoring orchestration at the request boundary makes it easier to:

- scale from single apps to composed systems
- introduce build-time micro-frontends without runtime federation
- reason about performance and failures at the system level
- change rendering strategies without rewriting data flow

This is less about rendering technique, and more about **making system behavior explicit when complexity grows**.

## Where request contracts help

You don’t need request contracts for every application.

They tend to matter when at least one of the following is true:

- Initial render depends on multiple backend services
- Rendering strategy varies by route (CSR / SSR / streaming)
- First-load performance or SEO is important
- Service access needs to be visible or constrained
- The system spans multiple domains or teams

If none of these apply, component-level data fetching is often sufficient.

τjs lets you start there and adopt request contracts only where they provide value.

## When not to use request contracts

Request contracts add structure that may not be worth the cost when:

- A route is primarily interactive with minimal initial data
- Data dependencies change frequently based on user state
- You are prototyping and iteration speed matters most
- The application is small enough to reason about without explicit contracts
- Client-side mutations dominate over initial reads

In these cases, component-level data fetching is often the simpler and more appropriate choice.
