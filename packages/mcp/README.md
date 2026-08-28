# @taujs/mcp

> MCP server for [τjs](https://taujs.dev) apps: gives AI agents ground truth about the
> routes, services, and live request behaviour τjs owns - read from files the dev server
> already emits, never guessed from source.

## What it is

A filesystem-only stdio MCP adapter. A τjs dev boot emits an introspection substrate under
`node_modules/.taujs/` - the **request graph** (every declared route's contract), **request
episodes** (per-request records with timings, service calls, and outcomes), a redacted logs
annex, and observed route → service edges. `taujs-mcp` reads those files and serves them
as query-shaped MCP tools. It opens no network connections and loads no config.

The graph covers what τjs owns: routes declared in taujs config and services in its
registry. Routes registered directly on the Fastify instance, and service calls made
outside τjs request handling, are not represented - declared or observed.
`taujs_overview` states this boundary and per-service declared-edge coverage in every
response, and absence from the graph never means absence from the application.

## Setup

New apps scaffolded with `@taujs/create-taujs` are wired automatically. For an existing
app:

```bash
pnpm add -D @taujs/mcp
```

```jsonc
// .mcp.json (project root)
{
  "mcpServers": {
    "taujs": { "command": "pnpm", "args": ["exec", "taujs-mcp"] },
  },
}
```

(`npx --no-install taujs-mcp` for npm, `yarn exec taujs-mcp` for yarn - always the
project's pinned version, never registry-latest.)

Run `pnpm dev` once so the substrate exists, then point your MCP client at the project.

## Tools

| Tool                        | Answers                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `taujs_overview`            | The graph's boundary, apps, routes, services with declared-edge coverage - start here          |
| `taujs_list_routes`         | Declared routes with effective render/hydrate + data kind                                      |
| `taujs_get_route`           | One route's full graph row + its warnings                                                      |
| `taujs_who_calls_service`   | Route → service edges, labelled `declared` vs `observed`; empty edges = known but unreferenced |
| `taujs_explain_route`       | Composed explanation: render, data edge, schema flags, middleware                              |
| `taujs_get_recent_episodes` | Recent request episodes (live dev boot only)                                                   |
| `taujs_get_episode`         | One episode: timeline, service calls, hydration, error                                         |
| `taujs_get_episode_logs`    | That episode's log lines, on demand (`warn+` default)                                          |
| `taujs_doctor`              | Bounded graph diagnostics: graph warnings, defaulted renders, failed episodes                  |

Plus three skills as MCP prompts (broken-route diagnosis, hydration-mismatch triage,
add-a-streamed-route).

## Semantics you can rely on

- **Staleness is stated**: answers from files without a live boot cite
  `source` + `emittedAt` ("as of the last dev boot at …").
- **Runtime tools refuse without a live boot** - structural tools keep working.
- **Sources are labelled**: `declared` (from config) vs `observed` ("seen in dev
  traffic" - absence means _not exercised yet_, never "no relationship"). Observations
  from a previous boot are masked while a boot is live.
- **Extent is stated**: the graph describes what τjs owns; a clean `taujs_doctor` report
  means "no τjs graph warnings", never an application health verdict.
- **Version-skew safe**: a graph from a newer `@taujs/server` degrades with an explicit
  upgrade message, never a misread.
- Field values in responses are your application's data - treated as untrusted, capped,
  and never instructions. Episode URLs never include query values.
- **Results carry `structuredContent`** alongside the JSON text: the server speaks both
  the 2025-era and 2026-07-28 protocol revisions - the client's opening selects the era.

Introspection exists only in dev (structurally - production builds never load it), and
this adapter needs no token: the files are its credential.

## License

MIT © John Smith | Aoede. Attribution appreciated.
