# Contract register

The guarantees live in the contract documents owned and shipped by each package. This register
holds links only, so there is one authoritative statement of each contract.

| Id                         | Owner           | Document                                                                               | Participants                                                | Evidence coverage                                                                                                    |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `server:render-strategies` | `@taujs/server` | [Render strategies and the default](../packages/server/contracts/render-strategies.md) | `@taujs/server`                                             | Configuration types, graph emission and MCP retrieval cells cover the declared values and visible default.           |
| `server:request-identity`  | `@taujs/server` | [Request identity](../packages/server/contracts/request-identity.md)                   | `@taujs/server`, Fastify host                               | Created-host and caller-owned-host matrices cover identity selection, propagation, response echo and episode naming. |
| `server:render-module`     | `@taujs/server` | [Render module boundary](../packages/server/contracts/render-module.md)                | `@taujs/react`, `@taujs/vue`, `@taujs/solid`, `@taujs/html` | Host integration cells and renderer-owned behavioural cells cover the common seam and the recorded differences.      |
