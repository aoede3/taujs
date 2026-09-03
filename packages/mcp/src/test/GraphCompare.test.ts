// @vitest-environment node
import { describe, it, expect } from 'vitest';

// Fixtures are REAL graphs from the REAL emitter (files are the contract this whole adapter
// reads) - createRequestGraph is pure/deterministic, so calling it once gives `current`, and
// every baseline is a JSON round-trip of that SAME graph with exactly one declared field mutated
// per test row (mirrors StructuralTools.test.ts's fixture style).
import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';
import { createServiceData } from '../../../server/src/core/services/ServiceData';
import { defineService, defineServiceRegistry } from '../../../server/src/core/services/DataServices';

import { compareGraphs, summarizeCompare } from '../GraphCompare';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { RequestGraphV1 } from '../types';

const catalog = defineService({
  getProduct: { handler: async (p: { id: string }) => ({ product: { id: p.id } }), params: { parse: (u: unknown) => u as { id: string } } },
  getReviews: async (_p: {}) => ({ reviews: [] }),
});
const content = defineService({ home: async (_p: {}) => ({ heading: 'hi' }), about: async (_p: {}) => ({ page: 'about' }) });
const registry = defineServiceRegistry({ catalog, content });
const serviceData = createServiceData<typeof registry>();

const config: CoreTaujsConfig = {
  apps: [
    {
      appId: 'web',
      entryPoint: 'apps/web',
      routes: [
        { path: '/render-route', attr: { render: 'ssr', data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })) } },
        { path: '/render-defaulted-route' }, // no attr => render.defaulted true
        { path: '/hydrate-route', attr: { render: 'ssr', hydrate: true } },
        { path: '/auth-route', attr: { render: 'ssr', middleware: { auth: {} } } },
        { path: '/csp-route', attr: { render: 'ssr', middleware: { csp: { directives: {} } } } },
        { path: '/data-none-route', attr: { render: 'ssr' } },
        { path: '/data-service-route', attr: { render: 'ssr', data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })) } },
        { path: '/head-present-route', attr: { render: 'ssr', head: { data: serviceData('content', 'home') } } },
        { path: '/head-absent-route', attr: { render: 'ssr' } },
        {
          path: '/deferred-route',
          attr: {
            render: 'streaming',
            meta: {},
            deferred: { a: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })), b: serviceData('catalog', 'getReviews') },
          },
        },
      ],
    },
    { appId: 'admin', entryPoint: 'apps/admin', routes: [{ path: '/dash', attr: { render: 'ssr' } }] },
  ],
};

const OPTS = { source: 'boot' as const, emittedAt: '2026-09-01T10:00:00.000Z', serviceRegistry: registry };

// The one graph every test compares against. JSON round-tripped once here so every `clone()`
// below starts from exactly the shape the adapter itself would read off disk.
const current: RequestGraphV1 = JSON.parse(JSON.stringify(createRequestGraph(config, OPTS)));

// Deep clone, typed as the mutable JSON shape a test needs to poke at.
const clone = (): any => JSON.parse(JSON.stringify(current));

const routeIn = (graph: any, path: string) => graph.routes.find((r: any) => r.appId === 'web' && r.path === path);
const appIn = (graph: any, appId: string) => graph.apps.find((a: any) => a.appId === appId);

describe('compareGraphs — metadata and ignored fields never produce rows', () => {
  it('emittedAt, source, taujs.server differences => zero rows, identical', () => {
    const baseline = clone();
    baseline.emittedAt = '2020-01-01T00:00:00.000Z';
    baseline.source = 'build';
    baseline.taujs.server = '0.0.1-different';

    const rows = compareGraphs(baseline, current);
    expect(rows).toEqual([]);
    expect(summarizeCompare(rows)).toEqual({ added: 0, removed: 0, changed: 0, total: 0 });
  });

  it('services: null vs populated => zero rows', () => {
    const baseline = clone();
    baseline.services = null;

    expect(compareGraphs(baseline, current)).toEqual([]);
  });

  it('services: populated vs a DIFFERENT populated registry => zero rows', () => {
    const baseline = clone();
    baseline.services = [{ name: 'unrelated', methods: [{ name: 'ghost', params: { declared: false }, result: { declared: false }, usedBy: [] }] }];

    expect(compareGraphs(baseline, current)).toEqual([]);
  });

  it('apps[].routeCount differences => zero rows', () => {
    const baseline = clone();
    appIn(baseline, 'web').routeCount = 999;

    expect(compareGraphs(baseline, current)).toEqual([]);
  });

  it('routes[].specificity differences => zero rows', () => {
    const baseline = clone();
    routeIn(baseline, '/render-route').specificity = -1;

    expect(compareGraphs(baseline, current)).toEqual([]);
  });
});

describe('compareGraphs — app rows', () => {
  it('app added: present in current, absent from baseline', () => {
    const baseline = clone();
    baseline.apps = baseline.apps.filter((a: any) => a.appId !== 'admin');

    expect(compareGraphs(baseline, current)).toEqual([{ kind: 'app', change: 'added', id: 'admin', field: 'entryPoint', current: 'apps/admin' }]);
  });

  it('app removed: present in baseline, absent from current', () => {
    const baseline = clone();
    baseline.apps.push({ appId: 'legacy', entryPoint: 'apps/legacy', routeCount: 0 });

    expect(compareGraphs(baseline, current)).toEqual([{ kind: 'app', change: 'removed', id: 'legacy', field: 'entryPoint', baseline: 'apps/legacy' }]);
  });

  it('app entryPoint changed: present in both, different entryPoint', () => {
    const baseline = clone();
    appIn(baseline, 'admin').entryPoint = 'apps/admin-OLD';

    expect(compareGraphs(baseline, current)).toEqual([
      { kind: 'app', change: 'changed', id: 'admin', field: 'entryPoint', baseline: 'apps/admin-OLD', current: 'apps/admin' },
    ]);
  });
});

describe('compareGraphs — route add/remove rows', () => {
  it('route added: present in current, absent from baseline', () => {
    const baseline = clone();
    baseline.routes = baseline.routes.filter((r: any) => r.id !== 'web:/render-route');

    expect(compareGraphs(baseline, current)).toEqual([{ kind: 'route', change: 'added', id: 'web:/render-route' }]);
  });

  it('route removed: present in baseline, absent from current', () => {
    const baseline = clone();
    baseline.routes.push({
      id: 'web:/gone',
      appId: 'web',
      path: '/gone',
      render: { strategy: 'ssr', defaulted: false },
      hydrate: { enabled: true, defaulted: true },
      specificity: 0,
      middleware: { auth: { declared: false }, csp: { declared: false } },
      data: { kind: 'none' },
    });

    expect(compareGraphs(baseline, current)).toEqual([{ kind: 'route', change: 'removed', id: 'web:/gone' }]);
  });
});

describe('compareGraphs — route facet rows (every included facet)', () => {
  it('render strategy changed', () => {
    const baseline = clone();
    routeIn(baseline, '/render-route').render = { strategy: 'streaming', defaulted: false };

    expect(compareGraphs(baseline, current)).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/render-route',
        field: 'render',
        baseline: { strategy: 'streaming', defaulted: false },
        current: { strategy: 'ssr', defaulted: false },
      },
    ]);
  });

  it('render defaulted changed', () => {
    const baseline = clone();
    routeIn(baseline, '/render-defaulted-route').render = { strategy: 'ssr', defaulted: false };

    expect(compareGraphs(baseline, current)).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/render-defaulted-route',
        field: 'render',
        baseline: { strategy: 'ssr', defaulted: false },
        current: { strategy: 'ssr', defaulted: true },
      },
    ]);
  });

  it('hydrate changed', () => {
    const baseline = clone();
    routeIn(baseline, '/hydrate-route').hydrate = { enabled: false, defaulted: false };

    const rows = compareGraphs(baseline, current);
    expect(rows).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/hydrate-route',
        field: 'hydrate',
        baseline: { enabled: false, defaulted: false },
        current: { enabled: true, defaulted: false },
      },
    ]);
  });

  it('middleware.auth changed', () => {
    const baseline = clone();
    routeIn(baseline, '/auth-route').middleware.auth = { declared: false };

    expect(compareGraphs(baseline, current)).toEqual([
      { kind: 'route', change: 'changed', id: 'web:/auth-route', field: 'middleware.auth', baseline: { declared: false }, current: { declared: true } },
    ]);
  });

  it('middleware.csp changed', () => {
    const baseline = clone();
    const before = routeIn(baseline, '/csp-route').middleware.csp;
    routeIn(baseline, '/csp-route').middleware.csp = { declared: false };

    expect(compareGraphs(baseline, current)).toEqual([
      { kind: 'route', change: 'changed', id: 'web:/csp-route', field: 'middleware.csp', baseline: { declared: false }, current: before },
    ]);
  });

  it('data changed: none -> service', () => {
    const baseline = clone();
    routeIn(baseline, '/data-none-route').data = { kind: 'service', service: 'catalog', method: 'getProduct' };

    expect(compareGraphs(baseline, current)).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/data-none-route',
        field: 'data',
        baseline: { kind: 'service', service: 'catalog', method: 'getProduct' },
        current: { kind: 'none' },
      },
    ]);
  });

  it('data changed: service method changed', () => {
    const baseline = clone();
    routeIn(baseline, '/data-service-route').data = { kind: 'service', service: 'catalog', method: 'getReviews' };

    expect(compareGraphs(baseline, current)).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/data-service-route',
        field: 'data',
        baseline: { kind: 'service', service: 'catalog', method: 'getReviews' },
        current: { kind: 'service', service: 'catalog', method: 'getProduct' },
      },
    ]);
  });

  it('head added: absent in baseline, present in current => absent side is null', () => {
    const baseline = clone();
    delete routeIn(baseline, '/head-present-route').head;

    expect(compareGraphs(baseline, current)).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/head-present-route',
        field: 'head',
        baseline: null,
        current: { data: { kind: 'service', service: 'content', method: 'home' } },
      },
    ]);
  });

  it('head removed: present in baseline, absent in current => absent side is null', () => {
    const baseline = clone();
    routeIn(baseline, '/head-absent-route').head = { data: { kind: 'service', service: 'content', method: 'home' } };

    expect(compareGraphs(baseline, current)).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/head-absent-route',
        field: 'head',
        baseline: { data: { kind: 'service', service: 'content', method: 'home' } },
        current: null,
      },
    ]);
  });

  it('head changed: present on both sides, different declared value', () => {
    const baseline = clone();
    routeIn(baseline, '/head-present-route').head = { data: { kind: 'service', service: 'content', method: 'about' } };

    expect(compareGraphs(baseline, current)).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/head-present-route',
        field: 'head',
        baseline: { data: { kind: 'service', service: 'content', method: 'about' } },
        current: { data: { kind: 'service', service: 'content', method: 'home' } },
      },
    ]);
  });

  it('deferred entry added: current has an extra key baseline lacks', () => {
    const baseline = clone();
    routeIn(baseline, '/deferred-route').deferred = routeIn(baseline, '/deferred-route').deferred.filter((e: any) => e.key !== 'b');

    const rows = compareGraphs(baseline, current);
    expect(rows).toEqual([
      {
        kind: 'route',
        change: 'changed',
        id: 'web:/deferred-route',
        field: 'deferred',
        baseline: [{ key: 'a', data: { kind: 'service', service: 'catalog', method: 'getProduct' } }],
        current: [
          { key: 'a', data: { kind: 'service', service: 'catalog', method: 'getProduct' } },
          { key: 'b', data: { kind: 'service', service: 'catalog', method: 'getReviews' } },
        ],
      },
    ]);
  });

  it('deferred entry removed: baseline has an extra key current lacks', () => {
    const baseline = clone();
    routeIn(baseline, '/deferred-route').deferred.push({ key: 'c', data: { kind: 'dynamic' } });

    const rows = compareGraphs(baseline, current);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'route', change: 'changed', id: 'web:/deferred-route', field: 'deferred' });
    expect((rows[0]!.baseline as any[]).map((e) => e.key)).toEqual(['a', 'b', 'c']);
    expect((rows[0]!.current as any[]).map((e) => e.key)).toEqual(['a', 'b']);
  });

  it('deferred entry changed: same key, different declared value', () => {
    const baseline = clone();
    const entry = routeIn(baseline, '/deferred-route').deferred.find((e: any) => e.key === 'a');
    entry.data = { kind: 'service', service: 'catalog', method: 'getReviews' };

    const rows = compareGraphs(baseline, current);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'route', change: 'changed', id: 'web:/deferred-route', field: 'deferred' });
  });

  it('deferred reordered by key => NO row (order-insensitive comparison)', () => {
    const baseline = clone();
    routeIn(baseline, '/deferred-route').deferred.reverse(); // same two entries, same content, reversed array order only

    expect(compareGraphs(baseline, current)).toEqual([]);
  });
});

describe('compareGraphs — global security and fallthrough', () => {
  it('security changed produces one whole-object row, id "security"', () => {
    const baseline = clone();
    baseline.security = { cspDefaultMode: 'replace', reporting: true };

    expect(compareGraphs(baseline, current)).toEqual([
      { kind: 'security', change: 'changed', id: 'security', baseline: { cspDefaultMode: 'replace', reporting: true }, current: current.security },
    ]);
  });

  it('fallthrough changed produces one whole-object row, id "fallthrough"', () => {
    const baseline = clone();
    baseline.fallthrough = { ...current.fallthrough, reachable: !current.fallthrough.reachable };

    expect(compareGraphs(baseline, current)).toEqual([
      { kind: 'fallthrough', change: 'changed', id: 'fallthrough', baseline: baseline.fallthrough, current: current.fallthrough },
    ]);
  });
});

describe('compareGraphs — determinism', () => {
  it('a baseline with apps and routes permuted (no content change) yields IDENTICAL output to the unshuffled baseline', () => {
    const unshuffled = compareGraphs(clone(), current);
    expect(unshuffled).toEqual([]); // sanity: the unmutated clone really is identical

    const shuffled = clone();
    shuffled.apps.reverse();
    shuffled.routes.reverse();
    expect(compareGraphs(shuffled, current)).toEqual([]);
  });

  it('permutation does not affect a REAL difference: the one genuine row still appears, keyed not positional', () => {
    const withChange = clone();
    routeIn(withChange, '/render-route').render = { strategy: 'streaming', defaulted: false };
    const straightRows = compareGraphs(withChange, current);

    const shuffledWithChange = clone();
    routeIn(shuffledWithChange, '/render-route').render = { strategy: 'streaming', defaulted: false };
    shuffledWithChange.apps.reverse();
    shuffledWithChange.routes.reverse();
    const shuffledRows = compareGraphs(shuffledWithChange, current);

    expect(shuffledRows).toEqual(straightRows);
    expect(shuffledRows).toHaveLength(1);
  });

  // A single-row or zero-row result can never distinguish a keyed+sorted comparison from a
  // positional one - order is trivially "correct" either way. TWO genuine app-level differences,
  // with baseline.apps reversed only in the shuffled variant, makes the raw (pre-sort) push order
  // for the shuffled case the MIRROR of the straight case - so this is the cell that actually dies
  // if sortRows is ever removed (proven below, "discrimination check").
  it('permutation does not affect MULTIPLE genuine rows: still identical output, still correctly ordered', () => {
    const withChanges = clone();
    appIn(withChanges, 'web').entryPoint = 'apps/web-OLD';
    appIn(withChanges, 'admin').entryPoint = 'apps/admin-OLD';
    const straightRows = compareGraphs(withChanges, current);

    const shuffledWithChanges = clone();
    appIn(shuffledWithChanges, 'web').entryPoint = 'apps/web-OLD';
    appIn(shuffledWithChanges, 'admin').entryPoint = 'apps/admin-OLD';
    shuffledWithChanges.apps.reverse();
    shuffledWithChanges.routes.reverse();
    const shuffledRows = compareGraphs(shuffledWithChanges, current);

    expect(shuffledRows).toEqual(straightRows);
    expect(shuffledRows).toHaveLength(2);
    expect(shuffledRows.map((r) => r.id)).toEqual(['admin', 'web']); // localeCompare order, not array order
  });

  it('output row order is stable: kind (app, route, security, fallthrough), then id, then field', () => {
    const baseline = clone();
    // Scatter several differences across every kind, in a deliberately non-sorted mutation order.
    baseline.fallthrough = { ...current.fallthrough, reachable: !current.fallthrough.reachable };
    baseline.security = { cspDefaultMode: 'replace', reporting: true };
    routeIn(baseline, '/hydrate-route').hydrate = { enabled: false, defaulted: false };
    routeIn(baseline, '/auth-route').middleware.auth = { declared: false };
    appIn(baseline, 'admin').entryPoint = 'apps/admin-OLD';

    const rows = compareGraphs(baseline, current);
    expect(rows.map((r) => `${r.kind}:${r.id}:${r.field ?? ''}`)).toEqual([
      'app:admin:entryPoint',
      'route:web:/auth-route:middleware.auth',
      'route:web:/hydrate-route:hydrate',
      'security:security:',
      'fallthrough:fallthrough:',
    ]);
  });
});
