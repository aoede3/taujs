import { z } from 'zod';

import { readObservations } from '../SubstrateReader';
import { UNTRUSTED_NOTE, bounded, withGraph } from '../toolkit';

import type { GraphContext, ToolDefinition, ToolResult } from '../toolkit';
import type { GraphRoute } from '../types';

const DEFAULT_LIST_LIMIT = 20;

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
    description: `One-screen summary of the request graph: apps, route/service counts, warnings, fallthrough posture, freshness. Start here. ${UNTRUSTED_NOTE}`,
    inputSchema: {},
    handler: () =>
      withGraph(root, ({ discovery, graph, stalenessLine }) => ({
        ok: true,
        mode: discovery.mode,
        ...(stalenessLine ? { staleness: stalenessLine } : {}),
        taujsServer: graph.taujs.server,
        source: graph.source,
        emittedAt: graph.emittedAt,
        apps: graph.apps,
        routeCount: graph.routes.length,
        services:
          graph.services === null
            ? 'unavailable (registry not present in this graph — declared edges still on routes)'
            : graph.services.map((s) => ({ name: s.name, methods: s.methods.map((m) => m.name) })),
        warningCounts: graph.warnings.reduce<Record<string, number>>((acc, w) => ({ ...acc, [w.severity]: (acc[w.severity] ?? 0) + 1 }), {}),
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
    description: `Route → service edges for a service (optionally one method). Each edge is labelled declared (from config via serviceData) or observed (seen in dev traffic — absence means "not exercised yet", never "no relationship"). ${UNTRUSTED_NOTE}`,
    inputSchema: {
      service: z.string().describe('Service name, e.g. "catalog"'),
      method: z.string().optional().describe('Method name, e.g. "getProduct"'),
    },
    handler: (args) =>
      withGraph(root, (ctx) => {
        const service = String(args.service ?? '');
        const method = typeof args.method === 'string' ? args.method : undefined;

        const declared = ctx.graph.routes
          .filter((r) => r.data.kind === 'service' && r.data.service === service && (!method || r.data.method === method))
          .map((r) => ({
            source: 'declared' as const,
            service,
            method: (r.data as { method: string }).method,
            routeId: r.id,
            appId: r.appId,
            path: r.path,
          }));

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
                  count: e.count,
                  lastObservedAt: e.lastObservedAt,
                })),
              )
          : [];

        if (declared.length === 0 && observed.length === 0) {
          const known = ctx.graph.services?.map((s) => s.name) ?? [
            ...new Set(ctx.graph.routes.flatMap((r) => (r.data.kind === 'service' ? [r.data.service] : []))),
          ];
          return {
            ok: false,
            reason: 'no_edges',
            message: `No declared or observed edges for "${service}${method ? `.${method}` : ''}". Observed edges only exist for traffic seen this boot.`,
            knownServices: bounded(known, DEFAULT_LIST_LIMIT),
          };
        }

        return {
          ok: true,
          ...(ctx.stalenessLine ? { staleness: ctx.stalenessLine } : {}),
          note: 'declared = from config (serviceData); observed = seen in dev traffic, never complete truth.',
          edges: [...declared, ...observed],
        };
      }),
  },
  {
    name: 'taujs_explain_route',
    title: 'Explain a route',
    description: `Composed explanation of one route: effective render/hydrate, data edge with schema flags, middleware posture, specificity, and its warnings. ${UNTRUSTED_NOTE}`,
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
