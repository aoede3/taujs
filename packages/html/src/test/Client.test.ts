// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { onDataReady } from '../client';

const W = () => window as unknown as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
  delete W().__INITIAL_DATA__;
  delete W().__TAUJS_DEFERRED_STATE__;
});

describe('onDataReady', () => {
  it('runs the callback exactly once when the document is already loaded', () => {
    expect(document.readyState).not.toBe('loading');
    const callback = vi.fn();

    onDataReady(callback);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs once on DOMContentLoaded when the document is still loading, and not again on a second dispatch', () => {
    // jsdom defines `readyState` on the prototype, not as an own property of `document`, so
    // `Object.defineProperty(document, ...)` shadows it with an own property - restore by DELETING
    // that own property afterward (a save/restore of a nonexistent own descriptor would leave the
    // shadow in place for every later test in this file).
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });

    try {
      const callback = vi.fn();
      onDataReady(callback);
      expect(callback).not.toHaveBeenCalled();

      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(callback).toHaveBeenCalledTimes(1);

      document.dispatchEvent(new Event('DOMContentLoaded'));
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as unknown as Record<string, unknown>).readyState;
    }
  });

  it('reads window.__INITIAL_DATA__ and the deferred carrier, deletes ONLY the carrier, and leaves the data snapshot in place', () => {
    W().__INITIAL_DATA__ = { a: 1 };
    W().__TAUJS_DEFERRED_STATE__ = { reviews: { status: 'complete', value: { count: 1 } } };

    let seen: { data: unknown; deferred: unknown } | undefined;
    onDataReady((ready) => {
      seen = ready;
    });

    expect(seen).toEqual({ data: { a: 1 }, deferred: { reviews: { status: 'complete', value: { count: 1 } } } });
    expect('__TAUJS_DEFERRED_STATE__' in window).toBe(false);
    expect(W().__INITIAL_DATA__).toEqual({ a: 1 });
  });

  it('reports data and deferred as undefined when neither the snapshot nor the carrier is present', () => {
    let seen: { data: unknown; deferred: unknown } | undefined;

    onDataReady((ready) => {
      seen = ready;
    });

    expect(seen).toEqual({ data: undefined, deferred: undefined });
  });

  it('propagates a throw from the callback rather than swallowing it', () => {
    expect(() =>
      onDataReady(() => {
        throw new Error('application error');
      }),
    ).toThrow('application error');
  });

  it('throws the pinned message when document is undefined (a node-environment import site)', () => {
    vi.stubGlobal('document', undefined);

    expect(() => onDataReady(() => {})).toThrow('onDataReady: no document; this function runs in the browser only');
  });
});
