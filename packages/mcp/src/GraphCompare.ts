// Pure comparison of two request graphs against a fixed, declared boundary. No I/O, no clock,
// no verdicts - this module answers exactly one question: which DECLARED fields differ between a
// retained baseline and the currently emitted graph, and where. Everything else the graph carries
// (emittedAt, source, taujs.server, apps[].routeCount, routes[].specificity, services, warnings) is
// intentionally out of scope - the tool that calls this states why (comparing services would be
// dishonest across build-vs-boot graphs; declared critical/head/deferred service edges remain
// covered through the route facets compared here).

export type RowKind = 'app' | 'route' | 'security' | 'fallthrough';
export type RowChange = 'added' | 'removed' | 'changed';

// The comparator's HONEST input contract: exactly the fields it compares or the tool emits, and
// no more. A full RequestGraphV1 satisfies it structurally, but the baseline reader's guard only
// ever proves this much - naming that boundary keeps the narrowing truthful instead of claiming a
// v1 document it never validated. Facet interiors are `unknown` on purpose: they flow through
// deep structural equality and into rows as-is, so their shape is a difference to report, never a
// contract to enforce.
export type ComparableRoute = {
  id: string;
  render: unknown;
  hydrate: unknown;
  middleware: { auth: unknown; csp: unknown };
  data: unknown;
  head?: unknown;
  deferred?: { key: string; data?: unknown }[];
};

export type ComparableGraph = {
  schemaVersion: number;
  source: string;
  emittedAt: string;
  taujs: { server: string };
  apps: { appId: string; entryPoint: string }[];
  routes: ComparableRoute[];
  security: unknown;
  fallthrough: unknown;
};

// Design pinned (contract) - do not extend. `field` names the differing facet for a route or app
// row; `baseline`/`current` carry the exact declared value (never a summary), `null` when the
// facet is absent on that side. Omitted, not `undefined`, when the side does not apply (`baseline`
// on 'added', `current` on 'removed').
export type Row = {
  kind: RowKind;
  change: RowChange;
  id: string;
  field?: string;
  baseline?: unknown;
  current?: unknown;
};

export type CompareSummary = { added: number; removed: number; changed: number; total: number };

// Structural equality over JSON-shaped values only (every input here already round-tripped
// through the graph's own JSON emission) - no Date/undefined/function cases to handle.
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
};

// Order fixed by the contract - not the iteration order routes happen to declare facets in.
const ROUTE_FACETS = ['render', 'hydrate', 'middleware.auth', 'middleware.csp', 'data', 'head', 'deferred'] as const;
type RouteFacet = (typeof ROUTE_FACETS)[number];

type DeferredEntry = NonNullable<ComparableRoute['deferred']>[number];

// Deferred entries are declared as an array but are logically a set keyed by `key` (RFC 0007 R5):
// comparing them order-insensitively means sorting both sides before the row-level deepEqual ever
// sees them, so a baseline that merely reordered its deferred entries produces no row.
const sortedDeferred = (entries: DeferredEntry[] | undefined): DeferredEntry[] | null =>
  entries ? [...entries].sort((a, b) => a.key.localeCompare(b.key)) : null;

const facetValue = (route: ComparableRoute, facet: RouteFacet): unknown => {
  switch (facet) {
    case 'render':
      return route.render;
    case 'hydrate':
      return route.hydrate;
    case 'middleware.auth':
      return route.middleware.auth;
    case 'middleware.csp':
      return route.middleware.csp;
    case 'data':
      return route.data;
    case 'head':
      // Absence vs presence is itself the change; the absent side reads as `null` in the row.
      return route.head ?? null;
    case 'deferred':
      return sortedDeferred(route.deferred);
  }
};

const compareApps = (baseline: ComparableGraph, current: ComparableGraph): Row[] => {
  const rows: Row[] = [];
  const baseApps = new Map(baseline.apps.map((a) => [a.appId, a]));
  const curApps = new Map(current.apps.map((a) => [a.appId, a]));
  const appIds = new Set<string>([...baseApps.keys(), ...curApps.keys()]);

  for (const appId of appIds) {
    const b = baseApps.get(appId);
    const c = curApps.get(appId);

    if (!b && c) rows.push({ kind: 'app', change: 'added', id: appId, field: 'entryPoint', current: c.entryPoint });
    else if (b && !c) rows.push({ kind: 'app', change: 'removed', id: appId, field: 'entryPoint', baseline: b.entryPoint });
    else if (b && c && b.entryPoint !== c.entryPoint)
      rows.push({ kind: 'app', change: 'changed', id: appId, field: 'entryPoint', baseline: b.entryPoint, current: c.entryPoint });
  }

  return rows;
};

const compareRoutes = (baseline: ComparableGraph, current: ComparableGraph): Row[] => {
  const rows: Row[] = [];
  const baseRoutes = new Map(baseline.routes.map((r) => [r.id, r]));
  const curRoutes = new Map(current.routes.map((r) => [r.id, r]));
  const routeIds = new Set<string>([...baseRoutes.keys(), ...curRoutes.keys()]);

  for (const id of routeIds) {
    const b = baseRoutes.get(id);
    const c = curRoutes.get(id);

    if (!b && c) {
      rows.push({ kind: 'route', change: 'added', id });
      continue;
    }
    if (b && !c) {
      rows.push({ kind: 'route', change: 'removed', id });
      continue;
    }
    if (!b || !c) continue; // Unreachable: routeIds is exactly the union of the two key sets.

    for (const facet of ROUTE_FACETS) {
      const bv = facetValue(b, facet);
      const cv = facetValue(c, facet);
      if (!deepEqual(bv, cv)) rows.push({ kind: 'route', change: 'changed', id, field: facet, baseline: bv, current: cv });
    }
  }

  return rows;
};

const KIND_ORDER: Record<RowKind, number> = { app: 0, route: 1, security: 2, fallthrough: 3 };

// Determinism (contract): comparison is keyed (Maps), never positional - a shuffled baseline's
// apps/routes yield the same rows in the same order once sorted here.
const sortRows = (rows: Row[]): Row[] =>
  [...rows].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id) || (a.field ?? '').localeCompare(b.field ?? ''));

export const compareGraphs = (baseline: ComparableGraph, current: ComparableGraph): Row[] => {
  const rows: Row[] = [...compareApps(baseline, current), ...compareRoutes(baseline, current)];

  if (!deepEqual(baseline.security, current.security))
    rows.push({ kind: 'security', change: 'changed', id: 'security', baseline: baseline.security, current: current.security });

  if (!deepEqual(baseline.fallthrough, current.fallthrough))
    rows.push({ kind: 'fallthrough', change: 'changed', id: 'fallthrough', baseline: baseline.fallthrough, current: current.fallthrough });

  return sortRows(rows);
};

// Counts describe ALL rows, never the truncated slice a caller bounds for display - so they
// survive truncation and stay reconcilable against `changes.total`.
export const summarizeCompare = (rows: Row[]): CompareSummary => ({
  added: rows.filter((r) => r.change === 'added').length,
  removed: rows.filter((r) => r.change === 'removed').length,
  changed: rows.filter((r) => r.change === 'changed').length,
  total: rows.length,
});
