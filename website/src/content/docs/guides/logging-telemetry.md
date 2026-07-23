---
title: Logging & Telemetry
description: Structured logging with request tracing and debug categories
---

How τjs provides structured logging with request tracing and debug categories.

τjs includes a flexible logging system that integrates with popular Node.js loggers (Pino, Winston) while also providing its own structured logger. The system supports:

- Request-scoped logging with trace IDs
- Debug categories for granular control
- Integration with Fastify's logger
- Child loggers for contextual logging

## Using Fastify's Logger

The recommended approach is to use Fastify's built-in Pino logger:

```typescript
// server/index.ts
import Fastify from "fastify";
import pino from "pino";
import { createServer } from "@taujs/server";

const fastify = Fastify({
  logger: pino({
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    transport:
      process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: { colorize: true },
          }
        : undefined,
  }),
});

await createServer({
  fastify,
  config,
  serviceRegistry,
  clientRoot: "./client",
});
```

τjs automatically uses `fastify.log` for internal logging.

## Request Tracing

### Automatic Trace ID Generation

τjs's SSR handler generates or extracts trace IDs for request correlation:

**Trace ID priority:**

1. `x-trace-id` header (if valid)
2. `req.id` from Fastify
3. Generated via `crypto.randomUUID()`

**Validation:** Trace IDs must be alphanumeric with hyphens, underscores, dots, or colons, max 128 characters.

### Trace ID in Response

For SSR routes, τjs automatically adds the trace ID to response headers:

```typescript
// Automatic for τjs SSR routes
'x-trace-id': 'abc123-def456-...'
```

### Accessing Trace ID

In data handlers:

```typescript
{
  path: '/users/:id',
  attr: {
    render: 'ssr',
    data: async (params, ctx) => {
      ctx.logger.info({ userId: params.id }, 'Fetching user');

      // Pass to downstream services
      const res = await fetch(`/api/users/${params.id}`, {
        headers: {
          'x-trace-id': ctx.traceId
        }
      });

      return await res.json();
    }
  }
}
```

In services:

```typescript
export const UserService = defineService({
  getUser: async (params: { id: string }, ctx) => {
    ctx.logger?.info(
      { userId: params.id, traceId: ctx.traceId },
      "Loading user from database"
    );

    const user = await db.users.findById(params.id);
    return { user };
  },
});
```

## Debug Categories

τjs supports granular debug logging through categories:

**Available categories:**

- `auth` - Authentication hooks and verification
- `routes` - Route matching and resolution
- `errors` - Error handling and recovery
- `vite` - Vite dev server integration
- `network` - Network interface detection
- `ssr` - SSR rendering pipeline

### Enabling Debug Categories

**Enable all:**

```typescript
await createServer({
  fastify,
  config,
  serviceRegistry,
  debug: true, // or { all: true }
});
```

**Enable specific categories:**

```typescript
await createServer({
  fastify,
  config,
  serviceRegistry,
  debug: ["ssr", "routes", "auth"],
});
```

**Enable all except specific:**

```typescript
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

**Using environment variables:**

```bash
DEBUG=ssr,routes,auth npm run dev
```

```typescript
await createServer({
  fastify,
  config,
  serviceRegistry,
  debug: process.env.DEBUG, // τjs parses comma-separated string
});
```

## Child Loggers

### In Data Handlers

Data handlers receive a request-scoped child logger:

```typescript
{
  path: '/users/:id',
  attr: {
    render: 'ssr',
    data: async (params, ctx) => {
      // ctx.logger is a child logger with traceId bound
      ctx.logger.info({ userId: params.id }, 'Loading user data');

      try {
        const user = await db.users.findById(params.id);
        return { user };
      } catch (err) {
        ctx.logger.error({ userId: params.id, error: err }, 'Failed to load user');
        throw err;
      }
    }
  }
}
```

### In Services

Service methods receive a child logger with context:

```typescript
export const OrderService = defineService({
  createOrder: async (params: { userId: string; items: any[] }, ctx) => {
    ctx.logger?.info({ userId: params.userId }, "Creating order");

    const order = await db.orders.create({
      userId: params.userId,
      items: params.items,
    });

    ctx.logger?.info({ orderId: order.id }, "Order created successfully");

    return { order };
  },
});
```

## Structured Logging

### Log Levels

τjs loggers support standard levels:

```typescript
// In data handlers or services
ctx.logger.debug({ detail: "value" }, "Debug message");
ctx.logger.info({ userId: "123" }, "User logged in");
ctx.logger.warn({ attempts: 3 }, "Retry limit approaching");
ctx.logger.error({ error: err }, "Operation failed");
```

### Metadata First, Message Second

τjs follows the pattern: `logger.level(metadata, message)`

```typescript
// Correct - metadata first
ctx.logger.info(
  { userId: params.id, action: "login" },
  "User authentication successful"
);

// Incorrect - message first
ctx.logger.info("User authentication successful", { userId: params.id });
```

### Contextual Information

Include relevant context in every log:

```typescript
export const PaymentService = defineService({
  processPayment: async (params: { orderId: string; amount: number }, ctx) => {
    ctx.logger?.info(
      {
        orderId: params.orderId,
        amount: params.amount,
        userId: ctx.user?.id,
      },
      "Processing payment"
    );

    try {
      const result = await paymentGateway.charge({
        amount: params.amount,
        orderId: params.orderId,
      });

      ctx.logger?.info(
        {
          orderId: params.orderId,
          transactionId: result.id,
          status: result.status,
        },
        "Payment processed successfully"
      );

      return { transaction: result };
    } catch (err) {
      ctx.logger?.error(
        {
          orderId: params.orderId,
          amount: params.amount,
          error: err.message,
          code: err.code,
        },
        "Payment processing failed"
      );

      throw err;
    }
  },
});
```

## Custom Logger Integration

### Winston Adapter

τjs provides a Winston adapter:

```typescript
import winston from "winston";
import { winstonAdapter, createServer } from "@taujs/server";

const winstonLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "app.log" }),
  ],
});

await createServer({
  config,
  serviceRegistry,
  logger: winstonAdapter(winstonLogger),
  debug: ["ssr", "routes"],
});
```

### Custom Logger Adapter

For other logging systems, create a simple adapter:

```typescript
import type { BaseLogger } from "@taujs/server";

function customLoggerAdapter(customLogger: any): BaseLogger {
  const wrap =
    (level: "debug" | "info" | "warn" | "error") =>
    (meta: Record<string, unknown>, message: string) =>
      customLogger[level](message, meta);

  return {
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    child: (ctx) =>
      customLogger.child
        ? customLoggerAdapter(customLogger.child(ctx))
        : customLoggerAdapter(customLogger),
  };
}

await createServer({
  config,
  serviceRegistry,
  logger: customLoggerAdapter(myLogger),
});
```

## Production Configuration

### Pino for Production

```typescript
const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    // No pretty printing in production
    transport:
      process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: { colorize: true, singleLine: false },
          }
        : undefined,
  },
});
```

### Log Sampling

For high-traffic routes, sample verbose logs:

```typescript
{
  path: '/api/metrics',
  attr: {
    render: 'ssr',
    data: async (params, ctx) => {
      const shouldLog = Math.random() < 0.1;  // 10% sampling

      if (shouldLog) {
        ctx.logger.debug({ route: '/api/metrics' }, 'Metrics request');
      }

      return { metrics: await getMetrics() };
    }
  }
}
```

### Error Enrichment

Add context to errors:

```typescript
export const UserService = defineService({
  updateUser: async (params: { id: string; data: any }, ctx) => {
    try {
      const user = await db.users.update({
        where: { id: params.id },
        data: params.data,
      });

      return { user };
    } catch (err) {
      ctx.logger?.error(
        {
          kind: "database",
          operation: "update",
          table: "users",
          userId: params.id,
          error: err.message,
          stack: err.stack,
          traceId: ctx.traceId,
        },
        "Database update failed"
      );

      throw err;
    }
  },
});
```

## Common Patterns

### Authentication Logging

```typescript
fastify.decorate("authenticate", async function (req, reply) {
  try {
    const user = await verifyAuth(req);

    req.log.info(
      {
        event: "auth_success",
        userId: user.id,
        path: req.url,
        method: req.method,
      },
      "User authenticated"
    );

    req.user = user;
  } catch (err) {
    req.log.warn(
      {
        event: "auth_failure",
        path: req.url,
        method: req.method,
        error: err.message,
      },
      "Authentication failed"
    );

    reply.code(401).send({ error: "Unauthorised" });
  }
});
```

### Request Duration Logging

```typescript
fastify.addHook("onRequest", (req, _reply, done) => {
  (req as any).startTime = Date.now();
  done();
});

fastify.addHook("onResponse", (req, reply, done) => {
  const duration = Date.now() - (req as any).startTime;

  req.log.info(
    {
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      duration,
      traceId: (req as any).traceId,
    },
    "Request completed"
  );

  done();
});
```

### Service Performance Logging

```typescript
export const DatabaseService = defineService({
  query: async (params: { sql: string; values: any[] }, ctx) => {
    const start = Date.now();

    try {
      const result = await db.query(params.sql, params.values);

      ctx.logger?.debug(
        {
          operation: "query",
          duration: Date.now() - start,
          rowCount: result.rows.length,
        },
        "Database query completed"
      );

      return { rows: result.rows };
    } catch (err) {
      ctx.logger?.error(
        {
          operation: "query",
          duration: Date.now() - start,
          error: err.message,
          sql: params.sql,
        },
        "Database query failed"
      );

      throw err;
    }
  },
});
```

## Best Practices

### 1. Use Structured Logs

```typescript
// structured
ctx.logger.info(
  { userId: params.id, action: "login", ip: req.ip },
  "User logged in"
);

// less ideal - string interpolation
ctx.logger.info(`User ${params.id} logged in from ${req.ip}`);
```

### 2. Choose Appropriate Levels

```typescript
// Debug - detailed flow
ctx.logger.debug({ route, params }, "Route matched");

// Info - significant events
ctx.logger.info({ userId }, "User authenticated");

// Warn - recoverable issues
ctx.logger.warn({ retries: 3 }, "API retry limit approaching");

// Error - failures
ctx.logger.error({ error, userId }, "Operation failed");
```

### 3. Don't Log Secrets

```typescript
// redact sensitive data
ctx.logger.info(
  {
    email: user.email.replace(/^(.{2}).*@/, "$1***@"),
    action: "password_reset",
  },
  "Password reset requested"
);

// less ideal - logging secrets
ctx.logger.info(
  {
    email: user.email,
    password: params.password, // Never log passwords
    token: authToken, // Never log tokens
  },
  "User login attempt"
);
```

### 4. Include Context

```typescript
// rich context
ctx.logger.error(
  {
    userId: ctx.user?.id,
    orderId: params.orderId,
    error: err.message,
    traceId: ctx.traceId,
    timestamp: new Date().toISOString(),
  },
  "Order processing failed"
);

// ⚠️ Minimal - harder to debug
ctx.logger.error("Order failed");
```

### 5. Log at Boundaries

Log when crossing system boundaries:

```typescript
export const ExternalApiService = defineService({
  fetchData: async (params: { endpoint: string }, ctx) => {
    ctx.logger?.info({ endpoint: params.endpoint }, "Calling external API");

    try {
      const res = await fetch(`https://api.external.com${params.endpoint}`);

      ctx.logger?.info(
        {
          endpoint: params.endpoint,
          status: res.status,
          duration: res.headers.get("x-response-time"),
        },
        "External API call completed"
      );

      return await res.json();
    } catch (err) {
      ctx.logger?.error(
        {
          endpoint: params.endpoint,
          error: err.message,
        },
        "External API call failed"
      );

      throw err;
    }
  },
});
```

<!--
## What's Next?

- [Services](/guides/services) - Use structured logging in services
- [Authentication](/guides/authentication) - Log auth events
- [Multi-App Architecture](/guides/micro-frontends) - Organise logging in larger applications -->
