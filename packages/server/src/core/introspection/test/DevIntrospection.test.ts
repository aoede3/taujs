// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import { defineService, defineServiceRegistry, callServiceMethod } from '../../services/DataServices';
import { createDevIntrospection } from '../DevIntrospection';
import { createSafeRecorder, noopTraceRecorder } from '../TraceRecorder';

import type { TraceRecorder } from '../TraceRecorder';

const T = 'trace-1';

const start = (dev: ReturnType<typeof createDevIntrospection>, url = '/product/123?ref=x', traceId = T) =>
  dev.recorder.requestStart({ traceId, url, method: 'GET' });

describe('trace assembly — event sequences (spec 03 §1-2)', () => {
  it('rendered SSR: requestStart → routeMatched → dataFetch → serviceCall → sent', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.routeMatched({ traceId: T, path: '/product/:id', appId: 'storefront', render: 'ssr' });
    dev.recorder.dataFetch({ traceId: T, ms: 12.5, ok: true });
    dev.recorder.serviceCall({ traceId: T, service: 'catalog', method: 'getProduct', ms: 11.2, ok: true });
    dev.recorder.sent({ traceId: T, status: 200, mode: 'ssr' });

    const [trace] = dev.getTraces();
    expect(trace).toMatchObject({
      traceId: T,
      bootId: dev.bootId,
      route: '/product/:id',
      appId: 'storefront',
      mode: 'ssr',
      outcome: 'complete',
      status: 200,
      serviceCalls: [{ service: 'catalog', method: 'getProduct', ms: 11.2, ok: true }],
      client: null,
      error: null,
    });
    expect(trace!.timeline.matched).toBeTypeOf('number');
    expect(trace!.timeline.dataStart).toBeTypeOf('number');
    expect(trace!.timeline.dataEnd).toBeTypeOf('number');
  });

  it('rendered streaming: streamPhase events land in the timeline', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.routeMatched({ traceId: T, path: '/p', appId: 'a', render: 'streaming' });
    dev.recorder.streamPhase({ traceId: T, phase: 'head' });
    dev.recorder.streamPhase({ traceId: T, phase: 'shellReady' });
    dev.recorder.streamPhase({ traceId: T, phase: 'allReady' });
    dev.recorder.sent({ traceId: T, status: 200, mode: 'streaming' });

    const [trace] = dev.getTraces();
    expect(trace!.mode).toBe('streaming');
    expect(trace!.outcome).toBe('complete');
    expect(trace!.timeline.head).toBeTypeOf('number');
    expect(trace!.timeline.shellReady).toBeTypeOf('number');
    expect(trace!.timeline.allReady).toBeTypeOf('number');
  });

  it('fallthrough: requestStart → sent(fallthrough), no routeMatched → route null, mode fallthrough', () => {
    const dev = createDevIntrospection();
    start(dev, '/spa/unknown');
    dev.recorder.sent({ traceId: T, status: 200, mode: 'fallthrough' });

    const [trace] = dev.getTraces();
    expect(trace).toMatchObject({ route: null, appId: null, mode: 'fallthrough', outcome: 'complete', status: 200 });
  });

  it('failed: outcome failed with error kind and capped message', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.routeMatched({ traceId: T, path: '/p', appId: 'a', render: 'ssr' });
    dev.recorder.failed({ traceId: T, error: { kind: 'domain', message: 'x'.repeat(600) } });

    const [trace] = dev.getTraces();
    expect(trace!.outcome).toBe('failed');
    expect(trace!.error!.kind).toBe('domain');
    expect(trace!.error!.message).toHaveLength(500);
  });

  it('aborted is terminal: a later sent cannot resurrect or duplicate the trace', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.aborted({ traceId: T, phase: 'stream' });
    dev.recorder.aborted({ traceId: T, phase: 'stream' });
    dev.recorder.sent({ traceId: T, status: 200, mode: 'ssr' });

    const traces = dev.getTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.outcome).toBe('aborted');
  });

  it('events for unknown traceIds are ignored, never thrown', () => {
    const dev = createDevIntrospection();
    dev.recorder.routeMatched({ traceId: 'ghost', path: '/p', appId: 'a', render: 'ssr' });
    dev.recorder.sent({ traceId: 'ghost', status: 200, mode: 'ssr' });

    expect(dev.getTraces()).toHaveLength(0);
  });

  it('ring buffer keeps the last 200 traces', () => {
    const dev = createDevIntrospection();
    for (let i = 0; i < 205; i++) {
      const id = `t-${i}`;
      dev.recorder.requestStart({ traceId: id, url: '/x', method: 'GET' });
      dev.recorder.sent({ traceId: id, status: 200, mode: 'ssr' });
    }

    const traces = dev.getTraces();
    expect(traces).toHaveLength(200);
    expect(traces[0]!.traceId).toBe('t-5');
    expect(dev.getTraces(10)).toHaveLength(10);
  });
});

describe('URL hygiene (spec 03 §2, acceptance #4)', () => {
  it('stores pathname + surviving query keys only; denylisted keys dropped entirely', () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ traceId: T, url: '/reset?token=abc&ref=x', method: 'GET' });
    dev.recorder.sent({ traceId: T, status: 200, mode: 'fallthrough' });

    const [trace] = dev.getTraces();
    expect(trace!.url).toEqual({ pathname: '/reset', queryKeys: ['ref'], queryValuesRedacted: true });
    expect(JSON.stringify(trace)).not.toContain('abc');
    expect(JSON.stringify(trace)).not.toContain('token');
  });
});

describe('clientHydration beacon application', () => {
  it('applies once per traceId, even after finalization; duplicates ignored', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.sent({ traceId: T, status: 200, mode: 'ssr' });
    dev.recorder.clientHydration({ traceId: T, ok: true, ms: 38 });
    dev.recorder.clientHydration({ traceId: T, ok: false, error: 'late duplicate' });

    const [trace] = dev.getTraces();
    expect(trace!.client).toEqual({ hydrated: true, hydrationMs: 38, error: null });
  });

  it('drops beacons for unknown/evicted traces silently', () => {
    const dev = createDevIntrospection();
    dev.recorder.clientHydration({ traceId: 'gone', ok: true });

    expect(dev.getTraces()).toHaveLength(0);
  });
});

describe('observations derivation (spec 03 §4)', () => {
  it('upserts edges with routes, counts, and sample traceIds; shapes deferred as empty', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.routeMatched({ traceId: T, path: '/product/:id', appId: 'storefront', render: 'ssr' });
    dev.recorder.serviceCall({ traceId: T, service: 'catalog', method: 'getProduct', ms: 10, ok: true });
    dev.recorder.serviceCall({ traceId: T, service: 'catalog', method: 'getProduct', ms: 12, ok: true });

    const obs = dev.getObservations();
    expect(obs.schemaVersion).toBe(1);
    expect(obs.bootId).toBe(dev.bootId);
    expect(obs.shapes).toEqual([]);
    expect(obs.edges).toHaveLength(1);
    expect(obs.edges[0]).toMatchObject({
      service: 'catalog',
      method: 'getProduct',
      count: 2,
      routes: [{ routeId: 'storefront:/product/:id', appId: 'storefront', path: '/product/:id' }],
      sampleTraceIds: [T],
    });
  });
});

describe('logs annex tee (spec 03 §3)', () => {
  const mkBase = () => {
    const base: any = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      isDebugEnabled: vi.fn(() => false),
    };
    base.child = vi.fn(() => base);
    return base;
  };

  it('captures info/warn/error with caps and redaction; debug excluded; delegation intact', () => {
    const dev = createDevIntrospection();
    const base = mkBase();
    const wrapped = dev.wrapRequestLogger(base, T);

    wrapped.debug({ secretNote: 1 }, 'debug line');
    wrapped.info({ userId: 7, authToken: 'sensitive', nested: { password: 'x', keep: 'y'.repeat(300) } }, 'm'.repeat(600));
    wrapped.warn({}, 'warned');
    wrapped.error({}, 'errored');

    expect(base.debug).toHaveBeenCalledTimes(1);
    expect(base.info).toHaveBeenCalledTimes(1);

    const logs = dev.getLogs(T);
    expect(logs).toHaveLength(3);
    expect(logs.map((l) => l.level)).toEqual(['info', 'warn', 'error']);

    const info = logs[0]!;
    expect(info.msg).toHaveLength(500);
    const meta = info.meta as any;
    expect(meta.userId).toBe('7');
    expect(meta.authToken).toBeUndefined();
    expect(meta.nested.password).toBeUndefined();
    expect(meta.nested.keep).toHaveLength(200);
    expect(JSON.stringify(logs)).not.toContain('sensitive');
  });

  it('child loggers stay teed to the same traceId', () => {
    const dev = createDevIntrospection();
    const base = mkBase();
    const wrapped = dev.wrapRequestLogger(base, T);

    wrapped.child({ component: 'service-call' }).warn({}, 'from child');

    expect(dev.getLogs(T)).toHaveLength(1);
    expect(base.child).toHaveBeenCalledWith({ component: 'service-call' });
  });

  it('caps the annex ring at 2000 records', () => {
    const dev = createDevIntrospection();
    const wrapped = dev.wrapRequestLogger(mkBase(), T);
    for (let i = 0; i < 2005; i++) wrapped.info({}, `line ${i}`);

    const logs = dev.getLogs();
    expect(logs).toHaveLength(2000);
    expect(logs[0]!.msg).toBe('line 5');
  });
});

describe('recorder isolation (spec 03 invariant 2)', () => {
  const hostile: TraceRecorder = {
    requestStart() {
      throw new Error('hostile');
    },
    routeMatched() {
      throw new Error('hostile');
    },
    dataFetch() {
      throw new Error('hostile');
    },
    serviceCall() {
      throw new Error('hostile');
    },
    streamPhase() {
      throw new Error('hostile');
    },
    sent() {
      throw new Error('hostile');
    },
    aborted() {
      throw new Error('hostile');
    },
    failed() {
      throw new Error('hostile');
    },
    clientHydration() {
      throw new Error('hostile');
    },
  };

  it('createSafeRecorder swallows every implementation throw, warning once', () => {
    const onFirstError = vi.fn();
    const safe = createSafeRecorder(hostile, onFirstError);

    expect(() => {
      safe.requestStart({ traceId: T, url: '/x', method: 'GET' });
      safe.routeMatched({ traceId: T, path: '/p', appId: 'a', render: 'ssr' });
      safe.dataFetch({ traceId: T, ms: 1, ok: true });
      safe.serviceCall({ traceId: T, service: 's', method: 'm', ms: 1, ok: true });
      safe.streamPhase({ traceId: T, phase: 'head' });
      safe.sent({ traceId: T, status: 200, mode: 'ssr' });
      safe.aborted({ traceId: T });
      safe.failed({ traceId: T, error: { kind: 'x', message: 'y' } });
      safe.clientHydration({ traceId: T, ok: true });
    }).not.toThrow();
    expect(onFirstError).toHaveBeenCalledTimes(1);
  });

  it('callServiceMethod responses are identical with a hostile recorder on ctx', async () => {
    const registry = defineServiceRegistry({
      svc: defineService({ hello: async (_p: {}) => ({ greeting: 'hi' }) }),
    });
    const safeHostile = createSafeRecorder(hostile);

    const without = await callServiceMethod(registry, 'svc', 'hello', {}, { traceId: T });
    const withHostile = await callServiceMethod(registry, 'svc', 'hello', {}, { traceId: T, recorder: safeHostile });

    expect(withHostile).toEqual(without);
  });

  it('noopTraceRecorder implements every event as a no-op', () => {
    expect(() => {
      noopTraceRecorder.requestStart({ traceId: T, url: '/x', method: 'GET' });
      noopTraceRecorder.sent({ traceId: T, status: 200, mode: 'ssr' });
    }).not.toThrow();
  });
});

describe('serviceCall wiring in callServiceMethod', () => {
  it('records ok and failure outcomes with timing', async () => {
    const registry = defineServiceRegistry({
      svc: defineService({
        ok: async (_p: {}) => ({ fine: true }),
        boom: async (_p: {}): Promise<{ [k: string]: never }> => {
          throw new Error('kaput');
        },
      }),
    });
    const events: any[] = [];
    const recorder = { ...noopTraceRecorder, serviceCall: (e: any) => void events.push(e) };

    await callServiceMethod(registry, 'svc', 'ok', {}, { traceId: T, recorder });
    await expect(callServiceMethod(registry, 'svc', 'boom', {}, { traceId: T, recorder })).rejects.toThrow('kaput');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ traceId: T, service: 'svc', method: 'ok', ok: true });
    expect(events[1]).toMatchObject({ traceId: T, service: 'svc', method: 'boom', ok: false });
    expect(events[0].ms).toBeTypeOf('number');
  });
});
