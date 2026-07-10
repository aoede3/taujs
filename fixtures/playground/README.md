# τjs playground (introspection fixture, P0B-05)

One small bootable app the introspection effort drives against: Gate 0B end-to-end tests,
later the MCP eval target and the scripted killer demo. Private, never published.

## What each route exercises

| Route           | Exercises                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`             | SSR + declared edge via mapper-omitted `serviceData('content', 'home')` (`content.home` declares broad `{}` params — 04-design §Typing honesty)  |
| `/product/:id`  | Streaming + meta + declared edge with narrowing mapper — **the killer-demo route**: `/product/999` fails deterministically (`PRODUCT_NOT_FOUND`) |
| `/legacy`       | Closure-style data handler → `data.kind: 'dynamic'` (target unknowable statically)                                                               |
| `/terms`        | SSR with `hydrate: false`                                                                                                                        |
| `/admin`        | `middleware.auth` + the `authenticate` decorator (send `x-playground-user: admin` to pass)                                                       |
| `/spa/anything` | Nothing declared — the fallthrough (client-rendered) path; deliberately NO wildcard route so fallthrough stays reachable                         |

The registry (`content`, `catalog`) carries one parse-style params schema and one
bare-function result validator, so the graph shows both honest `kind` values.

The request-graph shape these routes produce is pinned by the `playground` fixture snapshot
in `packages/server/src/core/introspection/test/RequestGraph.test.ts` — keep the two in sync.

## Run

```sh
pnpm --filter playground dev     # boots on http://localhost:5173
pnpm --filter playground build   # dist/ + dist/.taujs/graph.json (source: 'build')
```

A dev boot writes `node_modules/.taujs/` (dev.json, graph.json, traces.ndjson, logs.ndjson,
observations.json) and serves the guarded `/__taujs/*` overlay endpoints.

## Three curls → three trace records

```sh
curl -s http://localhost:5173/ > /dev/null                 # SSR trace (mode: ssr)
curl -s http://localhost:5173/product/123 > /dev/null      # streaming trace (mode: streaming)
curl -s http://localhost:5173/spa/anything > /dev/null     # fallthrough trace (mode: fallthrough, route: null)
```

Then inspect `node_modules/.taujs/traces.ndjson` (or `GET /__taujs/traces` with the
`x-taujs-token` from `dev.json`). `/product/999` produces an `outcome: 'failed'` trace with
the deterministic error.
