---
title: Logging & Telemetry
description: Logger ownership, request identity and τjs development episodes
---

τjs produces two related forms of operational evidence:

- structured log records delivered through the selected logger
- development request episodes describing how τjs resolved and rendered a response

They share request correlation, but they are not the same system. A log sink is an operational stream;
a τjs episode is a bounded application-response record for local introspection and MCP tools.

## Logger selection

The runtime resolves one logger in this order:

```text
createServer({ logger })
          ↓ otherwise
active fastify.log and request.log
          ↓ otherwise
τjs console fallback
```

An active Fastify logger has a non-empty level other than `silent`. An explicit `logger` passed to
`createServer()` is authoritative for τjs records. τjs does not change the selected sink's level,
serialisers, redaction, transport or destination.

### Fastify logger

For a caller-owned host, configure logging directly on Fastify:

```ts
import Fastify from "fastify";

// Development is requested explicitly; `production`, `test`, `staging` and an unset variable all
// take the production branch. This matches how τjs derives its own runtime mode, so the host
// logger and τjs records never disagree about which mode the process is in.
const isDevelopment = process.env.NODE_ENV === "development";

const fastify = Fastify({
  logger: {
    level: isDevelopment ? "debug" : "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "params.password",
      "params.token",
    ],
    transport: isDevelopment
      ? {
          target: "pino-pretty",
          options: { colorize: true },
        }
      : undefined,
  },
});

await createServer({
  fastify,
  config,
  serviceRegistry,
});
```

τjs runtime records use `fastify.log`. Request records derive from `request.log`, retaining the host
request ID, bindings, redaction, serialisers and destination.

A τjs-created Fastify instance has logging disabled by default, so τjs uses its standalone console
logger unless an explicit `createServer({ logger })` is supplied. The fallback is intentionally not
silent: records still reach the process console even though caller-owned hosts receive no τjs
presentation banner.

## Structured records

External sinks receive a semantic message and metadata. τjs does not prepend its console timestamp or
`[level]` label before handing a record to Fastify, Pino, Winston or a custom logger. The selected sink
owns framing.

Application code uses metadata first and message second:

```ts
ctx.logger.info(
  { productId: params.id, operation: "load" },
  "Loading product",
);
```

Request bindings are installed through a child logger and are not repeated in a nested context field.
Typical bindings include the Fastify-native `reqId`, URL and method.

Service dispatch creates another child with `component: "service-call"`, service name and method. Do
not manually repeat these fields on every service record unless the local value is genuinely
different.

## Request identity

Fastify owns request identity. τjs follows Fastify's request identity and logging vocabulary, using
the conventional `x-request-id` header at its HTTP boundary:

- `req.id` is the identity Fastify assigned to the HTTP request, and it is canonical
- `ctx.requestId` is always `String(req.id)`
- log bindings carry the Fastify-native `reqId`, in its native type

τjs never reinterprets an inbound correlation header after Fastify has created the request. Header
adoption is a construction-time decision:

- on a τjs-created host, τjs configures `genReqId` itself: a single valid inbound `x-request-id`
  becomes `req.id`, otherwise `crypto.randomUUID()`
- on a caller-owned host, the caller controls correlation through Fastify construction and τjs
  adopts whatever `req.id` it produced

Accepted inbound values contain letters, numbers, hyphens, underscores, dots or colons and are no
longer than 128 characters. To adopt inbound correlation on your own host, use a validating
`genReqId` rather than `requestIdHeader`, which would take the header without validation:

```ts
const app = Fastify({
  genReqId(request) {
    const incoming = request.headers["x-request-id"];

    return typeof incoming === "string" && isValidRequestId(incoming)
      ? incoming
      : crypto.randomUUID();
  },
});
```

This is application request correlation, not a complete OpenTelemetry or W3C trace/span model. A
future distributed-tracing integration uses `traceparent` and its own trace and span IDs; the
request-correlation identity makes no such claim.

### Response scope

A τjs-created host installs the request-identity lifecycle at its root, including its implicit
SPA fallback and not-found path. A caller-owned host installs it inside the encapsulated τjs scope. Host
routes then retain their own logging and do not receive a τjs `x-request-id` response header.

Every τjs-owned response echoes the canonical identity:

```text
x-request-id: request-42
```

See [Host Ownership](/guides/host-ownership/#request-identity-and-episode-scope) for the installation
split.

## Logging from loaders and services

A route loader receives the request-scoped logger and identity:

```ts
data: async ({ id }, ctx) => {
  ctx.logger.info({ productId: id }, "Fetching product");

  const response = await fetch(
    `https://catalogue.example.test/products/${encodeURIComponent(String(id))}`,
    {
      signal: ctx.signal,
      headers: { "x-request-id": ctx.requestId },
    },
  );

  return { product: await response.json() };
};
```

A service receives the same lineage:

```ts
export const OrderService = defineService({
  create: async (params: { accountId: string; items: Item[] }, ctx) => {
    ctx.logger?.info(
      { accountId: params.accountId, itemCount: params.items.length },
      "Creating order",
    );

    return { order: await orders.create(params) };
  },
});
```

Fastify hooks outside the τjs scope should use `request.log` and `request.id`. They carry the same
canonical identity; no τjs-specific property is needed there.

## Debug categories

The supported categories are:

- `auth`
- `routes`
- `errors`
- `vite`
- `network`
- `ssr`

Enable selected categories:

```ts
await createServer({
  fastify,
  config,
  serviceRegistry,
  debug: ["ssr", "routes", "auth"],
});
```

Or enable all with exclusions:

```ts
await createServer({
  fastify,
  config,
  serviceRegistry,
  debug: {
    all: true,
    vite: false,
    network: false,
  },
});
```

A comma-separated string is also accepted, so a host may pass `process.env.DEBUG` explicitly.

Debug output is admitted by the strictest combination of:

1. the τjs category configuration
2. the τjs runtime minimum level
3. the selected sink's level

The production runtime minimum is currently `info`. Setting Fastify or Pino to `debug` in production
does not independently enable τjs debug records. Debug category names are retained in structured
metadata as `category`.

## Explicit and custom loggers

### Winston

Use the supplied message-first adapter:

```ts
import winston from "winston";
import { createServer, winstonAdapter } from "@taujs/server";

const sink = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});

await createServer({
  config,
  serviceRegistry,
  logger: winstonAdapter(sink),
});
```

### BaseLogger

An explicit logger implements the small metadata-first contract:

```ts
import type { BaseLogger } from "@taujs/server";

const logger: BaseLogger = {
  debug: (meta, message) => sink.debug(message, meta),
  info: (meta, message) => sink.info(message, meta),
  warn: (meta, message) => sink.warn(message, meta),
  error: (meta, message) => sink.error(message, meta),
  child: (bindings) => makeChildLogger(sink, bindings),
};
```

Implement `child()` when the sink supports bindings. If it does not, τjs retains request context in
its wrapper metadata.

## Development request episodes

In development, τjs records a bounded episode for each τjs-owned response. An episode includes:

- sanitised URL path and query-key names
- selected app, route and render strategy
- response outcome and status
- data, head, shell and completion timing
- named service calls with duration and outcome
- optional per-key deferred outcomes
- client hydration evidence when reported
- a bounded, redacted error summary

The in-memory rings are mirrored under `node_modules/.taujs/`:

```text
node_modules/.taujs/
├── dev.json
├── graph.json
├── episodes.ndjson
├── logs.ndjson
└── observations.json
```

`dev.json` describes the current live process and is removed on graceful close. Episode and log mirrors
remain, with `bootId` distinguishing stale data. Late deferred outcomes advance the episode revision and
are written to `episodes.ndjson`, so MCP reads do not lose results that settle after the main episode
terminal.

These artefacts are development evidence, not a production telemetry exporter. See
[MCP Reference](/reference/mcp/) for the tools that read them.

## Logs and episodes

Logs answer operational questions over time: what failed, what a dependency reported and what the
process is doing. Request episodes answer one τjs-specific question: how this application response was
resolved and rendered.

Use both where they add value:

| Need | Primary evidence |
| --- | --- |
| Host lifecycle and infrastructure | Fastify or process logs |
| One response's app, route and render path | τjs request episode |
| Downstream failure detail | Structured service log |
| Declared architecture | Request graph |
| Deferred key outcome and timing | τjs request episode |
| Cross-service distributed trace (future) | External telemetry system |

## Sensitive data

τjs does not put route-data payloads, renderer stores, service return values, request bodies or full
request headers into its normal lifecycle records.

There is one important current behaviour: a failed service call logs its parameter object alongside
error details. Treat service parameters as loggable identifiers and options, not a place for passwords,
session tokens or raw credentials. Configure redaction on Fastify, Pino or the explicit sink for
application-specific sensitive fields.

Application records can disclose anything explicitly passed to them:

```ts
// suitable
ctx.logger.info(
  { accountId: account.id, action: "password-reset-requested" },
  "Password reset requested",
);

// unsafe
ctx.logger.info(
  { email: input.email, password: input.password, token: sessionToken },
  "Login attempt",
);
```

Development episodes apply a key-name denylist, depth and length caps, and remove query values. Those
protections do not excuse unsafe application logging.

## Useful patterns

### Authentication

Authentication belongs to Fastify, so log through `request.log`:

```ts
fastify.decorate("authenticate", async function (request, reply) {
  try {
    const user = await verifyAuth(request);
    request.log.info({ userId: user.id }, "User authenticated");
    request.user = user;
  } catch (error) {
    request.log.warn({ err: error }, "Authentication failed");
    reply.code(401).send({ error: "Unauthorised" });
  }
});
```

### External dependency timing

```ts
export const SearchService = defineService({
  search: async (params: { query: string }, ctx) => {
    const startedAt = performance.now();

    try {
      const result = await searchClient.search(params.query, {
        signal: ctx.signal,
      });

      ctx.logger?.info(
        { durationMs: performance.now() - startedAt },
        "Search completed",
      );

      return { result };
    } catch (error) {
      ctx.logger?.error(
        { durationMs: performance.now() - startedAt, error },
        "Search failed",
      );
      throw error;
    }
  },
});
```

Service dispatch already records its own total duration. Add local timing only when it identifies a
meaningful sub-operation.

## Practical rules

- Configure logging on a supplied Fastify host and let τjs inherit it.
- Use metadata first and semantic message second.
- Prefer existing child bindings over repeating request identity and service names.
- Use `request.log` for host hooks and `ctx.logger` for route and service work.
- Keep secrets out of log metadata and service parameters; configure sink redaction.
- Treat τjs episodes as development response evidence, not an OpenTelemetry replacement.
- Use the request graph for declarations and episodes for observed execution.

Related guides:

- [Host Ownership](/guides/host-ownership/) for logger and episode scope
- [Services](/guides/services/) for service records and errors
- [Authentication](/guides/authentication/) for the Fastify auth boundary
- [Data Loading](/guides/data-loading/) for critical and deferred episode outcomes
