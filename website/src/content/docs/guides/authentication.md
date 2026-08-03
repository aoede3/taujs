---
title: Authentication
description: How τjs handles route protection and authentication integration
---

How τjs handles route protection and authentication integration.

τjs provides hooks for authentication but does not implement authentication strategies. You provide the authentication logic, and τjs ensures it runs for protected routes.

**Key points:**

- Routes declare authentication requirements via `middleware.auth`
- You implement authentication by decorating Fastify with an `authenticate` function
- τjs calls your `authenticate` function for protected routes
- τjs verifies at startup that authentication is properly configured

## Route Protection

Mark routes that require authentication using `middleware.auth`:

```typescript
// taujs.config.ts
{
  path: '/dashboard',
  attr: {
    render: 'ssr',
    middleware: {
      auth: {}  // Presence of auth object marks route as protected
    }
  }
}
```

**With metadata:**

```typescript
{
  path: '/admin',
  attr: {
    render: 'ssr',
    middleware: {
      auth: {
        roles: ['admin'],
        strategy: 'session'
      }
    }
  }
}
```

τjs doesn't interpret `roles` or `strategy` - these are metadata for your `authenticate` function to read and enforce.

## The Authentication Hook

When a route has `middleware.auth`, τjs automatically runs an `onRequest` hook:

```typescript
// Internal - τjs does this automatically
app.addHook("onRequest", createAuthHook(logger));
```

For each request, τjs:

1. Reads the Fastify-selected route metadata
2. Checks for `attr.middleware.auth`
3. If present, calls `await req.server.authenticate(req, reply)`
4. If `authenticate` sends a reply (for example `401` / `403`) or throws, the request is treated as rejected

## Implementing Authentication

Decorate your Fastify instance with an `authenticate` function:

```typescript
// server/index.ts
import Fastify from "fastify";
import { createServer } from "@taujs/server";
import config from "./taujs.config";

const fastify = Fastify({ logger: false });

// Define your authenticate function
fastify.decorate("authenticate", async function (req, reply) {
  // Your authentication logic here
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    reply.code(401).send({ error: "Missing token" });
    return;
  }

  try {
    const user = await verifyToken(token);
    req.user = user; // Attach user to request
  } catch (err) {
    reply.code(401).send({ error: "Invalid token" });
  }
});

// Register τjs server
await createServer({
  fastify,
  config,
  serviceRegistry,
  clientRoot: "./client",
});

await fastify.listen({ port: 3000 });
```

**What your `authenticate` function should do:**

1. Extract credentials (token, session, etc.)
2. Verify credentials
3. Attach user to request (`req.user`)
4. Send an error response if authentication fails, or throw to fail the request

## Contract Verification

At startup, τjs verifies that authentication is properly configured:

```typescript
// τjs checks at startup
if (hasProtectedRoutes && !fastify.hasDecorator("authenticate")) {
  throw new Error(
    '[τjs] Routes require auth but Fastify is missing .authenticate decorator.'
  );
}
```

**Current behaviour:**

- Fails startup if protected routes exist and `authenticate` is missing
- Surfaces a configuration error before the server starts accepting requests
- Returns `500` at runtime only if the decorator disappears after startup or the server is otherwise misconfigured

## Route Metadata

Your `authenticate` function can access route metadata to implement custom logic:

```typescript
fastify.decorate("authenticate", async function (req, reply) {
  // Route metadata is attached by τjs
  const routeMeta = (req as any).routeMeta;
  const authConfig = routeMeta?.attr?.middleware?.auth;

  // Extract user
  const user = await verifySession(req);

  if (!user) {
    reply.code(401).send({ error: "Unauthorised" });
    return;
  }

  // Check roles if specified
  const requiredRoles = authConfig?.roles;
  if (
    requiredRoles &&
    !requiredRoles.some((role) => user.roles?.includes(role))
  ) {
    reply.code(403).send({ error: "Forbidden" });
    return;
  }

  // Attach user to request
  req.user = user;
});
```

**Available in `routeMeta`:**

- `attr.middleware.auth.roles` - Role requirements (if specified)
- `attr.middleware.auth.strategy` - Strategy name (if specified)
- Any other properties you add to `attr.middleware.auth`

## Authentication Strategies

### JWT Authentication

```typescript
import fastifyJWT from "@fastify/jwt";

// Register JWT plugin
await fastify.register(fastifyJWT, {
  secret: process.env.JWT_SECRET,
});

// Implement authenticate
fastify.decorate("authenticate", async function (req, reply) {
  try {
    await req.jwtVerify();
    // req.user is populated by @fastify/jwt
  } catch (err) {
    reply.code(401).send({ error: "Invalid token" });
  }
});
```

### Session Authentication

```typescript
import fastifySession from "@fastify/session";
import fastifyCookie from "@fastify/cookie";

// A secure cookie describes the TRANSPORT this process is served over, not the build mode.
// Keying it to `NODE_ENV === "production"` sends session cookies in clear whenever the variable
// is `staging`, `test` or unset - all of which τjs runs as production. Declare the transport and
// default to secure, so a missing value fails closed.
const secureCookies = process.env.COOKIE_SECURE !== "false";

// Register session plugins
await fastify.register(fastifyCookie);
await fastify.register(fastifySession, {
  secret: process.env.SESSION_SECRET,
  cookie: {
    secure: secureCookies,
  },
});

// Implement authenticate
fastify.decorate("authenticate", async function (req, reply) {
  const userId = req.session.get("userId");

  if (!userId) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }

  const user = await db.users.findById(userId);

  if (!user) {
    reply.code(401).send({ error: "User not found" });
    return;
  }

  req.user = user;
});
```

### Multiple Strategies

Use different authentication strategies per route:

```typescript
fastify.decorate("authenticate", async function (req, reply) {
  const routeMeta = (req as any).routeMeta;
  const strategy = routeMeta?.attr?.middleware?.auth?.strategy || "default";

  switch (strategy) {
    case "jwt":
      await authenticateJWT(req, reply);
      break;
    case "session":
      await authenticateSession(req, reply);
      break;
    case "api-key":
      await authenticateApiKey(req, reply);
      break;
    default:
      reply.code(401).send({ error: "Unknown strategy" });
  }
});
```

**Usage:**

```typescript
// JWT for API routes
{
  path: '/api/users',
  attr: {
    render: 'ssr',
    middleware: {
      auth: { strategy: 'jwt' }
    }
  }
}

// Session for web routes
{
  path: '/dashboard',
  attr: {
    render: 'ssr',
    middleware: {
      auth: { strategy: 'session' }
    }
  }
}
```

## Identity in Route Data and Services

Your `authenticate` decorator may attach identity to `req.user`. That value remains available to
later Fastify hooks and handlers on the same request.

τjs does not currently copy `req.user` into the route data context, and declaring
`middleware.auth` does not populate `ServiceContext.user`. Do not write a loader or service on the
assumption that `ctx.user` appeared automatically.

When rendered data depends on identity, make that server-side resolution explicit. For example, a
route loader can validate the trusted session headers and pass the resulting identifier to a
service:

```typescript
{
  path: "/profile",
  attr: {
    render: "ssr",
    middleware: { auth: {} },
    data: async (_params, ctx) => {
      const session = await verifySession(ctx.headers ?? {});

      if (!session) {
        throw new Error("Authentication required");
      }

      return ctx.call("ProfileService", "getCurrentUser", {
        userId: session.userId,
      });
    },
  },
}
```

The service receives the identity as an ordinary, validated parameter:

```typescript
export const ProfileService = defineService({
  getCurrentUser: async (params: { userId: string }) => {
    const user = await db.users.findById(params.userId);

    return { user };
  },
});
```

Keep credential interpretation in server code. Return only the identity-derived data the page
needs, and never expose session tokens through critical or deferred route data.

## Best Practices

### 1. Use Secure Session Configuration

```typescript
// Default secure; set COOKIE_SECURE=false only where the application is served over plain HTTP,
// such as local development. Never derive this from NODE_ENV: `staging`, `test` and an unset
// variable are all production to τjs, and would silently drop the flag.
const secureCookies = process.env.COOKIE_SECURE !== "false";

await fastify.register(fastifySession, {
  secret: process.env.SESSION_SECRET,
  cookie: {
    secure: secureCookies, // HTTPS only
    httpOnly: true, // Prevent XSS
    sameSite: "lax", // CSRF protection
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});
```

### 2. Validate JWT Properly

```typescript
fastify.decorate("authenticate", async function (req, reply) {
  try {
    const decoded = await req.jwtVerify();

    // Load fresh user data (don't trust token claims blindly)
    const user = await db.users.findById(decoded.userId);

    if (!user || !user.active) {
      reply.code(401).send({ error: "User not found or inactive" });
      return;
    }

    req.user = user;
  } catch (err) {
    reply.code(401).send({ error: "Invalid token" });
  }
});
```

### 3. Log Authentication Events

```typescript
fastify.decorate("authenticate", async function (req, reply) {
  try {
    const user = await verifyAuth(req);

    req.log.info(
      {
        event: "auth_success",
        userId: user.id,
        path: req.url,
      },
      "User authenticated"
    );

    req.user = user;
  } catch (err) {
    req.log.warn(
      {
        event: "auth_failure",
        path: req.url,
        error: err.message,
      },
      "Authentication failed"
    );

    reply.code(401).send({ error: "Unauthorised" });
  }
});
```

## Related guides

- [Content Security Policy](/guides/content-security-policy/) for response policy
- [Logging & Telemetry](/guides/logging-telemetry/) for authentication records
- [Services](/guides/services/) for explicit service parameters and context
