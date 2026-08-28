---
'@taujs/mcp': minor
---

`@taujs/mcp` now runs on the official `@modelcontextprotocol/server` v2 package. `serveStdio` serves 2025-era clients by default and the 2026-07-28 protocol revision when a client negotiates it. Tool results now carry `structuredContent` alongside the existing JSON text, and handlers are typed from their `z.object` input schema.

**Breaking** (pre-1.0 minor): `createTaujsMcpServer()` now returns the v2 `McpServer` from `@modelcontextprotocol/server`, which is not interchangeable with v1 transports or clients - a consumer that connects the returned server itself must use `@modelcontextprotocol/server` transports (`StdioServerTransport`, `InMemoryTransport`) or `serveStdio`; `allTools()` entries now carry `inputSchema` as `z.object` instances and their handlers expect parsed arguments - a consumer dispatching handlers directly must validate with `tool.inputSchema.parse(args)` first, because the hand narrowing the handlers used to do is gone. Migration: replace `@modelcontextprotocol/sdk` imports with the v2 packages as in the SDK migration guide.
