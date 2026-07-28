// @vitest-environment jsdom
// RFC 0007 (R4): hydration seeding from the private envelope - synchronous document-order read,
// carrier deleted after the read, absent carrier treated as normal, never a fetch.
import React, { Suspense } from 'react';
import { renderToReadableStream } from 'react-dom/server.browser';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { hydrateApp } from '../SSRHydration';
import {
  createDeferredHolder,
  createHydrationHolder,
  DeferredDataError,
  DeferredDataProvider,
  takeDeferredHydrationState,
  useDeferredData,
  useDeferredDataResult,
} from '../SSRDeferredData';

const CARRIER = '__TAUJS_DEFERRED_STATE__';

const flush = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  delete (window as unknown as Record<string, unknown>)[CARRIER];
  delete (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('takeDeferredHydrationState', () => {
  it('reads the carrier ONCE and deletes it', () => {
    (window as unknown as Record<string, unknown>)[CARRIER] = { reviews: { status: 'complete', value: { count: 3 } } };

    expect(takeDeferredHydrationState()).toEqual({ reviews: { status: 'complete', value: { count: 3 } } });
    expect(CARRIER in window).toBe(false);
    expect(takeDeferredHydrationState()).toBeUndefined();
  });

  it('an ABSENT carrier is the ordinary case, never an error', () => {
    expect(takeDeferredHydrationState()).toBeUndefined();
  });

  it('a hostile carrier value is ignored rather than thrown', () => {
    for (const hostile of [null, 42, 'nope', [1, 2]]) {
      (window as unknown as Record<string, unknown>)[CARRIER] = hostile;
      expect(takeDeferredHydrationState()).toBeUndefined();
    }
  });
});

describe('the client holder seeds from the envelope with NO refetch', () => {
  it('every entry is ALREADY SETTLED, so a read is synchronous', () => {
    const holder = createHydrationHolder({
      reviews: { status: 'complete', value: { count: 3 } },
      blurb: { status: 'failed' },
      stock: { status: 'aborted' },
    });

    const complete = holder.resource('reviews') as unknown as { status: string; value?: unknown };
    expect(complete.status).toBe('fulfilled');
    expect(complete.value).toEqual({ count: 3 });

    for (const [key, outcome] of [
      ['blurb', 'failed'],
      ['stock', 'aborted'],
    ] as const) {
      const entry = holder.resource(key) as unknown as { status: string; reason?: unknown };
      expect(entry.status).toBe('rejected');
      expect((entry.reason as DeferredDataError).outcome).toBe(outcome);
      expect(String((entry.reason as Error).message)).not.toMatch(/stack|cause|server/i);
    }
  });

  it('an unknown key is a deterministic developer error naming the declared set', () => {
    const holder = createHydrationHolder({ reviews: { status: 'complete', value: {} } });

    expect(() => holder.resource('nope')).toThrow(/unknown deferred data key "nope"/);
  });
});

describe('hydrateApp seeds consumed boundaries from the envelope', () => {
  // ONE component per read, rendered by BOTH sides - the server tree and the hydrating tree are the
  // same tree, exactly as an application's are.
  const Reviews = () => {
    const data = useDeferredData<{ count: number }>('reviews');

    return <p id="reviews">reviews: {data.count}</p>;
  };

  const ReviewsResult = () => {
    const result = useDeferredDataResult<{ count: number }>('reviews');

    return result.status === 'complete' ? <p id="reviews">{result.value.count}</p> : <p id="fallback">{`reviews unavailable (${result.status})`}</p>;
  };

  /**
   * Render the SAME tree through `react-dom/server`, so hydration runs against REAL SSR markup -
   * `<!--$-->`/`<!--/$-->` Suspense markers included. Hand-authored markup has no markers, so React
   * silently regenerates the boundary on the client and every assertion below would pass whether or
   * not the adapter hydrates cleanly.
   *
   * Each entry is WARMED before the render (`resource()` tracks it, one macrotask settles it), so
   * `use()` returns synchronously and the server emits the SETTLED document. React's late-boundary
   * delivery is a stream of `<script>` instructions a browser executes; `innerHTML` never runs
   * them, so the settled document is the DOM a real browser holds when hydration starts.
   */
  const serverHtml = async (tree: React.ReactElement, registry: Record<string, Promise<Record<string, unknown>>>) => {
    const holder = createDeferredHolder(Object.freeze(registry));
    for (const key of holder.keys) void holder.resource(key);
    await flush(0);

    const stream = await renderToReadableStream(<DeferredDataProvider holder={holder}>{tree}</DeferredDataProvider>);

    return new Response(stream as unknown as ReadableStream).text();
  };

  /**
   * Rendering with react-dom/server AND react-dom/client in ONE process makes React's dev build warn
   * that two renderers touched the same context provider. It is an artefact of the test topology -
   * the server render is finished before hydration starts - and it is the price of honest markup, so
   * it is filtered by exact message only. Every other console error still reaches the log.
   */
  beforeEach(() => {
    const real = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('Detected multiple renderers concurrently rendering the same context provider')) return;
      real(...args);
    });
  });

  /** React reports an auto-recovered mismatch through `onRecoverableError`, which hydrateApp warns. */
  const hydrationWarnings = (warn: ReturnType<typeof vi.fn>) => warn.mock.calls.filter(([first]) => String(first).includes('Recoverable hydration error'));

  const CompleteTree = (
    <main>
      <Suspense fallback={<p>loading</p>}>
        <Reviews />
      </Suspense>
    </main>
  );

  const ResultTree = (
    <main>
      <Suspense fallback={<p>loading</p>}>
        <ReviewsResult />
      </Suspense>
    </main>
  );

  it('renders the complete value with no loader, no fetch, no suspension and NO mismatch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    document.getElementById('root')!.innerHTML = await serverHtml(CompleteTree, { reviews: Promise.resolve({ count: 3 }) });
    // The marker proves the fixture is real SSR markup, not a hand-authored approximation.
    expect(document.getElementById('root')!.innerHTML).toContain('<!--$-->');
    (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'] = { critical: 1 };
    (window as unknown as Record<string, unknown>)[CARRIER] = { reviews: { status: 'complete', value: { count: 3 } } };

    const warn = vi.fn();
    const onHydrationError = vi.fn();
    hydrateApp({ appComponent: CompleteTree, logger: { log: vi.fn(), warn, error: vi.fn() }, onHydrationError });
    await flush();

    expect(document.getElementById('reviews')!.textContent).toBe('reviews: 3');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(CARRIER in window).toBe(false);
    expect(onHydrationError).not.toHaveBeenCalled();
    expect(hydrationWarnings(warn)).toEqual([]);
  });

  it('a `failed` outcome hydrates the SAME detail-free branch the server rendered, with NO mismatch', async () => {
    const rejected = Promise.reject(new Error('loader blew up'));
    rejected.catch(() => {});
    document.getElementById('root')!.innerHTML = await serverHtml(ResultTree, { reviews: rejected as Promise<Record<string, unknown>> });
    expect(document.getElementById('root')!.innerHTML).toContain('reviews unavailable (failed)');
    (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'] = {};
    (window as unknown as Record<string, unknown>)[CARRIER] = { reviews: { status: 'failed' } };

    const warn = vi.fn();
    const onHydrationError = vi.fn();
    hydrateApp({ appComponent: ResultTree, logger: { log: vi.fn(), warn, error: vi.fn() }, onHydrationError });
    await flush();

    expect(document.getElementById('fallback')!.textContent).toBe('reviews unavailable (failed)');
    expect(onHydrationError).not.toHaveBeenCalled();
    expect(hydrationWarnings(warn)).toEqual([]);
  });

  it('a page with NO carrier hydrates exactly as it does today', async () => {
    document.getElementById('root')!.innerHTML = '<main><p id="plain">plain</p></main>';
    (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'] = {};

    const onHydrationError = vi.fn();
    hydrateApp({
      appComponent: (
        <main>
          <p id="plain">plain</p>
        </main>
      ),
      onHydrationError,
    });
    await flush();

    expect(document.getElementById('plain')!.textContent).toBe('plain');
    expect(onHydrationError).not.toHaveBeenCalled();
  });
});
