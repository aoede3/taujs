// @vitest-environment node
// RFC 0007 - @taujs/react server adapter: renderer contract items 1-9 against REAL
// react-dom/server and a REAL PassThrough.
import { PassThrough } from 'node:stream';

import React, { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';

import { createRenderer, type StreamOptions } from '../SSRRender';
import { createDeferredAccessor, DeferredDataError, useDeferredData, useDeferredDataResult } from '../SSRDeferredData';

const settle = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

/** Route data that never settles, so the fatal route-data backstop actually arms at shell commit. */
const pendingRouteData = () => new Promise<Record<string, unknown>>(() => {});

type Registry = Record<string, Promise<Record<string, unknown>>>;

const deferredRegistry = (entries: Record<string, Promise<Record<string, unknown>>>): Registry => {
  for (const promise of Object.values(entries)) promise.catch(() => {}); // the host pre-observes
  return Object.freeze({ ...entries });
};

const drive = async (
  appComponent: (props: { location: string }) => React.ReactElement,
  opts: {
    deferredData?: Registry;
    streamOptions?: StreamOptions;
    wait?: number;
    shouldHydrate?: boolean;
    /** Per-CALL overrides, i.e. the seam a standalone consumer reaches (the host sends none). */
    callOptions?: Record<string, unknown>;
    /** Left PENDING when a cell needs the fatal route-data backstop to actually arm. */
    initialData?: Record<string, unknown> | Promise<Record<string, unknown>>;
  } = {},
) => {
  const writable = new PassThrough();
  const chunks: { at: number; text: string }[] = [];
  const t0 = Date.now();
  writable.on('data', (c) => chunks.push({ at: Date.now() - t0, text: c.toString() }));

  const { renderStream } = createRenderer({ appComponent, headContent: () => '<title>t</title>', streamOptions: opts.streamOptions });
  const errors: unknown[] = [];
  const handle = renderStream(
    writable,
    { onHead: () => {}, onAllReady: () => {}, onError: (e) => errors.push(e) },
    opts.initialData ?? { critical: 1 },
    '/product/42',
    undefined,
    {},
    undefined,
    { ...(opts.deferredData ? { deferredData: opts.deferredData } : {}), shouldHydrate: opts.shouldHydrate ?? true, ...opts.callOptions },
  );

  await Promise.race([handle.done.catch(() => {}), settle(opts.wait ?? 400)]);
  await settle(20);

  return { chunks, html: chunks.map((c) => c.text).join(''), errors, handle };
};

describe('@taujs/react deferred adapter - native projection (renderer contract 1-3)', () => {
  it('suspends only the reading boundary: independent shell content precedes the value', async () => {
    let resolveReviews!: (v: Record<string, unknown>) => void;
    const reviews = new Promise<Record<string, unknown>>((r) => (resolveReviews = r));

    const Reviews = () => {
      const data = useDeferredData<{ count: number }>('reviews');
      return <p id="reviews">reviews: {data.count}</p>;
    };
    const App = () => (
      <main>
        <p id="unrelated">unrelated shell content</p>
        <Suspense fallback={<p id="pending">loading reviews</p>}>
          <Reviews />
        </Suspense>
      </main>
    );

    const driven = drive(App, { deferredData: deferredRegistry({ reviews }) });
    await settle(80);
    resolveReviews({ count: 3 });
    const { chunks, html } = await driven;

    // The FIRST chunk carries the independent content and the fallback, and NOT the value - the
    // shell was committed before the promise settled, which is the whole claim.
    expect(chunks[0]!.text).toContain('unrelated shell content');
    expect(chunks[0]!.text).toContain('loading reviews');
    expect(chunks[0]!.text).not.toContain('reviews: 3');
    expect(html).toContain('reviews: <!-- -->3');
  });

  it('delivers the late boundary through REACT’s own patch mechanism - τjs emits no bytes of its own', async () => {
    const Reviews = () => {
      const data = useDeferredData<{ count: number }>('reviews');
      return <p>reviews: {data.count}</p>;
    };
    // Settling AFTER the shell is what makes React patch rather than inline.
    const reviews = new Promise<Record<string, unknown>>((r) => setTimeout(() => r({ count: 3 }), 80));
    const { html } = await drive(
      () => (
        <main>
          <p id="unrelated">unrelated shell content</p>
          <Suspense fallback={<p>loading</p>}>
            <Reviews />
          </Suspense>
        </main>
      ),
      { deferredData: deferredRegistry({ reviews }) },
    );

    // React's own out-of-order patch: a placeholder inline, the value later in a hidden div that
    // React's own `$RC` splices into place.
    expect(html).toContain('<!--$?--><template id="B:0"></template>');
    expect(html).toContain('$RC("B:0","S:0")');
    expect(html).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(html).not.toContain('__INITIAL_DATA__');
    expect(html.toLowerCase()).not.toContain('taujs');
  });

  it('a route with NO registry renders byte-identical output (the provider is not inserted)', async () => {
    const Ided = () => <p>{React.useId()}</p>;
    const App = () => (
      <main>
        <Ided />
        <Suspense fallback={<p>loading</p>}>
          <p>content</p>
        </Suspense>
      </main>
    );

    const a = await drive(App);
    const b = await drive(App, { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }) });

    // A declared-but-UNCONSUMED registry must not shift a single `useId` or byte.
    expect(b.html).toBe(a.html);
  });
});

describe('@taujs/react deferred adapter - CSP (renderer contract 5)', () => {
  it('every inline patch script React emits for a deferred boundary carries the nonce', async () => {
    const Reviews = () => {
      const data = useDeferredData<{ count: number }>('reviews');
      return <p>reviews: {data.count}</p>;
    };
    const reviews = new Promise<Record<string, unknown>>((r) => setTimeout(() => r({ count: 3 }), 80));
    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on('data', (c) => chunks.push(c.toString()));
    const { renderStream } = createRenderer({
      appComponent: () => (
        <main>
          <p>shell</p>
          <Suspense fallback={<p>loading</p>}>
            <Reviews />
          </Suspense>
        </main>
      ),
      headContent: () => '',
    });
    const handle = renderStream(writable, { onHead: () => {} }, {}, '/x', undefined, {}, undefined, {
      deferredData: deferredRegistry({ reviews }),
      cspNonce: 'NONCE123',
    });
    await Promise.race([handle.done.catch(() => {}), settle(400)]);
    await settle(20);
    const html = chunks.join('');

    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain('nonce="NONCE123"');
  });
});

describe('@taujs/react deferred adapter - failure legs (renderer contract 6, 7)', () => {
  it('leg 1 - a consumed rejection completes the RESPONSE through the detail-free result accessor', async () => {
    const Reviews = () => {
      const result = useDeferredDataResult<{ count: number }>('reviews');
      return result.status === 'complete' ? <p>reviews: {result.value.count}</p> : <p id="fallback">{`reviews unavailable (${result.status})`}</p>;
    };
    const { html, errors } = await drive(
      () => (
        <Suspense fallback={<p>loading</p>}>
          <Reviews />
        </Suspense>
      ),
      { deferredData: deferredRegistry({ reviews: Promise.reject(new Error('REVIEWS_BACKEND_SECRET')) }) },
    );

    expect(html).toContain('reviews unavailable (failed)');
    expect(html).not.toContain('REVIEWS_BACKEND_SECRET');
    expect(errors).toEqual([]);
  });

  it('leg 1b - the throwing accessor follows React’s native model: the boundary is handed to the client, detail-free', async () => {
    const Reviews = () => {
      const data = useDeferredData<{ count: number }>('reviews');
      return <p>reviews: {data.count}</p>;
    };
    const { html } = await drive(
      () => (
        <Suspense fallback={<p>loading</p>}>
          <Reviews />
        </Suspense>
      ),
      { deferredData: deferredRegistry({ reviews: Promise.reject(new Error('REVIEWS_BACKEND_SECRET')) }) },
    );

    // React's own client-render marker. Either form is REACT's instruction, never τjs's.
    expect(html).toMatch(/\$RX|<!--\$!-->/);
    // DISCLOSED, not worked around: a DEVELOPMENT react-dom build streams the error's message and
    // stacks inside its own errored-boundary template for ANY SSR error. That is React's channel
    // and it is absent from production builds - asserted in both directions here. τjs's own
    // surfaces (envelope, trace) stay detail-free regardless, which the host tests pin.
    const isDevReact = html.includes('data-msg=');
    if (isDevReact) expect(html).toContain('REVIEWS_BACKEND_SECRET');
    else expect(html).not.toContain('REVIEWS_BACKEND_SECRET');
  });

  it('leg 2 - an UNCONSUMED rejection raises no unhandledRejection and does not reverse the document', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { html, errors } = await drive(() => <p>shell only</p>, {
        deferredData: deferredRegistry({ reviews: Promise.reject(new Error('nobody reads me')) }),
      });
      await settle(30);
      expect(html).toContain('shell only');
      expect(errors).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  it('leg 3 - a manual abort releases the holder: later reads report the released holder, never a fetch', async () => {
    let holderRead!: (key: string) => unknown;
    const Probe = () => {
      const useDeferred = createDeferredAccessor<{ reviews: { count: number } }>();
      holderRead = useDeferred as unknown as (key: string) => unknown;
      return <p>probe</p>;
    };
    const registry = deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) });
    const writable = new PassThrough();
    const { renderStream } = createRenderer({ appComponent: () => <Probe />, headContent: () => '' });
    const handle = renderStream(writable, { onHead: () => {} }, {}, '/x', undefined, {}, undefined, { deferredData: registry });
    await settle(30);
    handle.abort();
    await settle(20);

    expect(holderRead).toBeTypeOf('function');
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('an unknown key is a deterministic DEVELOPER error naming the declared set', async () => {
    const Bad = () => {
      useDeferredData('nope');
      return null;
    };
    const { errors } = await drive(() => <Bad />, { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 1 }) }) });

    expect(String((errors[0] as Error)?.message)).toContain('unknown deferred data key "nope"');
    expect(String((errors[0] as Error)?.message)).toContain('"reviews"');
  });

  it('reading outside a provider is a deterministic developer error', async () => {
    const Bad = () => {
      useDeferredData('reviews');
      return null;
    };
    const { errors } = await drive(() => <Bad />);

    expect(String((errors[0] as Error)?.message)).toContain('was called outside a deferred-data provider');
  });
});

describe('@taujs/react deferred deadline (decision 18)', () => {
  it('rejects a non positive-finite value at the factory - there is no disable sentinel', () => {
    for (const bad of [0, Infinity, -1, NaN, '5' as unknown as number]) {
      expect(() => createRenderer({ appComponent: () => <p />, headContent: () => '', streamOptions: { deferredTimeoutMs: bad } })).toThrow(
        /deferredTimeoutMs must be a positive finite number/,
      );
    }
  });

  it('DEFAULT CONFIGURATION: the SHIPPED deadlines arm at 15_000 and 30_000, in that order', async () => {
    // Deterministic (no 30-second run) and it OBSERVES THE MODULE rather than restating its
    // derivation: both post-shell deadlines are armed at the same site, so the delays handed to
    // `setTimeout` there ARE the shipped relationship. The cell fails the moment either default -
    // the 15_000 cap or the 30_000 backstop - moves in either direction.
    const spy = vi.spyOn(globalThis, 'setTimeout');

    await drive(
      () => (
        <Suspense fallback={<p>loading</p>}>
          <p>shell</p>
        </Suspense>
      ),
      { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }), initialData: pendingRouteData(), wait: 300 },
    );

    const armed = spy.mock.calls.map((call) => Number(call[1]));
    spy.mockRestore();

    // Armed at shell commit with what REMAINS of a 15_000 budget measured from renderStream entry.
    const deferred = armed.filter((ms) => ms > 14_000 && ms <= 15_000);
    expect(deferred).toHaveLength(1);
    // The fatal route-data backstop, armed at the same instant, is strictly LATER - so the graceful
    // terminal is structurally reachable.
    expect(armed).toContain(30_000);
    expect(deferred[0]!).toBeLessThan(30_000);

    // ...and the factory refuses any configuration that would invert it.
    expect(() => createRenderer({ appComponent: () => <p />, headContent: () => '', streamOptions: { deferredTimeoutMs: 30_000 } })).toThrow(
      /must be strictly less than streamOptions.dataTimeoutMs/,
    );
  });

  it('a per-call `deferredTimeoutMs` is IGNORED - the boot-validated deadline is the only one armed', async () => {
    // It is omitted from `StreamCallOptions` (a compile-time fact), so this pins the RUNTIME half:
    // an untyped consumer smuggling one through must not reach the timer.
    const spy = vi.spyOn(globalThis, 'setTimeout');

    await drive(
      () => (
        <Suspense fallback={<p>loading</p>}>
          <p>shell</p>
        </Suspense>
      ),
      { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }), callOptions: { deferredTimeoutMs: 50 }, wait: 300 },
    );

    const armed = spy.mock.calls.map((call) => Number(call[1]));
    spy.mockRestore();

    expect(armed.filter((ms) => ms > 14_000 && ms <= 15_000)).toHaveLength(1);
    expect(armed).not.toContain(50);
  });

  it('a per-call fatal backstop cannot INVERT the ordering: the deferred deadline is brought back below it', async () => {
    // The fatal backstop IS per-call overridable (pre-existing), and decision 18's ordering rule is
    // a property of the response, not only of the factory. With stock defaults (deferred 15_000,
    // fatal 30_000) a call narrowing the fatal to 900ms would otherwise let it pre-empt graceful
    // abandonment entirely; the deferred deadline is re-derived as fatal/2.
    const spy = vi.spyOn(globalThis, 'setTimeout');

    await drive(
      () => (
        <Suspense fallback={<p>loading</p>}>
          <p>shell</p>
        </Suspense>
      ),
      {
        deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }),
        callOptions: { dataTimeoutMs: 900 },
        initialData: pendingRouteData(),
        wait: 300,
      },
    );

    const armed = spy.mock.calls.map((call) => Number(call[1]));
    spy.mockRestore();

    expect(armed.filter((ms) => ms > 14_000 && ms <= 15_000)).toHaveLength(0);
    expect(armed).toContain(900);
    expect(armed.filter((ms) => ms > 300 && ms <= 450)).toHaveLength(1);
  });

  it('derives the default from a NON-default fatal backstop, so the graceful terminal stays reachable', async () => {
    // A renderer configured with a 4s fatal backstop must derive 2s, not 15s - observed at the
    // arming site rather than recomputed here.
    const spy = vi.spyOn(globalThis, 'setTimeout');

    await drive(
      () => (
        <Suspense fallback={<p>loading</p>}>
          <p>shell</p>
        </Suspense>
      ),
      {
        deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }),
        streamOptions: { dataTimeoutMs: 4_000 },
        initialData: pendingRouteData(),
        wait: 300,
      },
    );

    const armed = spy.mock.calls.map((call) => Number(call[1]));
    spy.mockRestore();

    expect(armed).toContain(4_000);
    expect(armed.filter((ms) => ms > 1_500 && ms <= 2_000)).toHaveLength(1);

    expect(() =>
      createRenderer({ appComponent: () => <p />, headContent: () => '', streamOptions: { dataTimeoutMs: 4_000, deferredTimeoutMs: 2_000 } }),
    ).not.toThrow();
    expect(() =>
      createRenderer({ appComponent: () => <p />, headContent: () => '', streamOptions: { dataTimeoutMs: 4_000, deferredTimeoutMs: 4_000 } }),
    ).toThrow();
  });

  it('leg 4 - on expiry the document terminates deterministically and later reads are born `aborted` (the LATCH)', async () => {
    const outcomes: string[] = [];
    const Reviews = () => {
      const result = useDeferredDataResult<{ count: number }>('reviews');
      outcomes.push(result.status);
      return <p id="reviews">reviews: {result.status}</p>;
    };
    const { html, handle } = await drive(
      () => (
        <Suspense fallback={<p id="pending">loading</p>}>
          <Reviews />
        </Suspense>
      ),
      { deferredData: deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) }), streamOptions: { deferredTimeoutMs: 60 }, wait: 500 },
    );

    // The response TERMINATES - React abandons the boundary through its own instruction - and the
    // host will classify the still-pending key `aborted` at its write site.
    await expect(handle.done).resolves.toBeUndefined();
    expect(html).toMatch(/\$RX|<!--\$!-->/);
    expect(outcomes).not.toContain('complete');
  });

  it('a read whose FIRST access arrives after expiry is born `aborted`, not a fresh unbounded wait', async () => {
    const { createDeferredHolder } = await import('../SSRDeferredData');
    const holder = createDeferredHolder(deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) }));

    expect(holder.expire()).toBe(0); // nothing consumed yet
    const late = holder.resource('reviews') as unknown as { status: string; reason?: unknown };
    expect(late.status).toBe('rejected');
    expect((late.reason as DeferredDataError).outcome).toBe('aborted');
  });

  it('expire() reports the pending CONSUMED entries and latches', async () => {
    const { createDeferredHolder } = await import('../SSRDeferredData');
    const holder = createDeferredHolder(deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}), stock: Promise.resolve({ n: 1 }) }));

    holder.resource('reviews');
    await settle(5);
    holder.resource('stock');
    await settle(5);

    expect(holder.expire()).toBe(1);
    holder.release();
    expect(() => holder.resource('reviews')).toThrow(/read after the response terminal/);
  });
});

describe('@taujs/react deferred adapter - hydration policy', () => {
  it('hydrate:false still streams the late boundary natively (the envelope is the host’s concern)', async () => {
    const Reviews = () => {
      const data = useDeferredData<{ count: number }>('reviews');
      return <p>reviews: {data.count}</p>;
    };
    const { html } = await drive(
      () => (
        <Suspense fallback={<p>loading</p>}>
          <Reviews />
        </Suspense>
      ),
      { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }), shouldHydrate: false },
    );

    expect(html).toContain('reviews: <!-- -->3');
  });
});

describe('@taujs/react deferred adapter - typed facade', () => {
  it('createDeferredAccessor derives the payload type from the route config', async () => {
    type Deferred = { reviews: { count: number }; stock: { available: boolean } };
    const useDeferred = createDeferredAccessor<Deferred>();
    const Reviews = () => {
      const reviews = useDeferred('reviews');
      const stock = useDeferred('stock');
      return (
        <p>
          {reviews.count}/{String(stock.available)}
        </p>
      );
    };
    const { html } = await drive(
      () => (
        <Suspense fallback={<p>loading</p>}>
          <Reviews />
        </Suspense>
      ),
      { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }), stock: Promise.resolve({ available: true }) }) },
    );

    expect(html).toContain('3');
    expect(html).toContain('true');
  });
});

describe('@taujs/react deferred adapter - retention', () => {
  it('releases the holder on a NORMAL terminal', async () => {
    const { createDeferredHolder } = await import('../SSRDeferredData');
    const registry = deferredRegistry({ reviews: Promise.resolve({ count: 1 }) });
    const holder = createDeferredHolder(registry);
    holder.resource('reviews');
    holder.release();

    expect(() => holder.resource('reviews')).toThrow(/holder has been released/);
    expect(vi.isMockFunction(holder.release)).toBe(false);
  });
});
