// @vitest-environment node
// RFC 0007 - @taujs/vue server adapter: renderer contract items 1-9 against REAL
// @vue/server-renderer and a REAL PassThrough.
import { PassThrough } from 'node:stream';

import { defineComponent, h, inject } from 'vue';
import { describe, it, expect, vi } from 'vitest';

import { createRenderer, type StreamOptions } from '../SSRRender';
import { createDeferredAccessor, createDeferredHolder, DeferredDataError, DEFERRED_DATA_KEY, useDeferredData, useDeferredDataResult } from '../SSRDeferredData';

import type { DeferredHolder } from '../SSRDeferredData';
import type { Component } from 'vue';

const settle = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

type Registry = Record<string, Promise<Record<string, unknown>>>;

const deferredRegistry = (entries: Record<string, Promise<Record<string, unknown>>>): Registry => {
  for (const promise of Object.values(entries)) promise.catch(() => {}); // the host pre-observes
  return Object.freeze({ ...entries });
};

const drive = async (appComponent: Component, opts: { deferredData?: Registry; streamOptions?: StreamOptions; wait?: number } = {}) => {
  const writable = new PassThrough();
  const chunks: { at: number; text: string }[] = [];
  const t0 = Date.now();
  writable.on('data', (c) => chunks.push({ at: Date.now() - t0, text: c.toString() }));

  const { renderStream } = createRenderer({ appComponent, headContent: () => '<title>t</title>', streamOptions: opts.streamOptions });
  const errors: unknown[] = [];
  const handle = renderStream(
    writable,
    { onHead: () => {}, onAllReady: () => {}, onError: (e) => errors.push(e) },
    { critical: 1 },
    '/product/42',
    undefined,
    {},
    undefined,
    { ...(opts.deferredData ? { deferredData: opts.deferredData } : {}), shouldHydrate: true },
  );

  await Promise.race([handle.done.catch(() => {}), settle(opts.wait ?? 500)]);
  await settle(20);

  return { chunks, html: chunks.map((c) => c.text).join(''), errors, handle, t0 };
};

const Reviews = defineComponent({
  name: 'Reviews',
  async setup() {
    const data = await useDeferredData<{ count: number }>('reviews');
    return () => h('p', { id: 'reviews' }, `reviews: ${data.count}`);
  },
});

const ReviewsResult = defineComponent({
  name: 'ReviewsResult',
  async setup() {
    const result = await useDeferredDataResult<{ count: number }>('reviews');
    return () =>
      result.status === 'complete'
        ? h('p', { id: 'reviews' }, `reviews: ${result.value.count}`)
        : h('p', { id: 'fallback' }, `reviews unavailable (${result.status})`);
  },
});

const page = (boundary: Component) =>
  defineComponent({
    name: 'Page',
    setup() {
      return () =>
        h('main', [h('p', { id: 'before' }, 'independent content, before the boundary'), h(boundary), h('p', { id: 'after' }, 'after the boundary')]);
    },
  });

describe('@taujs/vue deferred adapter - native projection (renderer contract 1-3)', () => {
  it('IN-ORDER class (decision 12): independent content PRECEDING the boundary streams before the value', async () => {
    let resolveReviews!: (v: Record<string, unknown>) => void;
    const reviews = new Promise<Record<string, unknown>>((r) => (resolveReviews = r));

    const driven = drive(page(Reviews), { deferredData: deferredRegistry({ reviews }) });
    await settle(120);
    resolveReviews({ count: 3 });
    const { chunks, html } = await driven;

    const beforeAt = chunks.find((c) => c.text.includes('independent content'))!.at;
    const valueAt = chunks.find((c) => c.text.includes('reviews: 3'))!.at;
    const afterAt = chunks.find((c) => c.text.includes('after the boundary'))!.at;

    expect(beforeAt).toBeLessThan(valueAt);
    // Vue's in-order stream holds everything AFTER an awaited boundary - the honest ordering class,
    // and the reason the authoring rule is "place the boundary last in the region you care about".
    expect(afterAt).toBeGreaterThanOrEqual(valueAt);
    expect(html).toContain('reviews: 3');
  });

  it('delivers the late boundary through VUE’s own stream - there is no patch protocol and τjs emits no bytes', async () => {
    const { html } = await drive(page(Reviews), { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }) });

    expect(html).toContain('reviews: 3');
    expect(html).not.toMatch(/\$RC|\$RV|\$RX|<template id=|<div hidden id=/);
    expect(html).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(html).not.toContain('__INITIAL_DATA__');
  });

  it('a route with NO registry renders byte-identical output (the provide adds no node)', async () => {
    const Plain = defineComponent({ name: 'Plain', setup: () => () => h('p', 'content') });

    const a = await drive(page(Plain));
    const b = await drive(page(Plain), { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }) });

    // A declared-but-UNCONSUMED registry must not add a single byte - no Fragment anchors.
    expect(b.html).toBe(a.html);
  });
});

describe('@taujs/vue deferred adapter - failure legs (renderer contract 6, 7)', () => {
  it('leg 1 - a consumed rejection completes the RESPONSE through the detail-free result accessor', async () => {
    const { html, errors } = await drive(page(ReviewsResult), {
      deferredData: deferredRegistry({ reviews: Promise.reject(new Error('REVIEWS_BACKEND_SECRET')) }),
    });

    expect(html).toContain('reviews unavailable (failed)');
    expect(html).not.toContain('REVIEWS_BACKEND_SECRET');
    expect(errors).toEqual([]);
  });

  it('leg 2 - an UNCONSUMED rejection raises no unhandledRejection and does not reverse the document', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const Plain = defineComponent({ name: 'Plain', setup: () => () => h('p', 'shell only') });
      const { html, errors } = await drive(page(Plain), { deferredData: deferredRegistry({ reviews: Promise.reject(new Error('nobody reads me')) }) });
      await settle(30);
      expect(html).toContain('shell only');
      expect(errors).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  it('an unknown key is a deterministic DEVELOPER error naming the declared set', () => {
    const holder = createDeferredHolder(deferredRegistry({ reviews: Promise.resolve({ count: 1 }) }));

    expect(() => holder.result('nope')).toThrow(/unknown deferred data key "nope"/);
    expect(() => holder.result('nope')).toThrow(/"reviews"/);
  });

  it('reading outside a provider is a deterministic developer error', async () => {
    const Orphan = defineComponent({
      name: 'Orphan',
      async setup() {
        await useDeferredData('reviews');
        return () => h('p');
      },
    });
    const { errors } = await drive(page(Orphan));

    expect(String((errors[0] as Error)?.message)).toContain('was called outside a deferred-data provider');
  });

  it('the THROWING read rejects with the loader error server-side (Vue’s native error channel)', async () => {
    const holder = createDeferredHolder(deferredRegistry({ reviews: Promise.reject(new Error('loader detail')) }));

    await expect(holder.resource('reviews')).rejects.toThrow('loader detail');
  });

  it('the CLIENT never sees server detail: the hydration holder rejects with a DeferredDataError only', async () => {
    const { createHydrationHolder } = await import('../SSRDeferredData');
    const holder = createHydrationHolder({ reviews: { status: 'failed' } });

    await expect(holder.resource('reviews')).rejects.toBeInstanceOf(DeferredDataError);
  });
});

describe('@taujs/vue deferred adapter - CSP and hydration policy (renderer contract 5)', () => {
  it('every inline script the renderer emits on a deferred route carries the nonce', async () => {
    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on('data', (c) => chunks.push(c.toString()));
    const { renderStream } = createRenderer({ appComponent: page(Reviews), headContent: () => '' });
    const handle = renderStream(writable, { onHead: () => {} }, {}, '/x', '/bootstrap.js', {}, undefined, {
      deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }),
      cspNonce: 'NONCE123',
      shouldHydrate: true,
    });
    await Promise.race([handle.done.catch(() => {}), settle(400)]);
    const html = chunks.join('');

    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain('nonce="NONCE123"');
  });

  it('hydrate:false still streams the late boundary natively (the envelope is the host’s concern)', async () => {
    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on('data', (c) => chunks.push(c.toString()));
    const { renderStream } = createRenderer({ appComponent: page(Reviews), headContent: () => '' });
    const handle = renderStream(writable, { onHead: () => {} }, {}, '/x', undefined, {}, undefined, {
      deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }),
      shouldHydrate: false,
    });
    await Promise.race([handle.done.catch(() => {}), settle(400)]);

    expect(chunks.join('')).toContain('reviews: 3');
  });
});

describe('@taujs/vue deferred deadline (decision 18)', () => {
  it('rejects a non positive-finite value at the factory - there is no disable sentinel', () => {
    for (const bad of [0, Infinity, -1, NaN, '5' as unknown as number]) {
      expect(() => createRenderer({ appComponent: page(Reviews), headContent: () => '', streamOptions: { deferredTimeoutMs: bad } })).toThrow(
        /deferredTimeoutMs must be a positive finite number/,
      );
    }
  });

  it('DEFAULT CONFIGURATION: the SHIPPED deadline arms at 15_000, and no other post-shell deadline competes with it', async () => {
    // Deterministic (no 15-second run) and it OBSERVES THE MODULE rather than restating it: the
    // delay handed to `setTimeout` at the arming site is the shipped default minus what the shell
    // already spent, so this cell fails the moment the default moves in EITHER direction.
    const spy = vi.spyOn(globalThis, 'setTimeout');

    await drive(page(Reviews), { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }), wait: 300 });

    const armed = spy.mock.calls.map((call) => Number(call[1]));
    spy.mockRestore();

    // Armed at shell commit with what REMAINS of a 15_000 budget measured from renderStream entry.
    const deferred = armed.filter((ms) => ms > 14_000 && ms <= 15_000);
    expect(deferred).toHaveLength(1);

    // The package's only other bound, `shellTimeoutMs`, guards the PRE-shell phase and is stopped at
    // the first chunk - the exact moment this deadline is armed. They cannot race, and there is no
    // third armed bound between them.
    expect(armed).toContain(10_000);
    expect(armed.filter((ms) => ms >= 10_000)).toEqual([10_000, deferred[0]!]);
  });

  it('TIME ORIGIN: a costly shell arms what REMAINS of the budget, measured from renderStream ENTRY', async () => {
    // The magnitude cell above cannot see decision 18's time-ORIGIN clause: with a ~0ms shell the
    // remaining budget and the full budget are the same number. A CONTROLLED clock (no real waiting)
    // charges the pre-shell phase exactly 6_000ms of the 15_000 budget, so the arming site must hand
    // `setTimeout` 9_000. Arming the FULL budget instead would make the bound a property of how long
    // the first chunk happened to take rather than of the configuration - the total response time
    // would run to entry+21s here, and further with a slower shell.
    const base = Date.now();
    let elapsed = 0;
    const inner = page(Reviews);
    // `setup` runs DURING the shell render - after renderStream entry, before the first chunk.
    const CostlyPage = defineComponent({
      name: 'CostlyPage',
      setup() {
        elapsed = 6_000;

        return () => h(inner);
      },
    });

    const clock = vi.spyOn(Date, 'now').mockImplementation(() => base + elapsed);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    let armed: number[] = [];

    try {
      await drive(CostlyPage, { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }), wait: 300 });
      armed = spy.mock.calls.map((call) => Number(call[1]));
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }

    expect(armed).toContain(9_000); // 15_000 budget, 6_000 of it already spent before the shell
    expect(armed.filter((ms) => ms > 14_000 && ms <= 15_000)).toHaveLength(0); // never the full budget
    // The shell timer is armed AT entry and is not re-based, so the moved value is attributable to
    // the deferred arming site rather than to a global clock shift.
    expect(armed).toContain(10_000);
  });

  it('leg 4 - on expiry the still-pending boundary renders its `aborted` branch INTO the response and the document terminates', async () => {
    const { html, handle } = await drive(page(ReviewsResult), {
      deferredData: deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) }),
      streamOptions: { deferredTimeoutMs: 80 },
      wait: 800,
    });

    await expect(handle.done).resolves.toBeUndefined();
    expect(html).toContain('reviews unavailable (aborted)');
    expect(html).toContain('after the boundary'); // the in-order stream resumed
  });

  it('the deadline LATCHES: a read whose first access arrives after expiry is born `aborted`', async () => {
    const holder = createDeferredHolder(deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) }));

    expect(holder.expire()).toBe(0); // nothing consumed yet
    await expect(holder.result('reviews')).resolves.toEqual({ status: 'aborted' });
  });

  it('the deadline is ONE per response, never per key: a second key pending at expiry is abandoned with the first', async () => {
    const holder = createDeferredHolder(
      deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}), stock: new Promise<Record<string, unknown>>(() => {}) }),
    );

    void holder.result('reviews');
    void holder.result('stock');
    expect(holder.expire()).toBe(2);
    await expect(holder.result('reviews')).resolves.toEqual({ status: 'aborted' });
    await expect(holder.result('stock')).resolves.toEqual({ status: 'aborted' });
  });
});

describe('@taujs/vue deferred adapter - retention (renderer contract 8)', () => {
  it('release settles anything pending FIRST, then refuses later reads', async () => {
    const holder = createDeferredHolder(deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) }));

    const pending = holder.result('reviews');
    holder.release();

    // A mid-flight `unrollBuffer` await must never be left waiting on a promise nothing settles.
    await expect(pending).resolves.toEqual({ status: 'aborted' });
    expect(() => holder.result('reviews')).toThrow(/read after the response terminal/);
  });

  it('the RENDERER releases the holder at a terminal: a later read of the INJECTED holder is refused', async () => {
    // The holder is captured from inside the render, through the adapter's own injection key, so
    // the assertion reads the SAME holder the production path provided - the test never releases
    // it, so deleting the renderer's cleanup call fails this cell.
    let captured: DeferredHolder | undefined;
    const Capture = defineComponent({
      name: 'Capture',
      async setup() {
        captured = inject(DEFERRED_DATA_KEY, undefined);
        const result = await useDeferredDataResult<{ count: number }>('reviews');

        return () => h('p', { id: 'reviews' }, result.status === 'complete' ? `reviews: ${result.value.count}` : `reviews unavailable (${result.status})`);
      },
    });

    const writable = new PassThrough();
    const registry = deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) });
    const { renderStream } = createRenderer({ appComponent: page(Capture), headContent: () => '' });
    const handle = renderStream(writable, { onHead: () => {} }, {}, '/x', undefined, {}, undefined, { deferredData: registry });
    await settle(40);
    expect(captured).toBeDefined();

    handle.abort();

    // A caller abort is a BENIGN terminal, never a fatal one.
    await expect(handle.done).resolves.toBeUndefined();
    await settle(20);

    expect(() => captured!.result('reviews')).toThrow(/read after the response terminal/);
  });
});

describe('@taujs/vue deferred adapter - typed facade', () => {
  it('createDeferredAccessor derives both reads from the route config', async () => {
    type Deferred = { reviews: { count: number } };
    const deferred = createDeferredAccessor<Deferred>();
    const Typed = defineComponent({
      name: 'Typed',
      async setup() {
        const outcome = await deferred.result('reviews');
        return () => h('p', { id: 'typed' }, outcome.status === 'complete' ? `count: ${outcome.value.count}` : 'unavailable');
      },
    });

    const { html } = await drive(page(Typed), { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }) });

    expect(html).toContain('count: 3');
  });
});
