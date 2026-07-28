// @vitest-environment jsdom
// RFC 0007 (R4): hydration seeding from the private envelope - read at the SAME rendezvous
// `window.__INITIAL_DATA__` is read at, carrier deleted after the read, absent carrier normal.
import { createSSRApp, defineComponent, h, Suspense } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { hydrateApp } from '../SSRHydration';
import {
  createDeferredHolder,
  createHydrationHolder,
  DeferredDataError,
  provideDeferredHolder,
  takeDeferredHydrationState,
  useDeferredDataResult,
} from '../SSRDeferredData';

const CARRIER = '__TAUJS_DEFERRED_STATE__';

const flush = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));

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

  it('an ABSENT or hostile carrier is the ordinary case, never an error', () => {
    expect(takeDeferredHydrationState()).toBeUndefined();
    for (const hostile of [null, 42, 'nope', [1, 2]]) {
      (window as unknown as Record<string, unknown>)[CARRIER] = hostile;
      expect(takeDeferredHydrationState()).toBeUndefined();
    }
  });
});

describe('the client holder seeds from the envelope with NO refetch', () => {
  it('every entry is already settled and detail-free', async () => {
    const holder = createHydrationHolder({
      reviews: { status: 'complete', value: { count: 3 } },
      blurb: { status: 'failed' },
      stock: { status: 'aborted' },
    });

    await expect(holder.result('reviews')).resolves.toEqual({ status: 'complete', value: { count: 3 } });
    await expect(holder.result('blurb')).resolves.toEqual({ status: 'failed' });
    await expect(holder.result('stock')).resolves.toEqual({ status: 'aborted' });

    const err = await holder.resource('blurb').catch((e) => e as DeferredDataError);
    expect(err).toBeInstanceOf(DeferredDataError);
    expect(err.outcome).toBe('failed');
  });

  it('an unknown key is a deterministic developer error naming the declared set', () => {
    const holder = createHydrationHolder({ reviews: { status: 'complete', value: {} } });

    expect(() => holder.result('nope')).toThrow(/unknown deferred data key "nope"/);
  });
});

describe('hydrateApp seeds consumed boundaries from the envelope', () => {
  const Reviews = defineComponent({
    name: 'Reviews',
    async setup() {
      const result = await useDeferredDataResult<{ count: number }>('reviews');
      return () =>
        result.status === 'complete'
          ? h('p', { id: 'reviews' }, `reviews: ${result.value.count}`)
          : h('p', { id: 'fallback' }, `reviews unavailable (${result.status})`);
    },
  });
  // The authoring shape a Vue application uses for an async `setup()`: on the client an async
  // setup needs a `<Suspense>` boundary, and Vue SSR renders that boundary's DEFAULT slot - so the
  // server and client trees are the same tree.
  const Page = defineComponent({ name: 'Page', setup: () => () => h('main', [h(Suspense, null, { default: () => h(Reviews) })]) });

  /** Render the SAME tree through @vue/server-renderer, so hydration runs against real SSR markup. */
  const serverHtml = async (outcome: Record<string, unknown>) => {
    const app = createSSRApp({ name: 'TauJsHydration', render: () => h(Page) });
    provideDeferredHolder(app, createDeferredHolder(Object.freeze({ reviews: outcome['reviews'] as Promise<Record<string, unknown>> })));

    return renderToString(app);
  };

  it('renders the complete value with no loader and no fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    document.getElementById('root')!.innerHTML = await serverHtml({ reviews: Promise.resolve({ count: 3 }) });
    (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'] = { critical: 1 };
    (window as unknown as Record<string, unknown>)[CARRIER] = { reviews: { status: 'complete', value: { count: 3 } } };

    hydrateApp({ appComponent: Page });
    await flush();

    expect(document.getElementById('reviews')!.textContent).toBe('reviews: 3');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(CARRIER in window).toBe(false);
  });

  it('an `aborted` outcome hydrates the SAME detail-free branch the server rendered', async () => {
    const abandoned = createDeferredHolder(Object.freeze({ reviews: new Promise<Record<string, unknown>>(() => {}) }));
    abandoned.expire();
    const app = createSSRApp({ name: 'TauJsHydration', render: () => h(Page) });
    provideDeferredHolder(app, abandoned);
    document.getElementById('root')!.innerHTML = await renderToString(app);
    expect(document.getElementById('root')!.innerHTML).toContain('reviews unavailable (aborted)');
    (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'] = {};
    (window as unknown as Record<string, unknown>)[CARRIER] = { reviews: { status: 'aborted' } };

    const onHydrationError = vi.fn();
    hydrateApp({ appComponent: Page, onHydrationError });
    await flush();

    expect(document.getElementById('fallback')!.textContent).toBe('reviews unavailable (aborted)');
    expect(onHydrationError).not.toHaveBeenCalled();
  });

  it('a page with NO carrier hydrates exactly as it does today', async () => {
    document.getElementById('root')!.innerHTML = '<main><p id="plain">plain</p></main>';
    (window as unknown as Record<string, unknown>)['__INITIAL_DATA__'] = {};

    const Plain = defineComponent({ name: 'Plain', setup: () => () => h('main', [h('p', { id: 'plain' }, 'plain')]) });
    const onHydrationError = vi.fn();
    hydrateApp({ appComponent: Plain, onHydrationError });
    await flush();

    expect(document.getElementById('plain')!.textContent).toBe('plain');
    expect(onHydrationError).not.toHaveBeenCalled();
  });
});
