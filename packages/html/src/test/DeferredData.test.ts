import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRenderer } from '../SSRRender';

afterEach(() => {
  vi.useRealTimers();
});

describe('deferred data delivery (data delivery only, section 4.4)', () => {
  it('waits for every declared entry to settle before ending the stream', async () => {
    let resolveEntry!: (v: Record<string, unknown>) => void;
    const entry = new Promise<Record<string, unknown>>((resolve) => (resolveEntry = resolve));
    const onAllReady = vi.fn();
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}) });

    const { done } = renderStream(pt, { onAllReady }, {}, '/loc', undefined, {}, undefined, {
      shouldHydrate: true,
      deferredData: { reviews: entry },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onAllReady).not.toHaveBeenCalled();

    resolveEntry({ count: 1 });
    await done;

    expect(onAllReady).toHaveBeenCalledTimes(1);
  });

  it('a rejected declared entry still ends the stream normally (its settlement is a rejection, not a stream failure)', async () => {
    const onAllReady = vi.fn();
    const onError = vi.fn();
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}) });

    const { done } = renderStream(pt, { onAllReady, onError }, {}, '/loc', undefined, {}, undefined, {
      shouldHydrate: true,
      deferredData: { reviews: Promise.reject(new Error('loader failed')) },
    });

    await expect(done).resolves.toBeUndefined();
    expect(onAllReady).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('ends normally with the pinned warn text when the deadline expires, reporting the pending count', async () => {
    const warn = vi.fn();
    const never = new Promise<Record<string, unknown>>(() => {});
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}), logger: { warn }, streamOptions: { deferredTimeoutMs: 20 } });

    const { done } = renderStream(pt, {}, {}, '/somewhere', undefined, {}, undefined, {
      shouldHydrate: true,
      deferredData: { reviews: never },
    });

    await done;

    expect(warn).toHaveBeenCalledWith('Deferred deadline (20ms) expired with 1 entry pending for /somewhere');
  });

  it('pluralises "entries" when more than one entry is still pending at the deadline', async () => {
    const warn = vi.fn();
    const never = new Promise<Record<string, unknown>>(() => {});
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}), logger: { warn }, streamOptions: { deferredTimeoutMs: 20 } });

    const { done } = renderStream(pt, {}, {}, '/many', undefined, {}, undefined, {
      shouldHydrate: true,
      deferredData: { a: never, b: never },
    });

    await done;

    expect(warn).toHaveBeenCalledWith('Deferred deadline (20ms) expired with 2 entries pending for /many');
  });

  it('arms the deferred deadline AFTER onHead, with the remaining budget - not a fresh window', async () => {
    vi.useFakeTimers();

    const warn = vi.fn();
    const never = new Promise<Record<string, unknown>>(() => {});
    const pt = new PassThrough();
    pt.resume();
    // No `render` callback: onHead fires as soon as the critical data resolves, so a 200ms critical
    // data delay stands in for "onHead at t=200" from the contract's own worked example.
    const dataThunk = () => new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({}), 200));
    const { renderStream } = createRenderer({ logger: { warn }, streamOptions: { deferredTimeoutMs: 1000 } });

    const { done } = renderStream(pt, {}, dataThunk, '/loc', undefined, {}, undefined, {
      shouldHydrate: true,
      deferredData: { reviews: never },
    });

    await vi.advanceTimersByTimeAsync(200); // data resolves; onHead runs; the deadline arms with 800ms remaining
    await vi.advanceTimersByTimeAsync(799); // t=999: not yet expired
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // t=1000: the ORIGINAL 1000ms deadline, not a fresh 1000ms from t=200
    await done;

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not arm or wait when shouldHydrate is false, even with deferredData present', async () => {
    const log = vi.fn();
    const never = new Promise<Record<string, unknown>>(() => {});
    const onAllReady = vi.fn();
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}), logger: { log } as never, enableDebug: true });

    const { done } = renderStream(pt, { onAllReady }, {}, '/loc', undefined, {}, undefined, {
      shouldHydrate: false,
      deferredData: { reviews: never },
    });

    await done;

    expect(onAllReady).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('deferred data present but hydrate is false; not waiting');
  });

  it('arms no deferred timer when the route declares no deferred entries', async () => {
    vi.useFakeTimers();
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}) });

    const { done } = renderStream(pt, {}, {}, '/loc');
    await done;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms no deferred timer when deferredData is an empty object', async () => {
    vi.useFakeTimers();
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}) });

    const { done } = renderStream(pt, {}, {}, '/loc', undefined, {}, undefined, { shouldHydrate: true, deferredData: {} });
    await done;

    expect(vi.getTimerCount()).toBe(0);
  });
});
