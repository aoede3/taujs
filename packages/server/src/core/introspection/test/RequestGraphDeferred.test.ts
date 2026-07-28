// @vitest-environment node
// RFC 0007 (R5): the additive-optional `GraphRoute.deferred` field and its `usedBy` contribution.
import { describe, it, expect } from 'vitest';

import { createRequestGraph } from '../RequestGraph';
import { createServiceData } from '../../services/ServiceData';
import { defineService, defineServiceRegistry } from '../../services/DataServices';

import type { CoreTaujsConfig } from '../../config/types';

const registry = defineServiceRegistry({
  reviews: defineService({ forProduct: async () => ({ count: 3 }) }),
  inventory: defineService({ stock: async () => ({ available: true }) }),
});

const serviceData = createServiceData<typeof registry>();

const emitted = { source: 'boot' as const, emittedAt: '2026-07-28T00:00:00.000Z' };

const configWith = (attr: Record<string, unknown>): CoreTaujsConfig => ({
  apps: [{ appId: 'shop', entryPoint: '', routes: [{ path: '/product/:id', attr: attr as never }] }],
});

describe('createRequestGraph deferred entries (RFC 0007 R5)', () => {
  it('emits nothing for a route declaring no deferred entries (byte-identical emission)', () => {
    const graph = createRequestGraph(configWith({ render: 'streaming', meta: {} }), emitted);

    expect('deferred' in graph.routes[0]!).toBe(false);
    expect(JSON.stringify(graph.routes[0])).not.toContain('deferred');
  });

  it('emits key-SORTED entries, deriving each edge exactly like the data edge', () => {
    const graph = createRequestGraph(
      configWith({
        render: 'streaming',
        meta: {},
        deferred: {
          stock: serviceData('inventory', 'stock', () => ({})),
          reviews: serviceData('reviews', 'forProduct', () => ({})),
          notes: async () => ({ note: 'dynamic' }),
        },
      }),
      emitted,
    );

    expect(graph.routes[0]!.deferred).toEqual([
      { key: 'notes', data: { kind: 'dynamic' } },
      { key: 'reviews', data: { kind: 'service', service: 'reviews', method: 'forProduct' } },
      { key: 'stock', data: { kind: 'service', service: 'inventory', method: 'stock' } },
    ]);
  });

  it('is deterministic across runs', () => {
    const config = configWith({
      render: 'streaming',
      meta: {},
      deferred: { stock: serviceData('inventory', 'stock', () => ({})), reviews: serviceData('reviews', 'forProduct', () => ({})) },
    });

    expect(JSON.stringify(createRequestGraph(config, emitted))).toBe(JSON.stringify(createRequestGraph(config, emitted)));
  });

  it('contributes to GraphServiceMethod.usedBy exactly as a data edge does, with routeId dedupe', () => {
    const graph = createRequestGraph(
      {
        apps: [
          {
            appId: 'shop',
            entryPoint: '',
            routes: [
              {
                path: '/product/:id',
                attr: {
                  render: 'streaming',
                  meta: {},
                  // The SAME method both critically and deferred, plus a second deferred key on it:
                  // the route must appear at most once.
                  data: serviceData('reviews', 'forProduct', () => ({})),
                  deferred: {
                    reviews: serviceData('reviews', 'forProduct', () => ({})),
                    alsoReviews: serviceData('reviews', 'forProduct', () => ({})),
                    stock: serviceData('inventory', 'stock', () => ({})),
                  },
                } as never,
              },
              { path: '/plain', attr: { render: 'streaming', meta: {} } as never },
            ],
          },
        ],
      },
      { ...emitted, serviceRegistry: registry },
    );

    const byName = Object.fromEntries(graph.services!.map((s) => [s.name, s]));
    expect(byName['reviews']!.methods[0]!.usedBy).toEqual([{ routeId: 'shop:/product/:id', appId: 'shop', path: '/product/:id' }]);
    // A method reached ONLY through a deferred declaration is still a declared edge.
    expect(byName['inventory']!.methods[0]!.usedBy).toEqual([{ routeId: 'shop:/product/:id', appId: 'shop', path: '/product/:id' }]);
  });

  it('ignores non-function entries and inherited keys', () => {
    const graph = createRequestGraph(
      configWith({ render: 'streaming', meta: {}, deferred: Object.assign(Object.create({ inherited: () => ({}) }), { reviews: async () => ({}) }) }),
      emitted,
    );

    expect(graph.routes[0]!.deferred).toEqual([{ key: 'reviews', data: { kind: 'dynamic' } }]);
  });
});
