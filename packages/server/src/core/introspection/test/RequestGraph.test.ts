// @vitest-environment node
import { describe, it, expect } from 'vitest';

import pkg from '../../../../package.json';
import { defineService, defineServiceRegistry } from '../../services/DataServices';
import { createServiceData } from '../../services/ServiceData';
import { createRequestGraph } from '../RequestGraph';

import type { CoreTaujsConfig } from '../../config/types';

// Fixed emission options: createRequestGraph owns no clock, so snapshots pin exact bytes.
const OPTS = { source: 'boot', emittedAt: '2026-07-09T10:12:03.412Z' } as const;

// taujs.server is release-variant by design (the emitting package's version) — snapshots
// must not break on version bumps, so it is normalised. Found by the first Version
// Packages PR: the 0.7.1 → 0.8.0 bump failed all seven graph snapshots.
const versionAgnostic = (graph: ReturnType<typeof createRequestGraph>) => ({ ...graph, taujs: { server: '<version>' } });

// --- fixture (b) registry: one parse-style schema, one bare-function validator ---

const catalogService = defineService({
  getProduct: {
    handler: async (p: { id: string }) => ({ product: { id: p.id } }),
    params: { parse: (u: unknown) => u as { id: string } },
  },
  listSpecials: async (_p: {}) => ({ items: ['sku_1'] }),
});

const contentService = defineService({
  page: {
    handler: async (p: { slug: string }) => ({ body: p.slug }),
    params: (u: unknown) => u as { slug: string },
    result: { parse: (u: unknown) => u as { body: string } },
  },
});

const registry = defineServiceRegistry({ catalog: catalogService, content: contentService });
const serviceData = createServiceData<typeof registry>();

// --- fixtures ---

// (a) minimal single app: one attr-less route — exercises every runtime default.
const fixtureMinimal: CoreTaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', routes: [{ path: '/' }] }],
};

// (b) multi-app: serviceData + dynamic + none data kinds; auth; per-route CSP variants
// including function-valued directives; explicit global CSP with reporting.
const fixtureMultiApp: CoreTaujsConfig = {
  apps: [
    {
      appId: 'storefront',
      entryPoint: 'storefront',
      routes: [
        {
          path: '/product/:id',
          attr: {
            render: 'streaming',
            meta: { title: 'Product' },
            data: serviceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })),
            middleware: { csp: { mode: 'replace', reportOnly: true, directives: {} } },
          },
        },
        {
          path: '/search',
          attr: {
            render: 'ssr',
            data: async () => ({ results: [] }),
            middleware: { csp: { directives: () => ({}) } },
          },
        },
        { path: '/terms', attr: { render: 'ssr', hydrate: false } },
      ],
    },
    {
      appId: 'admin',
      entryPoint: 'admin',
      routes: [
        { path: '/admin', attr: { render: 'ssr', middleware: { auth: { roles: ['admin'] }, csp: false } } },
        { path: '/admin/settings', attr: { render: 'ssr', middleware: { auth: {}, csp: { disabled: true } } } },
      ],
    },
  ],
  security: { csp: { defaultMode: 'merge', reporting: { endpoint: '/csp-report' } } },
};

// (c) app-shell wildcard: fallthrough unreachable.
const fixtureAppShell: CoreTaujsConfig = {
  apps: [
    {
      appId: 'shell',
      entryPoint: 'shell',
      routes: [
        { path: '/', attr: { render: 'ssr' } },
        { path: '/*', attr: { render: 'ssr' } },
      ],
    },
  ],
  security: { csp: { defaultMode: 'replace' } },
};

// (d) triggers every warning code in the registry at least once.
const fixtureAllWarnings: CoreTaujsConfig = {
  apps: [
    {
      appId: 'alpha',
      entryPoint: 'alpha',
      routes: [
        { path: '/dup', attr: { render: 'ssr' } },
        // streaming without meta is untypeable by design (RouteAttributes requires meta) —
        // runtime JS configs can still produce it, which is exactly what the warning is for.
        { path: '/live', attr: { render: 'streaming' } as any },
        { path: '/defaulted' },
        { path: '*' },
      ],
    },
    { appId: 'beta', entryPoint: 'beta', routes: [{ path: '/dup', attr: { render: 'ssr' } }] },
  ],
};

// (e) mirrors fixtures/playground/taujs.config.ts (P0B-05) — keep the two in sync; the
// playground README points back here. Registry mirrors content/catalog kinds.
const playgroundCatalog = defineService({
  getProduct: {
    handler: async (p: { id: string }) => ({ product: { id: p.id, title: `Product ${p.id}`, price: 42 } }),
    params: { parse: (u: unknown) => u as { id: string } },
    result: (u: unknown) => u as { product: { id: string; title: string; price: number } },
  },
});
const playgroundContent = defineService({
  home: async (_p: {}) => ({ heading: 'τjs playground', blurb: '' }),
});
const playgroundRegistry = defineServiceRegistry({ catalog: playgroundCatalog, content: playgroundContent });
const playgroundServiceData = createServiceData<typeof playgroundRegistry>();

const fixturePlayground: CoreTaujsConfig = {
  server: { port: 5173, host: 'localhost', hmrPort: 5174 },
  apps: [
    {
      appId: 'playground',
      entryPoint: '',
      routes: [
        { path: '/', attr: { render: 'ssr', data: playgroundServiceData('content', 'home') } },
        {
          path: '/product/:id',
          attr: {
            render: 'streaming',
            meta: { title: 'τjs playground — product' },
            data: playgroundServiceData('catalog', 'getProduct', (p) => ({ id: String(p.id) })),
          },
        },
        { path: '/legacy', attr: { render: 'ssr', data: async () => ({ legacy: true }) } },
        { path: '/terms', attr: { render: 'ssr', hydrate: false } },
        { path: '/admin', attr: { render: 'ssr', middleware: { auth: { roles: ['admin'] } } } },
      ],
    },
  ],
};

describe('createRequestGraph — fixture snapshots (spec 02 schema v1)', () => {
  it('(a) minimal single app', () => {
    expect(versionAgnostic(createRequestGraph(fixtureMinimal, OPTS))).toMatchSnapshot();
  });

  it('(b) multi-app with registry: kinds, usedBy, csp variants', () => {
    expect(versionAgnostic(createRequestGraph(fixtureMultiApp, { ...OPTS, serviceRegistry: registry }))).toMatchSnapshot();
  });

  it('(b) without a registry: services is null, never []', () => {
    expect(versionAgnostic(createRequestGraph(fixtureMultiApp, { ...OPTS, source: 'build' }))).toMatchSnapshot();
  });

  it('(c) app-shell wildcard: fallthrough unreachable', () => {
    expect(versionAgnostic(createRequestGraph(fixtureAppShell, OPTS))).toMatchSnapshot();
  });

  it('(e) playground fixture: the P0B-05 app shape, registry-enriched', () => {
    const graph = createRequestGraph(fixturePlayground, { ...OPTS, serviceRegistry: playgroundRegistry });

    expect(graph.fallthrough.reachable).toBe(true);
    expect(graph.routes.map((r) => r.data.kind)).toEqual(expect.arrayContaining(['service', 'dynamic', 'none']));
    expect(versionAgnostic(graph)).toMatchSnapshot();
  });

  it('(d) every warning code fires at least once', () => {
    const graph = createRequestGraph(fixtureAllWarnings, OPTS);

    expect(new Set(graph.warnings.map((w) => w.code))).toEqual(
      new Set(['routes.duplicate_path', 'streaming.missing_meta', 'render.defaulted', 'csp.dev_directives', 'fallthrough.unreachable']),
    );
    expect(versionAgnostic(graph)).toMatchSnapshot();
  });
});

describe('createRequestGraph — contract assertions', () => {
  it('is deterministic: byte-identical output across two calls with identical inputs', () => {
    const a = createRequestGraph(fixtureMultiApp, { ...OPTS, serviceRegistry: registry });
    const b = createRequestGraph(fixtureMultiApp, { ...OPTS, serviceRegistry: registry });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('echoes caller-supplied source/emittedAt and stamps the emitting version', () => {
    const graph = createRequestGraph(fixtureMinimal, { source: 'build', emittedAt: '2000-01-01T00:00:00.000Z' });

    expect(graph.source).toBe('build');
    expect(graph.emittedAt).toBe('2000-01-01T00:00:00.000Z');
    expect(graph.taujs.server).toBe(pkg.version);
    expect(graph.schemaVersion).toBe(1);
    expect(graph.disclosure).toBe('conservative');
  });

  it('declared edges: usedBy points at the serviceData route; unused methods have empty usedBy', () => {
    const graph = createRequestGraph(fixtureMultiApp, { ...OPTS, serviceRegistry: registry });

    const catalog = graph.services!.find((s) => s.name === 'catalog')!;
    const getProduct = catalog.methods.find((m) => m.name === 'getProduct')!;
    expect(getProduct.usedBy).toEqual([{ routeId: 'storefront:/product/:id', appId: 'storefront', path: '/product/:id' }]);
    expect(getProduct.params).toEqual({ declared: true, kind: 'parse' });
    expect(getProduct.result).toEqual({ declared: false });

    const page = graph.services!.find((s) => s.name === 'content')!.methods.find((m) => m.name === 'page')!;
    expect(page.usedBy).toEqual([]);
    expect(page.params).toEqual({ declared: true, kind: 'function' });
    expect(page.result).toEqual({ declared: true, kind: 'parse' });
  });

  it('data kinds: service via metadata, dynamic for closures, none when absent', () => {
    const graph = createRequestGraph(fixtureMultiApp, OPTS);
    const byId = new Map(graph.routes.map((r) => [r.id, r]));

    expect(byId.get('storefront:/product/:id')!.data).toEqual({ kind: 'service', service: 'catalog', method: 'getProduct' });
    expect(byId.get('storefront:/search')!.data).toEqual({ kind: 'dynamic' });
    expect(byId.get('storefront:/terms')!.data).toEqual({ kind: 'none' });
  });

  it('rejects an empty apps array (mirrors defineConfig)', () => {
    expect(() => createRequestGraph({ apps: [] }, OPTS)).toThrow('At least one app must be configured');
  });
});
