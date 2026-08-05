---
'@taujs/server': patch
---

On a caller-owned development host, Vite no longer answers requests Fastify selected for a caller route.

The development delegator runs Vite's middleware from an `onRequest` hook. On a caller-owned host that hook sits on the caller's own root instance, so Vite saw every request - including ones the caller's routes were selected to serve, and it answered some of them. The visible symptom was Vite's 403 block page returned for a **caller's own route** whenever the incoming `Host` was one Vite does not allow, which a reverse proxy or supervisor commonly presents.

Selected **caller** routes now bypass the middleware. Declared τjs pages deliberately do not: they are selected too, but they stay in the middleware path so Vite's host check keeps applying to them - the bypass narrows who Vite answers for without weakening the DNS-rebinding posture for τjs's own documents, and both ownership modes keep the same posture. Anything unmatched still reaches Vite, so `/@vite/client`, source modules and assets are unaffected, and an unmatched URL Vite does not claim still falls through to the caller's own 404 handler.

The classification is two reads rather than a lookup: `request.is404` is a public Fastify getter over the route context Fastify already selected, and the τjs page identity is the one the same request already carries for rendering, auth and CSP. Nothing re-resolves a URL, so nothing can disagree with Fastify's own selection on wildcards, constraints or decoded parameters.

Unchanged: τjs-created hosts, and Vite's host posture - an undeclared `Host` is still rejected for τjs pages and for the resources Vite owns. Declare `vite.server.allowedHosts` to allow one.

Note the ownership consequence: caller routes now follow the **caller host's own** Host-validation policy, whatever that is. `vite.server.allowedHosts` protects τjs pages and Vite resources; it does not govern caller-owned routes, and never sensibly did - a caller route answered by Vite's host check was the defect.
