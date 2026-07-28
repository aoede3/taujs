// @vitest-environment node
// RFC 0007 (renderer contract item 8) - the RENDERER's own holder release, observed on the REAL
// `renderStream` path. The module is spied rather than replaced, so every implementation here is
// the production one: the spy exists only to obtain the very holder the renderer created, and the
// assertion is a LATER READ of that holder after the terminal. Nothing in this cell calls
// `release()` itself, so deleting the renderer's cleanup call fails it.
import { PassThrough } from 'node:stream';

import React, { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';

import { createRenderer } from '../SSRRender';
import * as DeferredData from '../SSRDeferredData';
import { useDeferredData } from '../SSRDeferredData';

vi.mock('../SSRDeferredData', { spy: true });

const settle = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));

describe('@taujs/react deferred adapter - renderer-owned release (renderer contract 8)', () => {
  it('the RENDERER releases the holder at a normal terminal: a later read reports the released holder', async () => {
    const reviews = Promise.resolve({ count: 3 });
    reviews.catch(() => {}); // the host pre-observes
    const registry = Object.freeze({ reviews });

    const Reviews = () => {
      const data = useDeferredData<{ count: number }>('reviews');
      return <p id="reviews">reviews: {data.count}</p>;
    };
    const App = () => (
      <main>
        <Suspense fallback={<p>loading</p>}>
          <Reviews />
        </Suspense>
      </main>
    );

    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on('data', (c) => chunks.push(String(c)));

    const { renderStream } = createRenderer({ appComponent: App, headContent: () => '<title>t</title>' });
    const handle = renderStream(writable, { onHead: () => {}, onAllReady: () => {} }, { critical: 1 }, '/product/42', undefined, {}, undefined, {
      deferredData: registry,
      shouldHydrate: true,
    });

    await expect(handle.done).resolves.toBeUndefined();
    await settle();

    // The holder the RENDERER created - not one this test constructed.
    const created = vi.mocked(DeferredData.createDeferredHolder).mock.results;
    expect(created).toHaveLength(1);
    const holder = created[0]!.value as DeferredData.DeferredHolder;

    expect(chunks.join('')).toContain('reviews: <!-- -->3');
    // The later read: released state is observable only because the renderer released it.
    expect(() => holder.resource('reviews')).toThrow(/holder has been released/);
  });
});
