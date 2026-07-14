---
title: MCP Server (@taujs/mcp)
description: Give AI agents ground truth about your routes, services, and live request behaviour
---

`@taujs/mcp` is an MCP (Model Context Protocol) server for τjs applications. It gives AI agents ground truth about your routes, services, and live request behaviour - read from files the dev server already emits, never guessed from source.

## What It Is

A filesystem-only stdio MCP adapter. A τjs dev boot emits an introspection substrate under `node_modules/.taujs/`:

- **Request graph** - every route's contract: render strategy, data dependencies, schema flags, middleware
- **Request traces** - per-request records with timings, service calls, and outcomes
- **Logs annex** - redacted log lines tied to traces
- **Observed edges** - route → service relationships seen in real dev traffic

`taujs-mcp` reads those files and serves them as query-shaped MCP tools. It opens no network connections and loads no configuration - the files are its credential.

Live introspection is development-only: traces, logs, and observations are collected by the dev server, and the production server runtime structurally excludes those collectors - there is nothing to switch off. Builds do emit one artefact: a structure-only graph at `dist/.taujs/graph.json`. When no dev substrate exists, the adapter deliberately falls back to that graph, so structural tools can still answer from the last build - labelled stale, with `source: "build"`. Builds never emit runtime traces.

## Setup

New apps scaffolded with `@taujs/create-taujs` are wired automatically. For an existing app:

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

Use `npx --no-install taujs-mcp` for npm, or `yarn exec taujs-mcp` for yarn - always the project's pinned version, never registry-latest.

Run `pnpm dev` once so the full substrate exists, then point your MCP client at the project. A prior build is enough for the structural tools; the runtime tools need a dev boot.

## Tools

| Tool                      | Answers                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `taujs_overview`          | Apps, routes, services, warnings, fallthrough posture - start here |
| `taujs_list_routes`       | Declared routes with effective render/hydrate and data kind        |
| `taujs_get_route`         | One route's full graph row plus its warnings                       |
| `taujs_who_calls_service` | Route → service edges, labelled `declared` vs `observed`           |
| `taujs_explain_route`     | Composed explanation: render, data edge, schema flags, middleware  |
| `taujs_get_recent_traces` | Recent request traces (live dev boot only)                         |
| `taujs_get_trace`         | One trace: timeline, service calls, hydration, error               |
| `taujs_get_trace_logs`    | That trace's log lines, on demand (`warn` and above by default)    |
| `taujs_doctor`            | Bounded health report: warnings, defaulted renders, failed traces  |

Three skills also ship as MCP prompts: broken-route diagnosis, hydration-mismatch triage, and add-a-streamed-route.

## Semantics You Can Rely On

- **Staleness is stated** - answers from files without a live boot cite `source` and `emittedAt` ("as of the last dev boot or build at ...")
- **Trace tools refuse without a live boot** - `taujs_get_recent_traces`, `taujs_get_trace`, and `taujs_get_trace_logs` refuse rather than answer stale. `taujs_doctor` is hybrid: it still reports graph warnings, fallthrough posture, and defaulted renders cold, marking failed-trace facts unavailable. Structural tools keep working from the last emitted graph
- **Sources are labelled** - `declared` (from configuration) vs `observed` (seen in dev traffic). Absence of an observed edge means _not exercised yet_, never "no relationship"
- **Version-skew safe** - a graph emitted by a newer `@taujs/server` degrades with an explicit upgrade message, never a misread
- **Untrusted by default** - field values in responses are your application's data: capped, never treated as instructions. Trace URLs never include query values

## Introspection Configuration

The substrate needs no configuration to work. Two optional postures exist in `taujs.config.ts`:

```typescript
export default defineConfig({
  apps: [/* ... */],
  introspection: {
    // Relaxes ONLY the overlay remote-address check;
    // shouts in the boot summary when enabled
    allowNonLoopback: true,
    redaction: {
      // Extends the default denylist (password, token, secret,
      // ssn, auth, cookie, session, key)
      denyKeys: ["internalId"],
      replaceDefaultDenyKeys: false,
    },
  },
});
```

There is deliberately no `enabled` flag: dev-on / prod-absent is structural.

Do not enable `allowNonLoopback` for `@taujs/mcp`. The adapter is filesystem-only and never touches the HTTP overlay endpoints, so the flag grants it no capability. It exists solely for reaching the browser overlay (`/__taujs/*`) from another device on a trusted development network; Host validation and the per-boot token remain enforced either way.

`redaction`, by contrast, is directly MCP-relevant: it controls what reaches the emitted trace and log files the adapter serves.

## When to Use It

Point an agent at `@taujs/mcp` when you want it to:

- Diagnose a failing route from real traces instead of reading source and guessing
- Understand blast radius before changing a service (`taujs_who_calls_service`)
- Triage hydration mismatches with the server stamp and hydration events
- Get an honest health summary of the running dev app (`taujs_doctor`)

Because answers come from emitted files rather than source inference, the agent's picture matches what the server actually did - including relationships that only exist at runtime.
