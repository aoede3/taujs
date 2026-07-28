// @vitest-environment jsdom
// RFC 0007 (R4): hydration seeding from the private envelope - synchronous document-order read,
// carrier deleted after the read, absent carrier treated as normal, never a fetch.
import React, { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { hydrateApp } from '../SSRHydration';
import { createHydrationHolder, DeferredDataError, takeDeferredHydrationState, useDeferredData, useDeferredDataResult } from '../SSRDeferredData';

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
  it('renders the complete value with no loader, no fetch and no suspension', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    document.getElementById('root')!.innerHTML = '<main><p id="reviews">reviews: 3</p></main>';
    (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'] = { critical: 1 };
    (window as unknown as Record<string, unknown>)[CARRIER] = { reviews: { status: 'complete', value: { count: 3 } } };

    const Reviews = () => {
      const data = useDeferredData<{ count: number }>('reviews');
      return <p id="reviews">reviews: {data.count}</p>;
    };
    hydrateApp({
      appComponent: (
        <main>
          <Suspense fallback={<p>loading</p>}>
            <Reviews />
          </Suspense>
        </main>
      ),
    });
    await flush();

    expect(document.getElementById('reviews')!.textContent).toBe('reviews: 3');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(CARRIER in window).toBe(false);
  });

  it('a `failed` outcome hydrates the SAME detail-free branch the server rendered', async () => {
    document.getElementById('root')!.innerHTML = '<main><p id="fallback">reviews unavailable (failed)</p></main>';
    (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'] = {};
    (window as unknown as Record<string, unknown>)[CARRIER] = { reviews: { status: 'failed' } };

    const Reviews = () => {
      const result = useDeferredDataResult<{ count: number }>('reviews');
      return result.status === 'complete' ? <p id="reviews">{result.value.count}</p> : <p id="fallback">{`reviews unavailable (${result.status})`}</p>;
    };
    hydrateApp({
      appComponent: (
        <main>
          <Suspense fallback={<p>loading</p>}>
            <Reviews />
          </Suspense>
        </main>
      ),
    });
    await flush();

    expect(document.getElementById('fallback')!.textContent).toBe('reviews unavailable (failed)');
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
