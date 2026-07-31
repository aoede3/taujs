// @vitest-environment node
// RFC 0007 (R2 + failure semantics): the request-local registry.
import { describe, it, expect, vi } from 'vitest';

import { buildDeferredEnvelopeJson, createDeferredData } from '../DeferredData';

import type { EpisodeRecorder } from '../../introspection/EpisodeRecorder';

const mkLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebugEnabled: () => false };
  l.child = () => l;
  return l;
};

type Event = { key: string; outcome: string };

const mkRecorder = (events: Event[]): EpisodeRecorder =>
  ({
    deferredData: (e: any) => events.push({ key: e.key, outcome: e.outcome }),
  }) as unknown as EpisodeRecorder;

const mk = (deferred: Record<string, unknown>, opts: { signal?: AbortSignal; events?: Event[]; logger?: any; callServiceMethodImpl?: any } = {}) => {
  const logger = opts.logger ?? mkLogger();
  const controller = createDeferredData({
    attr: { render: 'streaming', meta: {}, deferred } as any,
    params: { id: '42' },
    serviceRegistry: {} as any,
    ctx: { requestId: 't1', logger, headers: {}, signal: opts.signal },
    requestId: 't1',
    ...(opts.events ? { recorder: mkRecorder(opts.events) } : {}),
    ...(opts.callServiceMethodImpl ? { callServiceMethodImpl: opts.callServiceMethodImpl } : {}),
  });

  return { controller, logger };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createDeferredData - declaration and start (R2)', () => {
  it('returns undefined for a route declaring nothing (byte-identical no-deferred path)', () => {
    expect(
      createDeferredData({
        attr: { render: 'streaming', meta: {} } as any,
        params: {},
        serviceRegistry: {} as any,
        ctx: { requestId: 't', logger: mkLogger() },
        requestId: 't',
      }),
    ).toBeUndefined();
    expect(
      createDeferredData({
        attr: { render: 'ssr' } as any,
        params: {},
        serviceRegistry: {} as any,
        ctx: { requestId: 't', logger: mkLogger() },
        requestId: 't',
      }),
    ).toBeUndefined();
    expect(mk({}).controller).toBeUndefined();
  });

  it('invokes each handler EXACTLY ONCE, synchronously, with the matched params', () => {
    const calls: unknown[] = [];
    const handler = vi.fn(async (params: unknown) => {
      calls.push(params);
      return { ok: true };
    });
    const { controller } = mk({ reviews: handler });

    expect(handler).toHaveBeenCalledTimes(1); // synchronous at creation - before any component runs
    expect(calls[0]).toEqual({ id: '42' });
    expect(controller!.keys).toEqual(['reviews']);
    expect(Object.keys(controller!.registry)).toEqual(['reviews']);
  });

  it('a resolved entry delivers the PARSED SNAPSHOT, not the loader object (failure semantics 2)', async () => {
    const source = { count: 3, nested: { a: 1 }, dropped: () => {}, gone: undefined };
    const { controller } = mk({ reviews: async () => source });

    const delivered = await controller!.registry['reviews']!;
    expect(delivered).toEqual({ count: 3, nested: { a: 1 } });
    expect(delivered).not.toBe(source);
    expect(delivered['nested']).not.toBe(source.nested);

    // Post-settlement mutation of the loader's object reaches NEITHER surface.
    source.count = 999;
    (source.nested as { a: number }).a = 999;
    expect(delivered).toEqual({ count: 3, nested: { a: 1 } });
    expect(buildDeferredEnvelopeJson(controller!.settleAll())).toBe('{"reviews":{"status":"complete","value":{"count":3,"nested":{"a":1}}}}');
  });

  it('takes EXACTLY ONE snapshot attempt, whatever the application toJSON does', async () => {
    let calls = 0;
    const unstable = {
      toJSON() {
        calls += 1;
        return { call: calls };
      },
    };
    const { controller } = mk({ reviews: async () => unstable });

    const delivered = await controller!.registry['reviews']!;
    expect(delivered).toEqual({ call: 1 });
    expect(buildDeferredEnvelopeJson(controller!.settleAll())).toContain('{"call":1}');
    expect(calls).toBe(1);
  });

  it('a non-serialisable resolution is detail-free `failed` on EVERY surface, with one payload-free warn', async () => {
    const circular: Record<string, unknown> = { secret: 'PLAYGROUND_SECRET' };
    circular['self'] = circular;
    const events: Event[] = [];
    const { controller, logger } = mk({ reviews: async () => circular }, { events });

    await expect(controller!.registry['reviews']).rejects.toThrow(/deferred entry "reviews" resolved with a value that cannot be delivered/);
    const err = await controller!.registry['reviews']!.catch((e) => e);
    expect(String(err.message)).not.toContain('PLAYGROUND_SECRET');
    expect(String(err.message)).not.toContain('circular');
    expect((err as { cause?: unknown }).cause).toBeUndefined();

    expect(events).toEqual([{ key: 'reviews', outcome: 'failed' }]);
    expect(buildDeferredEnvelopeJson(controller!.settleAll())).toBe('{"reviews":{"status":"failed"}}');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [meta, message] = logger.warn.mock.calls[0];
    expect(message).toBe('Deferred data could not cross the hydration boundary');
    expect(meta).toEqual({ key: 'reviews', reqId: 't1' });
    expect(JSON.stringify(meta)).not.toContain('PLAYGROUND_SECRET');
  });

  it('decision 16: a non-record snapshot ROOT is `failed`, not a false record', async () => {
    const events: Event[] = [];
    const { controller } = mk({ reviews: async () => ({ toJSON: () => 5 }), listy: async () => ({ toJSON: () => [1, 2] }) }, { events });

    await expect(controller!.registry['reviews']).rejects.toThrow();
    await expect(controller!.registry['listy']).rejects.toThrow();
    expect(buildDeferredEnvelopeJson(controller!.settleAll())).toBe('{"listy":{"status":"failed"},"reviews":{"status":"failed"}}');
    expect(events.map((e) => e.outcome).sort()).toEqual(['failed', 'failed']);
  });

  it('a rejection stays a rejection, recorded once against its key (failure semantics 3)', async () => {
    const events: Event[] = [];
    const boom = new Error('service exploded');
    const { controller } = mk({ reviews: async () => Promise.reject(boom) }, { events });

    await expect(controller!.registry['reviews']).rejects.toBe(boom);
    expect(events).toEqual([{ key: 'reviews', outcome: 'failed' }]);
    controller!.settleAll();
    controller!.settleAll();
    expect(events).toEqual([{ key: 'reviews', outcome: 'failed' }]);
  });

  it('rejects a handler returning a non-plain-object through the shared resolver message', async () => {
    const { controller } = mk({ reviews: async () => 42 as unknown as Record<string, unknown> });

    await expect(controller!.registry['reviews']).rejects.toThrow(/attr\.deferred\."reviews" must return a plain object or a ServiceDescriptor/);
  });

  it('dispatches a ServiceDescriptor, and a dispatch rejection settles the entry `failed` unclassified', async () => {
    const boom = new Error('deferred service down');
    const events: Event[] = [];
    const { controller, logger } = mk(
      { reviews: async () => ({ serviceName: 'svc', serviceMethod: 'list' }), tags: async () => ({ serviceName: 'svc', serviceMethod: 'tags' }) },
      {
        events,
        callServiceMethodImpl: async (_registry: unknown, _service: string, method: string) => {
          if (method === 'list') throw boom;
          return { tags: ['a'] };
        },
      },
    );

    await expect(controller!.registry['reviews']).rejects.toBe(boom);
    await expect(controller!.registry['tags']).resolves.toEqual({ tags: ['a'] });
    expect(buildDeferredEnvelopeJson(controller!.settleAll())).toBe('{"reviews":{"status":"failed"},"tags":{"status":"complete","value":{"tags":["a"]}}}');
    expect(events).toEqual([
      { key: 'reviews', outcome: 'failed' },
      { key: 'tags', outcome: 'complete' },
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('createDeferredData - terminals (R2 item 8, failure semantics 7/8)', () => {
  it('an entry pending at the terminal is `aborted`, recorded once', async () => {
    const events: Event[] = [];
    const { controller } = mk({ reviews: () => new Promise<Record<string, unknown>>(() => {}) }, { events });

    expect(buildDeferredEnvelopeJson(controller!.settleAll())).toBe('{"reviews":{"status":"aborted"}}');
    expect(events).toEqual([{ key: 'reviews', outcome: 'aborted' }]);
  });

  it('signals outstanding work through a child signal derived from the request signal', async () => {
    let seen: AbortSignal | undefined;
    const { controller } = mk({
      reviews: async (_p: unknown, ctx: any) => {
        seen = ctx.signal;
        return new Promise<Record<string, unknown>>(() => {});
      },
    });

    await flush();
    expect(seen!.aborted).toBe(false);
    controller!.settleAll();
    expect(seen!.aborted).toBe(true);
  });

  it('caller abort WINS over application-error classification (failure semantics 7)', async () => {
    const events: Event[] = [];
    const ac = new AbortController();
    let rejectEntry!: (e: unknown) => void;
    const { controller } = mk({ reviews: () => new Promise<Record<string, unknown>>((_r, reject) => (rejectEntry = reject)) }, { signal: ac.signal, events });

    ac.abort();
    rejectEntry(new Error('late failure'));
    await flush();

    expect(events).toEqual([{ key: 'reviews', outcome: 'aborted' }]);
    // The registry reference is dropped: τjs retains no response-owned state.
    expect(Object.keys(controller!.registry)).toEqual([]);
    expect(buildDeferredEnvelopeJson(controller!.settleAll())).toBe('{}');
  });

  it('an ALREADY-aborted request still starts each handler once, with an aborted signal, then classifies `aborted`', async () => {
    const events: Event[] = [];
    const ac = new AbortController();
    ac.abort();
    const handler = vi.fn(async (_p: unknown, ctx: any) => ({ aborted: ctx.signal.aborted }));
    const { controller } = mk({ reviews: handler }, { signal: ac.signal, events });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ key: 'reviews', outcome: 'aborted' }]);
    expect(controller!.keys).toEqual(['reviews']);
    await flush();
  });

  it('release drops every retained reference and post-release settleAll fabricates nothing', async () => {
    const events: Event[] = [];
    const { controller } = mk({ reviews: async () => ({ count: 1 }) }, { events });

    await controller!.registry['reviews'];
    controller!.release();

    expect(Object.keys(controller!.registry)).toEqual([]);
    expect(buildDeferredEnvelopeJson(controller!.settleAll())).toBe('{}');
    expect(events).toEqual([{ key: 'reviews', outcome: 'complete' }]);
  });

  it('an unconsumed rejection never raises unhandledRejection (R0-01)', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { controller } = mk({ reviews: async () => Promise.reject(new Error('nobody reads me')) });
      void controller;
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});

describe('buildDeferredEnvelopeJson', () => {
  it('emits key-sorted, detail-free entries and splices the retained fragment verbatim', () => {
    expect(
      buildDeferredEnvelopeJson({
        stock: { status: 'aborted' },
        reviews: { status: 'complete', json: '{"count":3}' },
        blurb: { status: 'failed' },
      }),
    ).toBe('{"blurb":{"status":"failed"},"reviews":{"status":"complete","value":{"count":3}},"stock":{"status":"aborted"}}');
  });

  it('quotes and escapes keys', () => {
    expect(buildDeferredEnvelopeJson({ 'a"b': { status: 'aborted' } })).toBe('{"a\\"b":{"status":"aborted"}}');
  });
});
