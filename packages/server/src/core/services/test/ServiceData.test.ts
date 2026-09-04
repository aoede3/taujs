// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { fetchInitialData } from '../../routes/DataRoutes';
import { createRequestGraph } from '../../introspection/RequestGraph';
import { defineService, defineServiceRegistry, isServiceDescriptor } from '../DataServices';
import { createServiceData, getServiceDataMetadata } from '../ServiceData';

import type { CoreTaujsConfig } from '../../config/types';

const getProduct = vi.fn(async (p: { id: string }, ctx?: { requestId?: string }) => ({ product: { id: p.id } }));
const listSpecials = vi.fn(async (_params: {}) => ({ items: ['sku_1'] }));

const registry = defineServiceRegistry({
  catalog: defineService({ getProduct, listSpecials }),
});

const serviceData = createServiceData<typeof registry>();

const mkCtx = () => ({ requestId: 'test-episode', headers: {} }) as any;

beforeEach(() => {
  getProduct.mockClear();
  listSpecials.mockClear();
});

describe('createServiceData', () => {
  it('returns a handler producing a valid ServiceDescriptor with mapped args', async () => {
    const handler = serviceData('catalog', 'getProduct', (params) => ({ id: String(params.id) }));

    const descriptor = await handler({ id: '42' }, {} as any);

    expect(isServiceDescriptor(descriptor)).toBe(true);
    expect(descriptor).toEqual({ serviceName: 'catalog', serviceMethod: 'getProduct', args: { id: '42' } });
  });

  it('passes route params through as args when the mapper is omitted', async () => {
    const handler = serviceData('catalog', 'listSpecials');

    const descriptor = await handler({ page: '2' }, {} as any);

    expect(descriptor).toEqual({ serviceName: 'catalog', serviceMethod: 'listSpecials', args: { page: '2' } });
  });

  it('produces the identical descriptor a hand-written handler produces', async () => {
    const sugar = serviceData('catalog', 'getProduct', (params) => ({ id: String(params.id) }));
    const handWritten = async (params: any) => ({ serviceName: 'catalog', serviceMethod: 'getProduct', args: { id: String(params.id) } });

    expect(await sugar({ id: '42' }, {} as any)).toEqual(await handWritten({ id: '42' }));
  });

  it('dispatches through fetchInitialData identically to a hand-written descriptor handler', async () => {
    const sugar = serviceData('catalog', 'getProduct', (params) => ({ id: String(params.id) }));
    const handWritten = async (params: any) => ({ serviceName: 'catalog', serviceMethod: 'getProduct', args: { id: String(params.id) } });

    const fromSugar = await fetchInitialData({ data: sugar } as any, { id: '42' } as any, registry, mkCtx());
    const fromHandWritten = await fetchInitialData({ data: handWritten } as any, { id: '42' } as any, registry, mkCtx());

    expect(fromSugar).toEqual({ product: { id: '42' } });
    expect(fromSugar).toEqual(fromHandWritten);

    expect(getProduct).toHaveBeenCalledTimes(2);
    const [sugarArgs, sugarCtx] = getProduct.mock.calls[0]!;
    const [handWrittenArgs, handWrittenCtx] = getProduct.mock.calls[1]!;
    expect(sugarArgs).toEqual(handWrittenArgs);
    expect((sugarCtx as any).requestId).toBe('test-episode');
    expect((handWrittenCtx as any).requestId).toBe('test-episode');
  });
});

describe('getServiceDataMetadata', () => {
  it('reads { serviceName, serviceMethod } from a serviceData handler', () => {
    const handler = serviceData('catalog', 'getProduct', (params) => ({ id: String(params.id) }));

    const meta = getServiceDataMetadata(handler);

    expect(meta).toEqual({ serviceName: 'catalog', serviceMethod: 'getProduct' });
    expect(Object.isFrozen(meta)).toBe(true);
  });

  it('stamps metadata non-enumerably: keys, spread, and JSON never leak it', () => {
    const handler = serviceData('catalog', 'listSpecials');

    expect(Object.keys(handler)).toEqual([]);
    expect(Object.getOwnPropertySymbols({ ...handler })).toEqual([]);
  });

  it('returns undefined for unstamped functions and non-functions', () => {
    expect(getServiceDataMetadata(async () => ({}))).toBeUndefined();
    expect(getServiceDataMetadata({ serviceName: 'catalog', serviceMethod: 'getProduct' })).toBeUndefined();
    expect(getServiceDataMetadata(undefined)).toBeUndefined();
  });

  it('returns { serviceName, serviceMethod } unchanged for a two-argument mapper', () => {
    const handler = serviceData('catalog', 'getProduct', (params, facts) => ({ id: String(params.id), url: facts.url }));

    expect(getServiceDataMetadata(handler)).toEqual({ serviceName: 'catalog', serviceMethod: 'getProduct' });
  });
});

// The loader context a body, head or deferred loader receives (ResolveRouteData.ts's
// `runDataHandler` passes the identical `ctxForData` object as the handler's second argument on
// every path - see DataRoutes.ts and DeferredData.ts). `mkFactsCtx` stands in for it here.
const mkFactsCtx = () =>
  ({
    requestId: 'facts-episode',
    headers: { 'x-tenant': 'acme', host: 'example.com' },
    url: '/product/42?variant=blue',
  }) as any;

describe('serviceData mapper request facts', () => {
  it('gives the mapper url and headers equal to the enclosing loader context, mapped into descriptor args', async () => {
    const ctx = mkFactsCtx();
    const handler = serviceData('catalog', 'getProduct', (params, facts) => ({
      id: String(params.id),
      url: facts.url,
      tenant: facts.headers['x-tenant'],
    }));

    const descriptor = await handler({ id: '42' }, ctx);

    expect((descriptor as any).args).toEqual({ id: '42', url: ctx.url, tenant: ctx.headers['x-tenant'] });
  });

  it("gives the mapper a facts object and a headers object that are not the loader context's own objects", async () => {
    const ctx = mkFactsCtx();
    let seenFacts: any;
    let seenHeaders: any;
    const handler = serviceData('catalog', 'getProduct', (params, facts) => {
      seenFacts = facts;
      seenHeaders = facts.headers;
      return { id: String(params.id) };
    });

    await handler({ id: '1' }, ctx);

    expect(seenFacts).not.toBe(ctx);
    expect(seenHeaders).not.toBe(ctx.headers);
    expect(seenHeaders).toEqual(ctx.headers);
  });

  it('exposes only url and headers: no call, logger, signal, recorder, or requestId reach the mapper', async () => {
    const ctx = mkFactsCtx();
    let seenFacts: any;
    const handler = serviceData('catalog', 'getProduct', (params, facts) => {
      seenFacts = facts;
      return { id: String(params.id) };
    });

    await handler({ id: '1' }, ctx);

    expect(Object.keys(seenFacts)).toEqual(['url', 'headers']);
    for (const key of ['call', 'logger', 'signal', 'recorder', 'requestId']) {
      expect(key in seenFacts).toBe(false);
    }
  });

  it('NEGATIVE: freezes facts so assigning facts.url or facts.headers.host throws in strict mode, leaving ctx unchanged', async () => {
    const ctx = mkFactsCtx();
    let urlAssignError: unknown;
    let headerAssignError: unknown;
    const handler = serviceData('catalog', 'getProduct', (params, facts) => {
      try {
        (facts as any).url = '/mutated';
      } catch (err) {
        urlAssignError = err;
      }
      try {
        (facts.headers as any).host = 'mutated';
      } catch (err) {
        headerAssignError = err;
      }
      return { id: String(params.id) };
    });

    await handler({ id: '1' }, ctx);

    expect(urlAssignError).toBeInstanceOf(TypeError);
    expect(headerAssignError).toBeInstanceOf(TypeError);
    expect(ctx.url).toBe('/product/42?variant=blue');
    expect(ctx.headers.host).toBe('example.com');
  });
});

describe('createRequestGraph with a two-argument mapper', () => {
  it('reports the declared service edge, never dynamic', () => {
    const handler = serviceData('catalog', 'getProduct', (params, facts) => ({ id: String(params.id), url: facts.url }));
    const config: CoreTaujsConfig = {
      apps: [
        {
          appId: 'web',
          entryPoint: 'web',
          routes: [{ path: '/product/:id', attr: { render: 'ssr', data: handler } }],
        },
      ],
    };

    const graph = createRequestGraph(config, { source: 'boot', emittedAt: '2026-09-04T00:00:00.000Z', serviceRegistry: registry });
    const route = graph.routes.find((r) => r.path === '/product/:id');

    expect(route?.data).toEqual({ kind: 'service', service: 'catalog', method: 'getProduct' });
  });
});
