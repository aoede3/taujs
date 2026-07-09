---
'@taujs/create-taujs': minor
---

P1-04: scaffolded projects wire the τjs MCP adapter — `.mcp.json` in the pinned package-manager-specific local-bin form (`pnpm exec taujs-mcp` / `npx --no-install taujs-mcp` / `yarn exec taujs-mcp`, never registry-latest), `@taujs/mcp` as a devDependency, and a short `CLAUDE.md` pointer telling agents to prefer the MCP tools over reading config by hand — the substance lives in the package so it improves with upgrades.
