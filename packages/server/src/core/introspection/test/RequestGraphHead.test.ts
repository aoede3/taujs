// @vitest-environment node
// head edge, mirrors data (decisions.md 2026-08-27): the additive-optional `GraphRoute.head`
// field and its `usedBy` contribution.
import { describe, it, expect } from 'vitest';

import { createRequestGraph } from '../RequestGraph';
import { createServiceData } from '../../services/ServiceData';
import { defineService, defineServiceRegistry } from '../../services/DataServices';

import type { CoreTaujsConfig } from '../../config/types';

const registry = defineServiceRegistry({
  catalog: defineService({ getProduct: async () => ({ id: 1 }) }),
});

const serviceData = createServiceData<typeof registry>();

const emitted = { source: 'boot' as const, emittedAt: '2026-08-27T00:00:00.000Z' };

const configWith = (attr: Record<string, unknown>): CoreTaujsConfig => ({
  apps: [{ appId: 'shop', entryPoint: '', routes: [{ path: '/product/:id', attr: attr as never }] }],
});

describe('createRequestGraph head edge (decisions.md 2026-08-27)', () => {
  it('emits nothing for a route declaring no attr.head (byte-identical emission)', () => {
    const graph = createRequestGraph(configWith({ render: 'ssr' }), emitted);

    expect('head' in graph.routes[0]!).toBe(false);
    expect(JSON.stringify(graph.routes[0])).not.toContain('head');
  });

  it('derives a service head edge exactly like the data edge', () => {
    const graph = createRequestGraph(configWith({ render: 'ssr', head: { data: serviceData('catalog', 'getProduct', () => ({})) } }), emitted);

    expect(graph.routes[0]!.head).toEqual({ data: { kind: 'service', service: 'catalog', method: 'getProduct' } });
  });

  it('derives a dynamic head edge for a plain function with no metadata', () => {
    const graph = createRequestGraph(configWith({ render: 'ssr', head: { data: async () => ({ title: 'hi' }) } }), emitted);

    expect(graph.routes[0]!.head).toEqual({ data: { kind: 'dynamic' } });
  });

  it('contributes to GraphServiceMethod.usedBy exactly as a data edge does', () => {
    const graph = createRequestGraph(configWith({ render: 'ssr', head: { data: serviceData('catalog', 'getProduct', () => ({})) } }), {
      ...emitted,
      serviceRegistry: registry,
    });

    const method = graph.services!.find((s) => s.name === 'catalog')!.methods.find((m) => m.name === 'getProduct')!;
    expect(method.usedBy).toEqual([{ routeId: 'shop:/product/:id', appId: 'shop', path: '/product/:id' }]);
  });

  it('a method declared through both data and head on one route appears once in usedBy', () => {
    const graph = createRequestGraph(
      configWith({
        render: 'ssr',
        data: serviceData('catalog', 'getProduct', () => ({})),
        head: { data: serviceData('catalog', 'getProduct', () => ({})) },
      }),
      { ...emitted, serviceRegistry: registry },
    );

    const method = graph.services!.find((s) => s.name === 'catalog')!.methods.find((m) => m.name === 'getProduct')!;
    expect(method.usedBy).toEqual([{ routeId: 'shop:/product/:id', appId: 'shop', path: '/product/:id' }]);
  });

  it('a route with no attr.head has no head key alongside one that declares it', () => {
    const graph = createRequestGraph(
      {
        apps: [
          {
            appId: 'shop',
            entryPoint: '',
            routes: [
              { path: '/product/:id', attr: { render: 'ssr', head: { data: serviceData('catalog', 'getProduct', () => ({})) } } as never },
              { path: '/plain', attr: { render: 'ssr' } as never },
            ],
          },
        ],
      },
      emitted,
    );

    const byId = new Map(graph.routes.map((r) => [r.id, r]));
    expect('head' in byId.get('shop:/product/:id')!).toBe(true);
    expect('head' in byId.get('shop:/plain')!).toBe(false);
  });
});
