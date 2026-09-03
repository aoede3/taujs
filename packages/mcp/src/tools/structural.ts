import { z } from 'zod';

import { compareGraphs, summarizeCompare } from '../GraphCompare';
import { NO_ACTIVE_BOOT_REFUSAL, capStrings, readBaselineGraph, readObservations } from '../SubstrateReader';
import { UNTRUSTED_NOTE, bounded, defineTool, withGraph } from '../toolkit';
import { renderStrategyCitation } from './contracts';

import type { GraphContext, ToolDefinition, ToolResult } from '../toolkit';
import type { GraphRoute, GraphRouteData } from '../types';

const DEFAULT_LIST_LIMIT = 20;
const COMPARE_DEFAULT_LIMIT = 50;
const COMPARE_MAX_LIMIT = 200;

// The comparison boundary, stated once at the tool's entry point (mirrors GRAPH_SCOPE below):
// every field this tool reports is truthful within it, and a caller that does not know the
// boundary could read a clean `identical: true` as a wider guarantee than it is. `services` is
// named explicitly because comparing it would be dishonest across build-vs-boot graphs - a build
// graph may carry `services: null` while a boot graph carries the full registry, which is a
// difference in WHAT WAS EMITTED, not in the declared application - and the declared critical,
// head and deferred service edges that registry would describe remain covered through the route
// facets this tool does compare.
const COMPARE_SCOPE =
  'Compares only declared graph fields: apps (added/removed, entryPoint), routes (added/removed), and per-route facets ' +
  '(render, hydrate, middleware.auth, middleware.csp, data, head, deferred), plus the global security and fallthrough blocks. ' +
  'emittedAt, source, taujs.server, apps[].routeCount, routes[].specificity, services and warnings are never compared: comparing ' +
  'services would be dishonest across build-vs-boot graphs (a build graph may carry services: null while a boot graph does not), ' +
  'and the declared critical, head and deferred service edges a registry describes remain covered through the route facets above. ' +
  'Rows state exact declared differences only - no verdicts, no risk labels. Detection is exact over full declared values; ' +
  'string values shown in rows and metadata are capped at 500 characters for display.';

// The graph's extent, stated once at the entry point: every field in every response is truthful
// WITHIN this boundary, and an agent that does not know the boundary reads the composite as
// application-wide (consumer feedback, 2026-08-19 — an audit agent abandoned the toolset over it).
const GRAPH_SCOPE =
  'This graph covers what taujs owns as declared in config: routes from taujs config and services in its registry. ' +
  'Routes registered directly on the Fastify instance, and service calls made outside taujs request handling, ' +
  'are not represented — declared or observed. Absence from this graph never means absence from the application. ' +
  'The graph states declared configuration, not which application bundles are currently built.';

// Names are search keys: rows lead with exact identifiers an agent can grep for.
const routeRow = (route: GraphRoute) => ({
  id: route.id,
  path: route.path,
  appId: route.appId,
  render: route.render.strategy,
  renderDefaulted: route.render.defaulted,
  hydrate: route.hydrate.enabled,
  data: route.data,
  authDeclared: route.middleware.auth.declared,
});

type RouteSelection = { routes: GraphRoute[] } | { refusal: ToolResult };

const selectRoutes = (ctx: GraphContext, args: { routeId?: string; path?: string }): RouteSelection => {
  const byId = args.routeId !== undefined ? ctx.graph.routes.filter((r) => r.id === args.routeId) : undefined;
  const byPath = args.path !== undefined ? ctx.graph.routes.filter((r) => r.path === args.path) : undefined;
  if (!byId || !byPath) return { routes: byId ?? byPath ?? [] };
  // Both selectors given: they agree when the routeId's route carries the supplied path (the same
  // path existing under another app is not a disagreement). Both missing is an ordinary miss.
  if (byId.length > 0 && byId.every((r) => r.path === args.path)) return { routes: byId };
  if (byId.length === 0 && byPath.length === 0) return { routes: [] };
  return {
    refusal: {
      ok: false,
      reason: 'conflicting_selectors',
      ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
      message: 'routeId and path do not identify the same route. Pass one selector, or both for the same route.',
      routeIdMatches: bounded(
        byId.map((r) => r.id),
        DEFAULT_LIST_LIMIT,
      ),
      pathMatches: bounded(
        byPath.map((r) => r.id),
        DEFAULT_LIST_LIMIT,
      ),
    },
  };
};

const routeMiss = (ctx: GraphContext): ToolResult => ({
  ok: false,
  reason: 'route_not_found',
  message: 'No route matched. Pass routeId (preferred) or an exact declared path.',
  knownRouteIds: bounded(
    ctx.graph.routes.map((r) => r.id),
    DEFAULT_LIST_LIMIT,
  ),
});

export const structuralTools = (root: string): ToolDefinition[] => [
  defineTool({
    name: 'taujs_overview',
    title: 'τjs app overview',
    description: `One-screen summary of the request graph: the graph's boundary, apps, route/service counts with declared-edge coverage, graph warnings, fallthrough posture, freshness. Start here. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({}),
    handler: () =>
      withGraph(root, ({ discovery, graph, stalenessLine }) => ({
        ok: true,
        mode: discovery.mode,
        ...(stalenessLine ? { staleness: stalenessLine } : {}),
        scope: GRAPH_SCOPE,
        taujsServer: graph.taujs.server,
        source: graph.source,
        emittedAt: graph.emittedAt,
        episodesAvailable: discovery.mode === 'active',
        ...(discovery.mode === 'active' ? {} : { episodesNote: NO_ACTIVE_BOOT_REFUSAL.message }),
        apps: graph.apps,
        routeCount: graph.routes.length,
        services:
          graph.services === null
            ? 'unavailable (registry not present in this graph — declared edges still on routes)'
            : graph.services.map((s) => ({
                name: s.name,
                methodCount: s.methods.length,
                // usedBy already includes deferred edges (RFC 0007 R5) — the one number that says
                // how much of this service the graph explains.
                withDeclaredEdges: s.methods.filter((m) => m.usedBy.length > 0).length,
                methods: s.methods.map((m) => m.name),
              })),
        graphWarningCounts: graph.warnings.reduce<Record<string, number>>((acc, w) => ({ ...acc, [w.severity]: (acc[w.severity] ?? 0) + 1 }), {}),
        fallthrough: graph.fallthrough,
      })),
  }),
  defineTool({
    name: 'taujs_list_routes',
    title: 'List declared routes',
    description: `Routes from the request graph with effective render/hydrate values, data kind, and auth posture. Filter by appId; bounded by limit. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      appId: z.string().optional().describe('Filter to one app'),
      limit: z.number().int().positive().max(200).optional().describe(`Max rows (default ${DEFAULT_LIST_LIMIT})`),
    }),
    handler: (args) =>
      withGraph(root, ({ graph, stalenessLine }) => {
        const appId = args.appId;
        const limit = args.limit ?? DEFAULT_LIST_LIMIT;
        const routes = graph.routes.filter((r) => !appId || r.appId === appId).map(routeRow);

        return { ok: true, ...(stalenessLine ? { staleness: stalenessLine } : {}), routes: bounded(routes, limit) };
      }),
  }),
  defineTool({
    name: 'taujs_get_route',
    title: 'Get one route',
    description: `Full graph row for one route (by routeId or exact path) plus its warnings. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      routeId: z.string().optional().describe('Stable id, e.g. "storefront:/product/:id"'),
      path: z.string().optional().describe('Exact declared path, e.g. "/product/:id"'),
    }),
    handler: (args) =>
      withGraph(root, (ctx) => {
        const selection = selectRoutes(ctx, args);
        if ('refusal' in selection) return selection.refusal;
        const matches = selection.routes;
        if (matches.length === 0) return routeMiss(ctx);

        return {
          ok: true,
          ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
          routes: matches.map((route) => ({
            ...route,
            warnings: ctx.graph.warnings.filter((w) => w.routeId === route.id),
          })),
        };
      }),
  }),
  defineTool({
    name: 'taujs_who_calls_service',
    title: 'Who calls a service',
    description: `Route → service edges for a service (optionally one method). Each edge is labelled declared (from config: a serviceData edge, a deferred entry or a head edge) or observed (seen in dev traffic — absence means "not exercised yet", never "no relationship"). A known service with zero edges is a successful empty result, not an error. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      service: z.string().describe('Service name, e.g. "catalog"'),
      method: z.string().optional().describe('Method name, e.g. "getProduct"'),
    }),
    handler: (args) =>
      withGraph(root, (ctx) => {
        const service = args.service;
        const method = args.method;

        const matches = (edge: GraphRouteData): edge is { kind: 'service'; service: string; method: string } =>
          edge.kind === 'service' && edge.service === service && (!method || edge.method === method);

        // Declared edges mirror the graph's own usedBy derivation (RFC 0007 R5): the route's data
        // edge AND its deferred entries. Per route, at most one row per method — data edge first.
        const declared = ctx.graph.routes.flatMap((r) => {
          const rows = new Map<string, 'serviceData' | 'deferred' | 'head'>();
          if (matches(r.data)) rows.set(r.data.method, 'serviceData');
          for (const entry of r.deferred ?? []) {
            if (matches(entry.data) && !rows.has(entry.data.method)) rows.set(entry.data.method, 'deferred');
          }
          // head edge, mirrors data (decisions.md 2026-08-27): lowest precedence, same dedupe.
          if (r.head && matches(r.head.data) && !rows.has(r.head.data.method)) rows.set(r.head.data.method, 'head');

          return [...rows.entries()].map(([edgeMethod, declaredVia]) => ({
            source: 'declared' as const,
            service,
            method: edgeMethod,
            declaredVia,
            routeId: r.id,
            appId: r.appId,
            path: r.path,
          }));
        });

        // readObservations masks a foreign-boot file while a boot is active, so "seen in dev
        // traffic" can never describe a previous boot's edges.
        const obs = readObservations(ctx.discovery);
        // Observations are emitted by a different event than the graph, so their freshness is their own.
        const observedStaleness =
          ctx.discovery.mode !== 'active' && obs.ok
            ? {
                observedStaleness: `Observations document from dev boot ${obs.observations.bootId}, last updated at ${obs.observations.updatedAt} — no active dev server, so observations may be stale independently of the graph.`,
              }
            : {};
        const observed = obs.ok
          ? obs.observations.edges
              .filter((e) => e.service === service && (!method || e.method === method))
              .flatMap((e) =>
                e.routes.map((r) => ({
                  source: 'observed' as const,
                  service,
                  method: e.method,
                  routeId: r.routeId,
                  appId: r.appId,
                  path: r.path,
                  // The substrate counts per service.method, not per route: every row of this
                  // method carries the same boot-wide total. routeCallCount is that route's own
                  // attribution, present since the spec 03 §4 additive field (2026-08-20).
                  methodCallCount: e.count,
                  ...(typeof r.count === 'number' ? { routeCallCount: r.count } : {}),
                  lastObservedAt: e.lastObservedAt,
                })),
              )
          : [];

        // Resolution comes BEFORE the edge check: routes/observations and the registry are
        // emitted independently, so a dangling edge can reference an identifier the registry
        // does not have. `ok` answers "did the identifier resolve" — the dangling edges are
        // still returned, labelled, because they are real config the asker is likely chasing.
        if (ctx.graph.services) {
          const dangling = [...declared, ...observed];
          const danglingFields =
            dangling.length > 0
              ? {
                  danglingEdges: dangling,
                  danglingNote: 'These edges reference the unresolved identifier — route config (or observed traffic) and the registry disagree.',
                }
              : {};

          // Error responses cite staleness like every other non-active answer: against a stale
          // graph, "unknown" (and any dangling edges) describes the LAST boot, not now.
          const svc = ctx.graph.services.find((s) => s.name === service);
          if (!svc) {
            return {
              ok: false,
              reason: 'unknown_service',
              ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
              ...observedStaleness,
              message: `No service "${service}" in the registry.`,
              knownServices: bounded(
                ctx.graph.services.map((s) => s.name),
                DEFAULT_LIST_LIMIT,
              ),
              ...danglingFields,
            };
          }
          if (method && !svc.methods.some((m) => m.name === method)) {
            return {
              ok: false,
              reason: 'unknown_method',
              ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
              ...observedStaleness,
              message: `Service "${service}" has no method "${method}".`,
              knownMethods: bounded(
                svc.methods.map((m) => m.name),
                DEFAULT_LIST_LIMIT,
              ),
              ...danglingFields,
            };
          }
        }

        if (declared.length === 0 && observed.length === 0) {
          const emptyNote = `No declared or observed edges for "${service}${method ? `.${method}` : ''}". Observed edges only exist for traffic seen this boot; the service may still be called from code outside the graph.`;

          // Registry present and the identifier resolved above: a successful empty result —
          // agents branch hard on `ok`, and this is "the answer is none", not "I asked wrong".
          if (ctx.graph.services) {
            return { ok: true, ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}), ...observedStaleness, edges: [], note: emptyNote };
          }

          // Registry absent: existence cannot be checked — say so rather than guess either way.
          const seen = [
            ...new Set(
              ctx.graph.routes
                .flatMap((r) => [r.data, ...(r.deferred ?? []).map((e) => e.data), ...(r.head ? [r.head.data] : [])])
                .flatMap((d) => (d.kind === 'service' ? [d.service] : [])),
            ),
          ];
          return {
            ok: true,
            ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
            ...observedStaleness,
            edges: [],
            note: `${emptyNote} The registry is not present in this graph, so whether "${service}" exists cannot be checked.`,
            servicesSeenOnRouteEdges: bounded(seen, DEFAULT_LIST_LIMIT),
          };
        }

        return {
          ok: true,
          ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
          ...observedStaleness,
          note: 'declared = from config (a serviceData edge, a deferred entry or a head edge); observed = seen in dev traffic, never complete truth. methodCallCount is the method-wide total for the boot; routeCallCount is that route’s own attribution.',
          edges: [...declared, ...observed],
        };
      }),
  }),
  defineTool({
    name: 'taujs_explain_route',
    title: 'Explain a route',
    description: `Composed explanation of one route: effective render/hydrate, data edge with schema flags, middleware posture, the schema-v1 declaration score (not Fastify runtime precedence), and its warnings. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      routeId: z.string().optional().describe('Stable id, e.g. "storefront:/product/:id"'),
      path: z.string().optional().describe('Exact declared path'),
    }),
    handler: (args) =>
      withGraph(root, (ctx) => {
        const selection = selectRoutes(ctx, args);
        if ('refusal' in selection) return selection.refusal;
        const matches = selection.routes;
        if (matches.length === 0) return routeMiss(ctx);

        // Contract-backed enrichment only (RFC 0015 Phase B): absent on older or mismatched
        // installations, while every existing fact keeps flowing.
        const citation = renderStrategyCitation(root, ctx.graph.taujs?.server);

        return {
          ok: true,
          ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
          explanations: matches.map((route) => {
            const data = route.data;
            const dataEdge =
              data.kind === 'service'
                ? {
                    kind: 'service' as const,
                    service: data.service,
                    method: data.method,
                    source: 'declared' as const,
                    schema:
                      ctx.graph.services?.find((s) => s.name === data.service)?.methods.find((m) => m.name === data.method) ??
                      'registry not present in this graph',
                  }
                : data;

            return {
              id: route.id,
              path: route.path,
              appId: route.appId,
              render: {
                ...route.render,
                note: route.render.defaulted ? 'render was not declared; runtime default ssr applies' : undefined,
                ...(citation ? { contract: citation } : {}),
              },
              hydrate: route.hydrate,
              specificity: route.specificity,
              middleware: route.middleware,
              data: dataEdge,
              // head edge, mirrors data (decisions.md 2026-08-27): projected field, absent unless declared.
              ...(route.head ? { head: route.head } : {}),
              warnings: ctx.graph.warnings.filter((w) => w.routeId === route.id),
            };
          }),
        };
      }),
  }),
  defineTool({
    name: 'taujs_compare_graphs',
    title: 'Compare request graphs',
    description: `Compares a retained baseline request graph (a file the caller copied earlier, given as a project-relative baselinePath) against the currently emitted graph and reports exact declared differences - apps added/removed/entryPoint-changed, routes added/removed, and per-route facet changes (render, hydrate, middleware.auth, middleware.csp, data, head, deferred), plus the global security and fallthrough blocks. No verdicts. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      baselinePath: z.string().describe('Project-relative path to a previously retained graph.json'),
      limit: z.number().int().positive().max(COMPARE_MAX_LIMIT).optional().describe(`Max change rows (default ${COMPARE_DEFAULT_LIMIT})`),
    }),
    handler: (args) =>
      withGraph(
        root,
        (ctx) => {
          // ONE uncapped snapshot (cap: false below) backs staleness, metadata and the comparison
          // alike - a second read could race a graph rewrite into an internally inconsistent
          // response, and a capped read would make two values sharing their first 500 characters
          // compare equal (a false `identical: true`). This handler therefore owns the display
          // cap: every untrusted string is capped where it enters the response.
          const baseline = readBaselineGraph(root, args.baselinePath);
          // Refusals echo untrusted input (the supplied path, a malformed version value) - capped
          // at this boundary like every other emitted string.
          if (!baseline.ok) return capStrings({ ok: false, reason: baseline.reason, message: baseline.message });

          const limit = args.limit ?? COMPARE_DEFAULT_LIMIT;
          const rows = compareGraphs(baseline.graph, ctx.graph);
          const summary = summarizeCompare(rows);

          // `identical` and `summary` describe the uncapped comparison; capStrings caps only what
          // is displayed.
          return {
            ok: true,
            identical: rows.length === 0,
            ...(ctx.stalenessLine ? { staleness: capStrings(ctx.stalenessLine) } : {}),
            baseline: capStrings({
              path: args.baselinePath,
              source: baseline.graph.source,
              emittedAt: baseline.graph.emittedAt,
              taujsServer: baseline.graph.taujs.server,
              schemaVersion: baseline.graph.schemaVersion,
            }),
            current: capStrings({
              source: ctx.graph.source,
              emittedAt: ctx.graph.emittedAt,
              taujsServer: ctx.graph.taujs.server,
              schemaVersion: ctx.graph.schemaVersion,
            }),
            summary,
            changes: capStrings(bounded(rows, limit)),
            scope: COMPARE_SCOPE,
          };
        },
        { cap: false },
      ),
  }),
];
