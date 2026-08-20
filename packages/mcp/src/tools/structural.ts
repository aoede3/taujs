import { z } from 'zod';

import { NO_ACTIVE_BOOT_REFUSAL, readObservations } from '../SubstrateReader';
import { UNTRUSTED_NOTE, bounded, withGraph } from '../toolkit';

import type { GraphContext, ToolDefinition, ToolResult } from '../toolkit';
import type { GraphRoute, GraphRouteData } from '../types';

const DEFAULT_LIST_LIMIT = 20;

// The graph's extent, stated once at the entry point: every field in every response is truthful
// WITHIN this boundary, and an agent that does not know the boundary reads the composite as
// application-wide (consumer feedback, 2026-08-19 — an audit agent abandoned the toolset over it).
const GRAPH_SCOPE =
  'This graph covers what taujs owns: routes declared in taujs config and services in its registry. ' +
  'Routes registered directly on the Fastify instance, and service calls made outside taujs request handling, ' +
  'are not represented — declared or observed. Absence from this graph never means absence from the application.';

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

const findRoutes = (ctx: GraphContext, args: { routeId?: string; path?: string }): GraphRoute[] => {
  if (args.routeId) return ctx.graph.routes.filter((r) => r.id === args.routeId);
  if (args.path) return ctx.graph.routes.filter((r) => r.path === args.path);
  return [];
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
  {
    name: 'taujs_overview',
    title: 'τjs app overview',
    description: `One-screen summary of the request graph: the graph's boundary, apps, route/service counts with declared-edge coverage, graph warnings, fallthrough posture, freshness. Start here. ${UNTRUSTED_NOTE}`,
    inputSchema: {},
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
  },
  {
    name: 'taujs_list_routes',
    title: 'List declared routes',
    description: `Routes from the request graph with effective render/hydrate values, data kind, and auth posture. Filter by appId; bounded by limit. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      appId: z.string().optional().describe('Filter to one app'),
      limit: z.number().int().positive().max(200).optional().describe(`Max rows (default ${DEFAULT_LIST_LIMIT})`),
    },
    handler: (args) =>
      withGraph(root, ({ graph, stalenessLine }) => {
        const appId = typeof args.appId === 'string' ? args.appId : undefined;
        const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIST_LIMIT;
        const routes = graph.routes.filter((r) => !appId || r.appId === appId).map(routeRow);

        return { ok: true, ...(stalenessLine ? { staleness: stalenessLine } : {}), routes: bounded(routes, limit) };
      }),
  },
  {
    name: 'taujs_get_route',
    title: 'Get one route',
    description: `Full graph row for one route (by routeId or exact path) plus its warnings. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      routeId: z.string().optional().describe('Stable id, e.g. "storefront:/product/:id"'),
      path: z.string().optional().describe('Exact declared path, e.g. "/product/:id"'),
    },
    handler: (args) =>
      withGraph(root, (ctx) => {
        const matches = findRoutes(ctx, args as { routeId?: string; path?: string });
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
  },
  {
    name: 'taujs_who_calls_service',
    title: 'Who calls a service',
    description: `Route → service edges for a service (optionally one method). Each edge is labelled declared (from config: a serviceData edge or a deferred entry) or observed (seen in dev traffic — absence means "not exercised yet", never "no relationship"). A known service with zero edges is a successful empty result, not an error. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      service: z.string().describe('Service name, e.g. "catalog"'),
      method: z.string().optional().describe('Method name, e.g. "getProduct"'),
    },
    handler: (args) =>
      withGraph(root, (ctx) => {
        const service = String(args.service ?? '');
        const method = typeof args.method === 'string' ? args.method : undefined;

        const matches = (edge: GraphRouteData): edge is { kind: 'service'; service: string; method: string } =>
          edge.kind === 'service' && edge.service === service && (!method || edge.method === method);

        // Declared edges mirror the graph's own usedBy derivation (RFC 0007 R5): the route's data
        // edge AND its deferred entries. Per route, at most one row per method — data edge first.
        const declared = ctx.graph.routes.flatMap((r) => {
          const rows = new Map<string, 'serviceData' | 'deferred'>();
          if (matches(r.data)) rows.set(r.data.method, 'serviceData');
          for (const entry of r.deferred ?? []) {
            if (matches(entry.data) && !rows.has(entry.data.method)) rows.set(entry.data.method, 'deferred');
          }

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
                  // method carries the same boot-wide total.
                  methodCallCount: e.count,
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

          const svc = ctx.graph.services.find((s) => s.name === service);
          if (!svc) {
            return {
              ok: false,
              reason: 'unknown_service',
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
            return { ok: true, ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}), edges: [], note: emptyNote };
          }

          // Registry absent: existence cannot be checked — say so rather than guess either way.
          const seen = [
            ...new Set(
              ctx.graph.routes.flatMap((r) => [r.data, ...(r.deferred ?? []).map((e) => e.data)]).flatMap((d) => (d.kind === 'service' ? [d.service] : [])),
            ),
          ];
          return {
            ok: true,
            ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
            edges: [],
            note: `${emptyNote} The registry is not present in this graph, so whether "${service}" exists cannot be checked.`,
            servicesSeenOnRouteEdges: bounded(seen, DEFAULT_LIST_LIMIT),
          };
        }

        return {
          ok: true,
          ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
          note: 'declared = from config (a serviceData edge or a deferred entry); observed = seen in dev traffic, never complete truth. methodCallCount is the method-wide total for the boot, not per-route.',
          edges: [...declared, ...observed],
        };
      }),
  },
  {
    name: 'taujs_explain_route',
    title: 'Explain a route',
    description: `Composed explanation of one route: effective render/hydrate, data edge with schema flags, middleware posture, the schema-v1 declaration score (not Fastify runtime precedence), and its warnings. ${UNTRUSTED_NOTE}`,
    inputSchema: {
      routeId: z.string().optional().describe('Stable id, e.g. "storefront:/product/:id"'),
      path: z.string().optional().describe('Exact declared path'),
    },
    handler: (args) =>
      withGraph(root, (ctx) => {
        const matches = findRoutes(ctx, args as { routeId?: string; path?: string });
        if (matches.length === 0) return routeMiss(ctx);

        return {
          ok: true,
          ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
          explanations: matches.map((route) => {
            const dataEdge =
              route.data.kind === 'service'
                ? {
                    kind: 'service' as const,
                    service: route.data.service,
                    method: route.data.method,
                    source: 'declared' as const,
                    schema:
                      ctx.graph.services
                        ?.find((s) => s.name === (route.data as { service: string }).service)
                        ?.methods.find((m) => m.name === (route.data as { method: string }).method) ?? 'registry not present in this graph',
                  }
                : route.data;

            return {
              id: route.id,
              path: route.path,
              appId: route.appId,
              render: { ...route.render, note: route.render.defaulted ? 'render was not declared; runtime default ssr applies' : undefined },
              hydrate: route.hydrate,
              specificity: route.specificity,
              middleware: route.middleware,
              data: dataEdge,
              warnings: ctx.graph.warnings.filter((w) => w.routeId === route.id),
            };
          }),
        };
      }),
  },
];
