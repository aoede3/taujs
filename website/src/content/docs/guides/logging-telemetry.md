---
title: Logging & Telemetry
description: Logger ownership, request identity and τjs development traces
---

τjs produces two related forms of operational evidence:

- structured log records delivered through the selected logger
- development request traces describing how τjs resolved and rendered a response

They share request correlation, but they are not the same system. A log sink is an operational stream;
a τjs trace is a bounded application-response record for local introspection and MCP tools.

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

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "params.password",
      "params.token",
    ],
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: { colorize: true },
          },
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
Typical bindings include `traceId`, Fastify `reqId`, URL and method.

Service dispatch creates another child with `component: "service-call"`, service name and method. Do
not manually repeat these fields on every service record unless the local value is genuinely
different.

## Request identity

Fastify and τjs retain two field names:

- `reqId` is the identity Fastify assigned to the HTTP request
- `traceId` is the correlation value τjs uses for its response lifecycle

τjs chooses `traceId` in this order:

1. a valid inbound `x-trace-id`
2. Fastify `req.id`, converted from string or number
3. `crypto.randomUUID()`

Accepted inbound values contain letters, numbers, hyphens, underscores, dots or colons and are no
longer than 128 characters.

When no valid inbound header overrides it, `traceId` and the string form of `reqId` are equal. When a
valid inbound header is present, τjs preserves Fastify's `reqId` and uses the header as `traceId`.
Correlation therefore works without rewriting host identity.

This is application request correlation, not a complete OpenTelemetry or W3C trace/span model.

### Response scope

A τjs-created host installs the trace lifecycle at its root, including its implicit shell and
not-found path. A caller-owned host installs it inside the encapsulated τjs scope. Host routes then
retain their own logging and do not receive a τjs `x-trace-id` response header.

Every τjs-owned response receives its selected value:

```text
x-trace-id: request-42
```

See [Host Ownership](/guides/host-ownership/#request-identity-and-trace-scope) for the installation
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
      headers: { "x-trace-id": ctx.traceId },
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

Fastify hooks outside the τjs scope should use `request.log` and `request.id`. Do not assume a τjs
`traceId` property is attached to the Fastify request object.

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

## Development request traces

In development, τjs records a bounded trace for each τjs-owned response. A trace includes:

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
├── traces.ndjson
├── logs.ndjson
└── observations.json
```

`dev.json` describes the current live process and is removed on graceful close. Trace and log mirrors
remain, with `bootId` distinguishing stale data. Late deferred outcomes advance the trace revision and
are written to `traces.ndjson`, so MCP reads do not lose results that settle after the main trace
terminal.

These artefacts are development evidence, not a production telemetry exporter. See
[MCP Reference](/reference/mcp/) for the tools that read them.

## Logs and traces

Logs answer operational questions over time: what failed, what a dependency reported and what the
process is doing. Request traces answer one τjs-specific question: how this application response was
resolved and rendered.

Use both where they add value:

| Need | Primary evidence |
| --- | --- |
| Host lifecycle and infrastructure | Fastify or process logs |
| One response's app, route and render path | τjs request trace |
| Downstream failure detail | Structured service log |
| Declared architecture | Request graph |
| Deferred key outcome and timing | τjs request trace |
| Cross-service distributed trace | External telemetry system |

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

Development traces apply a key-name denylist, depth and length caps, and remove query values. Those
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
- Prefer existing child bindings over repeating `traceId` and service names.
- Use `request.log` for host hooks and `ctx.logger` for route and service work.
- Keep secrets out of log metadata and service parameters; configure sink redaction.
- Treat τjs traces as development response evidence, not an OpenTelemetry replacement.
- Use the request graph for declarations and traces for observed execution.

Related guides:

- [Host Ownership](/guides/host-ownership/) for logger and trace scope
- [Services](/guides/services/) for service records and errors
- [Authentication](/guides/authentication/) for the Fastify auth boundary
- [Data Loading](/guides/data-loading/) for critical and deferred trace outcomes
