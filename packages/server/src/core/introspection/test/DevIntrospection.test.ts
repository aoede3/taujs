// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import { defineService, defineServiceRegistry, callServiceMethod } from '../../services/DataServices';
import { createDevIntrospection } from '../DevIntrospection';
import { createSafeRecorder, noopEpisodeRecorder } from '../EpisodeRecorder';

import type { EpisodeRecorder } from '../EpisodeRecorder';

const T = 'episode-1';

const start = (dev: ReturnType<typeof createDevIntrospection>, url = '/product/123?ref=x', requestId = T) =>
  dev.recorder.requestStart({ requestId, url, method: 'GET' });

describe('episode assembly - event sequences (spec 03 §1-2)', () => {
  it('rendered SSR: requestStart → routeMatched → dataFetch → serviceCall → sent', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.routeMatched({ requestId: T, path: '/product/:id', appId: 'storefront', render: 'ssr' });
    dev.recorder.dataFetch({ requestId: T, ms: 12.5, ok: true });
    dev.recorder.serviceCall({ requestId: T, service: 'catalog', method: 'getProduct', ms: 11.2, ok: true });
    dev.recorder.sent({ requestId: T, status: 200, mode: 'ssr' });

    const [episode] = dev.getEpisodes();
    expect(episode).toMatchObject({
      requestId: T,
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
    expect(episode!.timeline.matched).toBeTypeOf('number');
    expect(episode!.timeline.dataStart).toBeTypeOf('number');
    expect(episode!.timeline.dataEnd).toBeTypeOf('number');
  });

  it('rendered streaming: streamPhase events land in the timeline', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.routeMatched({ requestId: T, path: '/p', appId: 'a', render: 'streaming' });
    dev.recorder.streamPhase({ requestId: T, phase: 'head' });
    dev.recorder.streamPhase({ requestId: T, phase: 'shellReady' });
    dev.recorder.streamPhase({ requestId: T, phase: 'allReady' });
    dev.recorder.sent({ requestId: T, status: 200, mode: 'streaming' });

    const [episode] = dev.getEpisodes();
    expect(episode!.mode).toBe('streaming');
    expect(episode!.outcome).toBe('complete');
    expect(episode!.timeline.head).toBeTypeOf('number');
    expect(episode!.timeline.shellReady).toBeTypeOf('number');
    expect(episode!.timeline.allReady).toBeTypeOf('number');
  });

  it('fallthrough: requestStart → sent(fallthrough), no routeMatched → route null, mode fallthrough', () => {
    const dev = createDevIntrospection();
    start(dev, '/spa/unknown');
    dev.recorder.sent({ requestId: T, status: 200, mode: 'fallthrough' });

    const [episode] = dev.getEpisodes();
    expect(episode).toMatchObject({ route: null, appId: null, mode: 'fallthrough', outcome: 'complete', status: 200 });
  });

  it('failed: outcome failed with error kind and capped message', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.routeMatched({ requestId: T, path: '/p', appId: 'a', render: 'ssr' });
    dev.recorder.failed({ requestId: T, error: { kind: 'domain', message: 'x'.repeat(600) } });

    const [episode] = dev.getEpisodes();
    expect(episode!.outcome).toBe('failed');
    expect(episode!.error!.kind).toBe('domain');
    expect(episode!.error!.message).toHaveLength(500);
  });

  it('aborted is terminal: a later sent cannot resurrect or duplicate the episode', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.aborted({ requestId: T, phase: 'stream' });
    dev.recorder.aborted({ requestId: T, phase: 'stream' });
    dev.recorder.sent({ requestId: T, status: 200, mode: 'ssr' });

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.outcome).toBe('aborted');
  });

  it('events for unknown request IDs are ignored, never thrown', () => {
    const dev = createDevIntrospection();
    dev.recorder.routeMatched({ requestId: 'ghost', path: '/p', appId: 'a', render: 'ssr' });
    dev.recorder.sent({ requestId: 'ghost', status: 200, mode: 'ssr' });

    expect(dev.getEpisodes()).toHaveLength(0);
  });

  it('ring buffer keeps the last 200 episodes', () => {
    const dev = createDevIntrospection();
    for (let i = 0; i < 205; i++) {
      const id = `t-${i}`;
      dev.recorder.requestStart({ requestId: id, url: '/x', method: 'GET' });
      dev.recorder.sent({ requestId: id, status: 200, mode: 'ssr' });
    }

    const episodes = dev.getEpisodes();
    expect(episodes).toHaveLength(200);
    expect(episodes[0]!.requestId).toBe('t-5');
    expect(dev.getEpisodes(10)).toHaveLength(10);
  });
});

describe('URL hygiene (spec 03 §2, acceptance #4)', () => {
  it('stores pathname + surviving query keys only; denylisted keys dropped entirely', () => {
    const dev = createDevIntrospection();
    dev.recorder.requestStart({ requestId: T, url: '/reset?token=abc&ref=x', method: 'GET' });
    dev.recorder.sent({ requestId: T, status: 200, mode: 'fallthrough' });

    const [episode] = dev.getEpisodes();
    // The record shape is the guarantee. A serialised substring sweep adds nothing here and
    // reads every random identifier too: `bootId` is a UUID, and `abc` is all hex.
    expect(episode!.url).toEqual({ pathname: '/reset', queryKeys: ['ref'], queryValuesRedacted: true });
  });
});

describe('clientHydration beacon application', () => {
  it('applies once per requestId, even after finalization; duplicates ignored', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.sent({ requestId: T, status: 200, mode: 'ssr' });
    dev.recorder.clientHydration({ requestId: T, ok: true, ms: 38 });
    dev.recorder.clientHydration({ requestId: T, ok: false, error: 'late duplicate' });

    const [episode] = dev.getEpisodes();
    expect(episode!.client).toEqual({ hydrated: true, hydrationMs: 38, error: null });
  });

  it('drops beacons for unknown/evicted episodes silently', () => {
    const dev = createDevIntrospection();
    dev.recorder.clientHydration({ requestId: 'gone', ok: true });

    expect(dev.getEpisodes()).toHaveLength(0);
  });
});

describe('observations derivation (spec 03 §4)', () => {
  it('upserts edges with routes, counts, and sample request IDs; shapes deferred as empty', () => {
    const dev = createDevIntrospection();
    start(dev);
    dev.recorder.routeMatched({ requestId: T, path: '/product/:id', appId: 'storefront', render: 'ssr' });
    dev.recorder.serviceCall({ requestId: T, service: 'catalog', method: 'getProduct', ms: 10, ok: true });
    dev.recorder.serviceCall({ requestId: T, service: 'catalog', method: 'getProduct', ms: 12, ok: true });

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
      sampleRequestIds: [T],
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

  // Pin the documented default: case-insensitive substring matching intentionally favours
  // over-redaction.
  it('matches deny keys as case-insensitive substrings, over-redacting by design', () => {
    const dev = createDevIntrospection();
    const wrapped = dev.wrapRequestLogger(mkBase(), T);

    wrapped.info(
      {
        // Genuinely sensitive - these spellings must drop, including all-lowercase
        // concatenations.
        authToken: 'a',
        API_KEY: 'b',
        Authorization: 'c',
        usertoken: 'd',
        // Innocent, and dropped anyway: the documented cost of the conservative rule.
        monkeyId: 'e',
        authorName: 'f',
        // Unrelated to any deny key - the rule is not a blanket drop.
        userId: 'g',
        totalCount: 'h',
      },
      'meta',
    );

    const meta = dev.getLogs(T)[0]!.meta as Record<string, unknown>;

    for (const dropped of ['authToken', 'API_KEY', 'Authorization', 'usertoken', 'monkeyId', 'authorName']) {
      expect(meta[dropped], dropped).toBeUndefined();
    }
    expect(meta.userId).toBe('g');
    expect(meta.totalCount).toBe('h');
  });

  it('replaceDefaultDenyKeys hands the whole policy to the caller', () => {
    const dev = createDevIntrospection({ denyKeys: ['classified'], replaceDefaultDenyKeys: true });
    const wrapped = dev.wrapRequestLogger(mkBase(), T);

    wrapped.info({ classified: 'x', password: 'y', monkeyId: 'z' }, 'meta');

    const meta = dev.getLogs(T)[0]!.meta as Record<string, unknown>;
    expect(meta.classified).toBeUndefined();
    // The defaults are gone entirely, including the ones that protect.
    expect(meta.password).toBe('y');
    expect(meta.monkeyId).toBe('z');
  });

  it('child loggers stay teed to the same requestId', () => {
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
  const hostile: EpisodeRecorder = {
    requestStart() {
      throw new Error('hostile');
    },
    routeMatched() {
      throw new Error('hostile');
    },
    dataFetch() {
      throw new Error('hostile');
    },
    deferredData() {
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
      safe.requestStart({ requestId: T, url: '/x', method: 'GET' });
      safe.routeMatched({ requestId: T, path: '/p', appId: 'a', render: 'ssr' });
      safe.dataFetch({ requestId: T, ms: 1, ok: true });
      safe.serviceCall({ requestId: T, service: 's', method: 'm', ms: 1, ok: true });
      safe.streamPhase({ requestId: T, phase: 'head' });
      safe.sent({ requestId: T, status: 200, mode: 'ssr' });
      safe.aborted({ requestId: T });
      safe.failed({ requestId: T, error: { kind: 'x', message: 'y' } });
      safe.clientHydration({ requestId: T, ok: true });
    }).not.toThrow();
    expect(onFirstError).toHaveBeenCalledTimes(1);
  });

  it('callServiceMethod responses are identical with a hostile recorder on ctx', async () => {
    const registry = defineServiceRegistry({
      svc: defineService({ hello: async (_p: {}) => ({ greeting: 'hi' }) }),
    });
    const safeHostile = createSafeRecorder(hostile);

    const without = await callServiceMethod(registry, 'svc', 'hello', {}, { requestId: T });
    const withHostile = await callServiceMethod(registry, 'svc', 'hello', {}, { requestId: T, recorder: safeHostile });

    expect(withHostile).toEqual(without);
  });

  it('noopEpisodeRecorder implements every event as a no-op', () => {
    expect(() => {
      noopEpisodeRecorder.requestStart({ requestId: T, url: '/x', method: 'GET' });
      noopEpisodeRecorder.sent({ requestId: T, status: 200, mode: 'ssr' });
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
    const recorder = { ...noopEpisodeRecorder, serviceCall: (e: any) => void events.push(e) };

    await callServiceMethod(registry, 'svc', 'ok', {}, { requestId: T, recorder });
    await expect(callServiceMethod(registry, 'svc', 'boom', {}, { requestId: T, recorder })).rejects.toThrow('kaput');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ requestId: T, service: 'svc', method: 'ok', ok: true });
    expect(events[1]).toMatchObject({ requestId: T, service: 'svc', method: 'boom', ok: false });
    expect(events[0].ms).toBeTypeOf('number');
  });
});
