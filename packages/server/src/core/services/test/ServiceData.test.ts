// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { fetchInitialData } from '../../routes/DataRoutes';
import { defineService, defineServiceRegistry, isServiceDescriptor } from '../DataServices';
import { createServiceData, getServiceDataMetadata } from '../ServiceData';

const getProduct = vi.fn(async (p: { id: string }, ctx?: { traceId?: string }) => ({ product: { id: p.id } }));
const listSpecials = vi.fn(async (_params: {}) => ({ items: ['sku_1'] }));

const registry = defineServiceRegistry({
  catalog: defineService({ getProduct, listSpecials }),
});

const serviceData = createServiceData<typeof registry>();

const mkCtx = () => ({ traceId: 'test-trace', headers: {} }) as any;

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
    expect((sugarCtx as any).traceId).toBe('test-trace');
    expect((handWrittenCtx as any).traceId).toBe('test-trace');
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
});
