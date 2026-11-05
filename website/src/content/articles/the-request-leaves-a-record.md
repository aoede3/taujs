---
title: The request leaves a record
description: Why τjs records declared structure and observed execution separately, and why tools should know the difference.
author: "John Smith"
date: 2026-11-05
---

An agent can read every file in a repository and still not know what happened to a request.

Source describes possibilities. Configuration describes intent. Logs preserve fragments of execution. No single one says which route handled a particular request, which services it called, whether the response began streaming, where it failed, or what the browser reported afterwards.

A person investigating the failure has the same problem. They can reconstruct a likely account by following the code and comparing it with whatever logs survived. The better they know the system, the better the reconstruction. It is still a reconstruction.

τjs owns the declared application response between Fastify selecting a route and a renderer producing the document. In development it uses that position to leave two records: a request graph describing what the application declared, and request episodes describing what individual responses did.

`@taujs/mcp` makes those records queryable over the Model Context Protocol (MCP). MCP is the query surface. What matters is that the tool has something more precise than source inference to read.

## Three different questions

Consider a product route that renders with data from `catalog.getProduct`.

Before the route runs, the request graph can answer questions about its declared shape. Which application owns it? Does it use SSR or streaming? Will the result hydrate? Is authentication declared? Does the data come from a named service edge or an ordinary loader?

After a request, an episode can answer a different set of questions. Which route ran? Which service calls started and completed? Did the response finish or fail? What status was sent? Did the browser report hydration?

A versioned contract answers a third kind of question: what does a recorded fact mean? If an episode has `client: null`, for example, that value should not acquire a meaning from whichever explanation sounds plausible. The episode points to the contract section that defines it for the installed server version.

These are related accounts, but they are not interchangeable:

- The graph records declared structure.
- An episode records one observed execution.
- A contract defines the semantics of the fields being read.

Keeping them separate prevents a common category error. Something declared may not have run. Something observed at runtime may not have been statically declared. Something absent from a bounded record may still have happened.

## One failed request

Take a development request to `/product/999`. The page fails because the product does not exist. Its request ID is `req-999`.

The first useful question is not which file contains the product component. It is which recent request failed:

```text
taujs_get_recent_episodes { "outcome": "failed" }
```

The result identifies `req-999` and summarises the failed service call: `catalog.getProduct FAILED 3ms`.

The episode then supplies the account of that response:

```text
taujs_get_episode { "requestId": "req-999" }
```

It records the route, the response outcome, the service-call timeline and a domain error: `Product 999 does not exist`. The URL record contains the pathname and the names of any query keys, but not their values. If the browser did not provide a hydration observation, the associated contract reference explains what can and cannot be concluded from that absence.

Logs are available separately and default to warnings and errors:

```text
taujs_get_episode_logs { "requestId": "req-999" }
```

Only after establishing what happened does the declared route become useful. It can now answer a narrower question: what was this route supposed to do?

```text
taujs_explain_route { "path": "/product/:id" }
```

That answer shows that the route is streaming, that its data edge is the named `catalog.getProduct` service method, and which schema and policy declarations belong to it. A final query can show other callers of the same service method, separated by evidence source:

```text
taujs_who_calls_service {
  "service": "catalog",
  "method": "getProduct"
}
```

At that point the investigation can move into source with a much smaller search area. The service, method, failed request and neighbouring callers are already known. Source is still where the implementation is understood and changed; it is no longer being asked to provide an execution record it never contained.

## Declared and observed are not interchangeable

A direct `serviceData()` relationship can appear in the graph before the application receives traffic. It is declared evidence: the route contract names the service and method.

An ordinary loader closure is different. τjs records that the route has dynamic data, but it does not inspect the function and pretend to know which calls it might make. If that loader uses the service registry during a development request, the call can appear later as `observed` evidence.

Routes registered directly on Fastify remain outside τjs ownership. If development traffic shows one calling a registered service, the edge is labelled `hostObserved`; it does not quietly acquire a τjs contract. Those labels carry the earlier distinction into each answer: declared intent, behaviour through a τjs response, and behaviour through a host route remain distinct.

## A refusal can be the correct answer

Tools are often judged by how many questions they answer. For an evidence reader, knowing when not to answer matters just as much.

If an episode identifier is missing, τjs does not claim that the request never existed. It reports that the identifier is not in the retained episode ring and names the possibilities: the episode may not have reached the persisted mirror yet, may have been evicted, or may never have been recorded.

If only a build graph exists, structural questions can still be answered with its source and emission time attached. Runtime questions refuse because a build contains no live episodes.

If two development servers are active in the same project, the reader refuses to merge them into one account. If the identifiers inside a boot folder disagree, it reports an inconsistent substrate. If an installed package version cannot safely explain a contract reference emitted by another version, the contract body is withheld rather than paired with the wrong semantics.

These behaviours can look conservative. They are. A confident answer assembled from incompatible evidence is worse than a useful refusal.

The same restraint applies when a query succeeds. The graph covers what τjs owns, not every function, API route or client-side request in the repository. Component-local work remains component-local. A Fastify route that never calls through the service registry leaves no τjs service observation. The graph can show that a relationship was declared, but it cannot recover the business decision that caused somebody to declare it.

A clean diagnostic report is equally specific: it means the checks that ran found no warnings in the declared graph, not that the application is healthy. Episodes are bounded development records, not production tracing. The production runtime contains no development collectors; a build may emit a structure-only graph, but it does not emit request episodes.

## The protocol is not the proposition

MCP provides a convenient way for an agent to ask bounded questions and receive structured answers. Another interface could read the same artefacts. The architectural decision came earlier, when the framework chose to preserve declared structure and observed execution as separate records.

`@taujs/mcp` is a filesystem-only reader. It opens no network connection and loads no application configuration. The emitted files are its credential and its limit.

That separation is useful to people as well as agents. It gives a maintainer somewhere to begin before tracing a render. It gives a reviewer a declared graph to compare across changes. It gives a debugging session a request identity that connects the route, service calls, logs and client observation without pretending those records explain the whole application.

Code remains necessary. It explains how the system is implemented and may preserve some of why. The graph says what τjs was asked to own. An episode says what one response did. A contract says how to interpret the recorded facts.

An agent still has to reason across all three. It should not have to guess about facts the framework already knows.

*Setup, tool arguments and the complete evidence semantics are in the [MCP server reference](/reference/mcp/).*
