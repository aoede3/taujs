// @vitest-environment node
// RFC 0007 - @taujs/solid adapter: renderer contract items 1-9 against a REAL Solid stream render
// and a REAL PassThrough.
import { PassThrough } from 'node:stream';

import { createComponent, ErrorBoundary, Suspense } from 'solid-js';
import { renderToStringAsync, ssr } from 'solid-js/web';
import { describe, it, expect } from 'vitest';

import { createRenderer } from '../SSRRender.js';
import {
  createDeferredAccessor,
  createDeferredHolder,
  createHydrationHolder,
  DeferredDataError,
  takeDeferredHydrationState,
  useDeferredData,
} from '../SSRDeferredData.js';

import type { JSX } from 'solid-js';

const html = (markup: string): JSX.Element => ssr(markup) as never;

const settle = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

type Registry = Record<string, Promise<Record<string, unknown>>>;

const deferredRegistry = (entries: Record<string, Promise<Record<string, unknown>>>): Registry => {
  for (const promise of Object.values(entries)) promise.catch(() => {}); // the host pre-observes
  return Object.freeze({ ...entries });
};

/** Shell content, then a Suspense boundary reading `reviews`, then tail content. */
const page = (): JSX.Element =>
  [
    html('<div id="shell">shell</div>'),
    createComponent(Suspense, {
      fallback: html('<p id="pending">loading reviews</p>'),
      get children() {
        const inner = () => {
          const reviews = useDeferredData<{ count: number }>('reviews');
          return html(`<p id="reviews">reviews: ${String(reviews()?.count ?? '')}</p>`);
        };

        // PLACEMENT MATTERS (documented on `useDeferredData`): the ErrorBoundary sits INSIDE the
        // Suspense, which is what makes the fallback reach the RESPONSE rather than the client.
        return createComponent(ErrorBoundary, {
          fallback: () => html('<p id="reviews-error">reviews unavailable</p>'),
          get children() {
            return inner();
          },
        });
      },
    }),
    html('<p id="tail">tail content, after the boundary</p>'),
  ] as never;

const drive = async (appComponent: () => JSX.Element, opts: { deferredData?: Registry; streamOptions?: Record<string, number>; wait?: number } = {}) => {
  const sink = new PassThrough();
  const chunks: { at: number; text: string }[] = [];
  const t0 = Date.now();
  sink.on('data', (c: Buffer) => chunks.push({ at: Date.now() - t0, text: String(c) }));
  sink.on('error', () => {});

  const { renderStream } = createRenderer({ appComponent, headContent: () => '<title>t</title>', streamOptions: opts.streamOptions });
  const errors: unknown[] = [];
  const handle = renderStream(
    sink,
    { onHead: () => {}, onAllReady: () => {}, onError: (e) => errors.push(e) },
    { critical: 1 },
    '/product/42',
    undefined,
    {},
    undefined,
    { ...(opts.deferredData ? { deferredData: opts.deferredData } : {}), shouldHydrate: true },
  );

  await Promise.race([handle.done.catch(() => {}), settle(opts.wait ?? 600)]);
  await settle(20);

  return { chunks, html: chunks.map((c) => c.text).join(''), errors, handle };
};

describe('@taujs/solid deferred adapter - native projection (renderer contract 1-3)', () => {
  it('OUT-OF-ORDER class: shell and tail precede the value, which Solid patches in itself', async () => {
    let resolveReviews!: (v: Record<string, unknown>) => void;
    const reviews = new Promise<Record<string, unknown>>((r) => (resolveReviews = r));

    const driven = drive(page, { deferredData: deferredRegistry({ reviews }) });
    await settle(120);
    resolveReviews({ count: 3 });
    const { chunks, html: out } = await driven;

    expect(chunks[0]!.text).toContain('shell');
    expect(chunks[0]!.text).toContain('loading reviews');
    expect(chunks[0]!.text).toContain('tail content, after the boundary');
    expect(chunks[0]!.text).not.toContain('reviews: 3');
    expect(out).toContain('reviews: 3');
    // Solid's OWN patch mechanism delivers the fragment - τjs writes none of those bytes.
    expect(out).toContain('$df');
    expect(out).not.toContain('__TAUJS_DEFERRED_STATE__');
    expect(out).not.toContain('__INITIAL_DATA__');
  });

  it('a route with NO registry renders byte-identical output (no provider, no context id)', async () => {
    const plain = (): JSX.Element =>
      [
        html('<div id="shell">shell</div>'),
        createComponent(Suspense, {
          fallback: html('<p>f</p>'),
          get children() {
            return html('<p id="content">content</p>');
          },
        }),
      ] as never;

    const a = await drive(plain);
    const b = await drive(plain, { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }) });

    // A declared-but-UNCONSUMED registry must not shift a single hydration id or byte.
    expect(b.html).toBe(a.html);
  });
});

describe('@taujs/solid deferred adapter - failure legs (renderer contract 6, 7)', () => {
  it('leg 1 - a consumed rejection reaches Solid’s SERVER-SIDE ErrorBoundary and the fallback completes the response', async () => {
    const { html: out, handle } = await drive(page, {
      deferredData: deferredRegistry({ reviews: Promise.reject(new Error('REVIEWS_BACKEND_SECRET')) }),
    });

    await expect(handle.done).resolves.toBeUndefined();
    expect(out).toContain('reviews unavailable'); // the app's own fallback, IN the response
    expect(out).not.toContain('REVIEWS_BACKEND_SECRET'); // the package's non-disableable sanitiser
  });

  it('leg 2 - an UNCONSUMED rejection raises no unhandledRejection and does not reverse the document', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const shellOnly = (): JSX.Element => html('<div id="shell">shell only</div>');
      const { html: out, errors } = await drive(shellOnly, { deferredData: deferredRegistry({ reviews: Promise.reject(new Error('nobody reads me')) }) });
      await settle(30);
      expect(out).toContain('shell only');
      expect(errors).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  it('an unknown key is a deterministic DEVELOPER error naming the declared set', () => {
    const holder = createDeferredHolder(deferredRegistry({ reviews: Promise.resolve({ count: 1 }) }));

    expect(() => holder.read('nope')).toThrow(/unknown deferred data key "nope"/);
    expect(() => holder.read('nope')).toThrow(/"reviews"/);
  });

  it('reading without a registry is a deterministic developer error', async () => {
    const orphan = (): JSX.Element => {
      useDeferredData('reviews');
      return html('<p/>');
    };
    const { errors } = await drive(orphan);

    expect(String((errors[0] as Error)?.message)).toContain('requires a route declaring `attr.deferred`');
  });
});

describe('@taujs/solid deferred deadline (decision 18)', () => {
  it('rejects a non positive-finite value at the factory - there is no disable sentinel', () => {
    for (const bad of [0, Infinity, -1, NaN, '5' as unknown as number]) {
      expect(() => createRenderer({ appComponent: page, headContent: () => '', streamOptions: { deferredTimeoutMs: bad } })).toThrow(
        /deferredTimeoutMs must be a positive finite number/,
      );
    }
  });

  it('DEFAULT CONFIGURATION: the derived deadline is 15_000 and strictly precedes the fatal backstop', () => {
    const DEFAULT_COMPLETION = 30_000;
    const derived = Math.min(15_000, DEFAULT_COMPLETION / 2);

    expect(derived).toBe(15_000);
    expect(derived).toBeLessThan(DEFAULT_COMPLETION);
    expect(() => createRenderer({ appComponent: page, headContent: () => '', streamOptions: { deferredTimeoutMs: 30_000 } })).toThrow(
      /must be strictly less than streamOptions.completionTimeoutMs/,
    );
  });

  it('derives from a NON-default fatal backstop, so the graceful terminal stays reachable', () => {
    expect(Math.min(15_000, 5_000 / 2)).toBe(2_500);
    expect(() => createRenderer({ appComponent: page, headContent: () => '', streamOptions: { completionTimeoutMs: 5_000 } })).not.toThrow();
    expect(() =>
      createRenderer({ appComponent: page, headContent: () => '', streamOptions: { completionTimeoutMs: 5_000, deferredTimeoutMs: 5_000 } }),
    ).toThrow();
  });

  it('leg 4 - on expiry the boundary errors NATIVELY, the app fallback reaches the response and the document terminates', async () => {
    const { html: out, handle } = await drive(page, {
      deferredData: deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) }),
      streamOptions: { deferredTimeoutMs: 80, completionTimeoutMs: 5_000 },
      wait: 2_000,
    });

    await expect(handle.done).resolves.toBeUndefined();
    expect(out).toContain('reviews unavailable');
  });

  it('the deadline LATCHES: a read whose FIRST access arrives after expiry is born `aborted`', async () => {
    // The hole the latch closes: a boundary whose first read arrives after the deadline (an
    // app-owned resource gated it) must NOT start a fresh unbounded wait - it is born abandoned and
    // reported, so the document τjs is still holding open stays bounded.
    const abandoned: string[][] = [];
    const holder = createDeferredHolder(deferredRegistry({ reviews: new Promise<Record<string, unknown>>(() => {}) }), (keys) => abandoned.push([...keys]));

    expect(holder.expire()).toBe(0); // nothing consumed yet - the latch is set all the same

    // Read inside a REAL render: `createResource` requires a render context, which is the only
    // context an application ever reads from.
    const out = await renderToStringAsync(() =>
      createComponent(Suspense, {
        fallback: html('<p id="reviews-pending">loading</p>'),
        get children() {
          return createComponent(ErrorBoundary, {
            fallback: () => html('<p id="reviews-error">reviews unavailable</p>'),
            get children() {
              const reviews = holder.read<{ count: number }>('reviews');

              return html(`<p id="reviews">reviews: ${String(reviews()?.count ?? '')}</p>`);
            },
          });
        },
      }),
    );

    expect(abandoned).toEqual([['reviews']]);
    expect(out).toContain('reviews unavailable');
  });

  it('the deadline is ONE per response, never per key: two pending boundaries are abandoned together', async () => {
    const twoKeys = (): JSX.Element =>
      [
        html('<div id="shell">shell</div>'),
        ...(['reviews', 'stock'] as const).map((key) =>
          createComponent(Suspense, {
            fallback: html(`<p id="${key}-pending">loading</p>`),
            get children() {
              return createComponent(ErrorBoundary, {
                fallback: () => html(`<p id="${key}-error">${key} unavailable</p>`),
                get children() {
                  const value = useDeferredData<{ count: number }>(key);

                  return html(`<p id="${key}">${key}: ${String(value()?.count ?? '')}</p>`);
                },
              });
            },
          }),
        ),
      ] as never;

    const { html: out, handle } = await drive(twoKeys, {
      deferredData: deferredRegistry({
        reviews: new Promise<Record<string, unknown>>(() => {}),
        stock: new Promise<Record<string, unknown>>(() => {}),
      }),
      streamOptions: { deferredTimeoutMs: 80, completionTimeoutMs: 5_000 },
      wait: 3_000,
    });

    await expect(handle.done).resolves.toBeUndefined();
    expect(out).toContain('reviews unavailable');
    expect(out).toContain('stock unavailable');
  });
});

describe('@taujs/solid deferred adapter - retention (renderer contract 8)', () => {
  it('release drops every reference and refuses later reads', () => {
    const holder = createDeferredHolder(deferredRegistry({ reviews: Promise.resolve({ count: 1 }) }));

    holder.release();

    // A read after the terminal is a deterministic developer error, not a silent fresh wait.
    expect(() => holder.read('reviews')).toThrow(/read after the response terminal/);
    expect(holder.expire()).toBe(0);
  });
});

describe('@taujs/solid deferred adapter - hydration (R4)', () => {
  it('takeDeferredHydrationState reads the carrier once and deletes it; absent is normal', () => {
    const w = globalThis as unknown as { window?: unknown };
    const original = w.window;
    w.window = { __TAUJS_DEFERRED_STATE__: { reviews: { status: 'complete', value: { count: 3 } } } };
    try {
      expect(takeDeferredHydrationState()).toEqual({ reviews: { status: 'complete', value: { count: 3 } } });
      expect(takeDeferredHydrationState()).toBeUndefined();
    } finally {
      w.window = original;
    }
  });

  it('the client holder seeds from the envelope and never fetches', () => {
    const holder = createHydrationHolder({ reviews: { status: 'complete', value: { count: 3 } }, stock: { status: 'aborted' } });

    // `aborted` must NOT reach Solid's slot - the server terminated with that promise pending, so
    // the read throws deterministically into the app's ErrorBoundary instead of hanging forever.
    // (The `complete` path goes through Solid's own resource machinery and is proved end to end by
    // the playground-solid browser suite, which runs it inside a real hydration context.)
    expect(() => (holder.read('stock') as () => unknown)()).toThrow(DeferredDataError);
    expect(() => holder.read('nope')).toThrow(/unknown deferred data key/);
    expect(holder.keys).toEqual(['reviews', 'stock']);
  });
});

describe('@taujs/solid deferred adapter - typed facade', () => {
  it('createDeferredAccessor derives the payload type from the route config', async () => {
    type Deferred = { reviews: { count: number } };
    const useDeferred = createDeferredAccessor<Deferred>();
    const typed = (): JSX.Element =>
      [
        html('<div id="shell">shell</div>'),
        createComponent(Suspense, {
          fallback: html('<p>f</p>'),
          get children() {
            const reviews = useDeferred('reviews');
            return html(`<p id="typed">count: ${String(reviews()?.count ?? '')}</p>`);
          },
        }),
      ] as never;

    const { html: out } = await drive(typed, { deferredData: deferredRegistry({ reviews: Promise.resolve({ count: 3 }) }) });

    expect(out).toContain('count: 3');
  });
});
