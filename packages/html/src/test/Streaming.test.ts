import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createRenderer } from '../SSRRender';

const collectText = (pt: PassThrough): (() => string) => {
  const chunks: string[] = [];
  pt.on('data', (c: Buffer) => chunks.push(c.toString()));
  return () => chunks.join('');
};

describe('renderStream callback order and writes', () => {
  it('calls onHead, onShellReady, onAllReady, then finishes the sink, in that exact order', async () => {
    const order: string[] = [];
    const pt = new PassThrough();
    pt.resume();
    pt.on('finish', () => order.push('finish'));

    const { renderStream } = createRenderer({ render: () => ({ headContent: 'H', appHtml: 'A' }) });
    const { done } = renderStream(
      pt,
      {
        onHead: () => order.push('onHead'),
        onShellReady: () => order.push('onShellReady'),
        onAllReady: () => order.push('onAllReady'),
      },
      {},
      '/loc',
    );

    await done;

    expect(order).toEqual(['onHead', 'onShellReady', 'onAllReady', 'finish']);
  });

  it('writes appHtml bytes to the sink', async () => {
    const pt = new PassThrough();
    const text = collectText(pt);
    const { renderStream } = createRenderer({ render: () => ({ appHtml: '<p>hello</p>' }) });

    const { done } = renderStream(pt, {}, {}, '/loc');
    await done;

    expect(text()).toBe('<p>hello</p>');
  });

  it('writes nothing for an empty appHtml', async () => {
    const pt = new PassThrough();
    const text = collectText(pt);
    const { renderStream } = createRenderer({ render: () => ({ appHtml: '' }) });

    const { done } = renderStream(pt, {}, {}, '/loc');
    await done;

    expect(text()).toBe('');
  });

  it.each([
    ['a plain object', { a: 1 }],
    ['a promise', Promise.resolve({ a: 1 })],
    ['a function returning a promise', () => Promise.resolve({ a: 1 })],
  ] as const)('resolves critical data supplied as %s', async (_label, initialData) => {
    let seenData: unknown;
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({
      render: (ctx) => {
        seenData = ctx.data;
        return {};
      },
    });

    const { done } = renderStream(pt, {}, initialData as never, '/loc');
    await done;

    expect(seenData).toEqual({ a: 1 });
  });

  it('delivers the resolved critical data to onAllReady', async () => {
    const onAllReady = vi.fn();
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}) });

    const { done } = renderStream(pt, { onAllReady }, { a: 1 }, '/loc');
    await done;

    expect(onAllReady).toHaveBeenCalledTimes(1);
    expect(onAllReady).toHaveBeenCalledWith({ a: 1 });
  });
});

describe('renderStream failure, abort and callback semantics', () => {
  it('a pre-shell render rejection produces exactly one onError, a rejected pre-observed done, and no unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.once('unhandledRejection', onUnhandled);

    try {
      const onError = vi.fn();
      const pt = new PassThrough();
      pt.resume();
      const { renderStream } = createRenderer({
        render: () => {
          throw new Error('boom');
        },
      });

      const { done } = renderStream(pt, { onError }, {}, '/loc');
      // `done` is deliberately left unobserved by this handle's own promise chain for a moment - the
      // renderer's own pre-observation (Streaming.ts:154) must protect it regardless.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(onError).toHaveBeenCalledTimes(1);
      await expect(done).rejects.toThrow('boom');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('a throwing onHead is fatal: onError fires once and done rejects', async () => {
    const onError = vi.fn();
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => ({}) });

    const { done } = renderStream(
      pt,
      {
        onHead: () => {
          throw new Error('head boom');
        },
        onError,
      },
      {},
      '/loc',
    );

    await expect(done).rejects.toThrow('head boom');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a throwing onShellReady/onAllReady is advisory: it does not fail the stream or suppress a sibling callback', async () => {
    const onError = vi.fn();
    const onAllReady = vi.fn(() => {
      throw new Error('all boom');
    });
    const pt = new PassThrough();
    const text = collectText(pt);
    const { renderStream } = createRenderer({ render: () => ({ appHtml: 'A' }) });

    const { done } = renderStream(
      pt,
      {
        onShellReady: () => {
          throw new Error('shell boom');
        },
        onAllReady,
        onError,
      },
      {},
      '/loc',
    );

    await expect(done).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(onAllReady).toHaveBeenCalledTimes(1);
    expect(text()).toBe('A');
  });

  it('the returned abort() resolves done benignly and stops delivery', async () => {
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => new Promise(() => {}) });

    const { abort, done } = renderStream(pt, {}, {}, '/loc');
    abort();

    await expect(done).resolves.toBeUndefined();
  });

  it('an aborted request signal resolves done benignly', async () => {
    const pt = new PassThrough();
    pt.resume();
    const controller = new AbortController();
    const { renderStream } = createRenderer({ render: () => new Promise(() => {}) });

    const { done } = renderStream(pt, {}, {}, '/loc', undefined, {}, controller.signal);
    controller.abort();

    await expect(done).resolves.toBeUndefined();
  });

  it('an already-aborted signal at entry returns a resolved handle with no callback and no write', async () => {
    const onHead = vi.fn();
    const pt = new PassThrough();
    const text = collectText(pt);
    const controller = new AbortController();
    controller.abort();
    const { renderStream } = createRenderer({ render: () => ({ appHtml: 'A' }) });

    const { done } = renderStream(pt, { onHead }, {}, '/loc', undefined, {}, controller.signal);
    await done;

    expect(onHead).not.toHaveBeenCalled();
    expect(text()).toBe('');
  });

  it('a socket-shaped sink error is benign: done resolves and onError is not called', async () => {
    const pt = new PassThrough();
    pt.resume();
    const onError = vi.fn();
    const { renderStream } = createRenderer({ render: () => new Promise(() => {}) });

    const { done } = renderStream(pt, { onError }, {}, '/loc');
    pt.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await expect(done).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a non-socket-shaped sink error is fatal', async () => {
    const pt = new PassThrough();
    pt.resume();
    const onError = vi.fn();
    const { renderStream } = createRenderer({ render: () => new Promise(() => {}) });

    const { done } = renderStream(pt, { onError }, {}, '/loc');
    pt.emit('error', new Error('render exploded'));

    await expect(done).rejects.toThrow('render exploded');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('emits onError exactly once when a render rejection and a sink error race in the same tick', async () => {
    const onError = vi.fn();
    const pt = new PassThrough();
    pt.resume();
    const { renderStream } = createRenderer({ render: () => Promise.reject(new Error('render boom')) });

    const { done } = renderStream(pt, { onError }, {}, '/loc');
    pt.emit('error', new Error('sink boom'));

    await expect(done).rejects.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('terminal guards under a race (contract section 4.3)', () => {
  it('(a) aborting the signal while the critical-data THUNK is pending never calls onHead, writes nothing, and resolves done', async () => {
    const onHead = vi.fn();
    const pt = new PassThrough();
    const text = collectText(pt);
    const controller = new AbortController();
    // A thunk that never settles: the render callback below would prove the outcome wrong if it
    // ever ran, but this cell is about the DATA thunk being pending, not render.
    const dataThunk = () => new Promise<Record<string, unknown>>(() => {});
    const { renderStream } = createRenderer({ render: () => ({ appHtml: 'A' }) });

    const { done } = renderStream(pt, { onHead }, dataThunk, '/loc', undefined, {}, controller.signal);
    controller.abort();

    await expect(done).resolves.toBeUndefined();
    expect(onHead).not.toHaveBeenCalled();
    expect(text()).toBe('');
  });

  it('(b) a shell-timer expiry while render is pending fails the stream exactly once, and a later render resolution produces no write and no callback', async () => {
    const onError = vi.fn();
    const onHead = vi.fn();
    const onShellReady = vi.fn();
    const onAllReady = vi.fn();
    const pt = new PassThrough();
    const text = collectText(pt);
    let resolveRender!: (v: { appHtml: string }) => void;
    const renderPromise = new Promise<{ appHtml: string }>((resolve) => {
      resolveRender = resolve;
    });
    const { renderStream } = createRenderer({ render: () => renderPromise, streamOptions: { shellTimeoutMs: 10 } });

    const { done } = renderStream(pt, { onHead, onShellReady, onAllReady, onError }, {}, '/loc');

    await expect(done).rejects.toThrow(/Shell timeout: no content produced within 10ms for \/loc/);
    expect(onError).toHaveBeenCalledTimes(1);

    // The render resolves AFTER the shell timeout has already failed the stream - the terminal
    // guard after render's own await must discard this, not merely "the stream is already over".
    resolveRender({ appHtml: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onHead).not.toHaveBeenCalled();
    expect(onShellReady).not.toHaveBeenCalled();
    expect(onAllReady).not.toHaveBeenCalled();
    expect(text()).toBe('');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('(d) onShellReady aborting the signal synchronously prevents the appHtml write, the bootstrap tag and end(), and resolves done', async () => {
    const pt = new PassThrough();
    const text = collectText(pt);
    const endSpy = vi.spyOn(pt, 'end');
    const controller = new AbortController();
    const { renderStream } = createRenderer({ render: () => ({ appHtml: 'A' }) });

    const { done } = renderStream(pt, { onShellReady: () => controller.abort() }, {}, '/loc', '/entry.js', {}, controller.signal);

    await expect(done).resolves.toBeUndefined();
    expect(text()).toBe('');
    expect(endSpy).not.toHaveBeenCalled();
  });
});

describe('sink write/end failures are not swallowed (P1 regression)', () => {
  it('a synchronously throwing writable.write of appHtml produces exactly one onError, a rejecting done, no onAllReady and no bootstrap tag', async () => {
    const onError = vi.fn();
    const onAllReady = vi.fn();
    const pt = new PassThrough();
    const writeSpy = vi.spyOn(pt, 'write').mockImplementation(() => {
      throw new Error('write boom');
    });
    const { renderStream } = createRenderer({ render: () => ({ appHtml: 'A' }) });

    const { done } = renderStream(pt, { onError, onAllReady }, {}, '/loc', '/entry.js');

    await expect(done).rejects.toThrow('write boom');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAllReady).not.toHaveBeenCalled();
    // Only the appHtml write was attempted - execution never reached the bootstrap-tag write.
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('a synchronously throwing writable.end() produces exactly one onError and a rejecting (not pending) done', async () => {
    const onError = vi.fn();
    const pt = new PassThrough();
    pt.resume();
    vi.spyOn(pt, 'end').mockImplementation(() => {
      throw new Error('end boom');
    });
    const { renderStream } = createRenderer({ render: () => ({}) });

    const { done } = renderStream(pt, { onError }, {}, '/loc');

    // Bounded race, not an open await: a regression that leaves `done` pending forever must fail
    // this test rather than hang the suite.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('done did not settle within 1000ms')), 1_000));
    await expect(Promise.race([done, timeout])).rejects.toThrow('end boom');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a body write that synchronously emits a non-socket error on the sink rejects done, fires onError once, and never calls onAllReady afterwards', async () => {
    const onError = vi.fn();
    const onAllReady = vi.fn();
    const pt = new PassThrough();
    vi.spyOn(pt, 'write').mockImplementation(() => {
      // Simulates a sink whose write pipeline fails SYNCHRONOUSLY with a render/data-origin error
      // (never benign by shape - R0-02) rather than throwing.
      pt.emit('error', new Error('render exploded'));
      return true;
    });
    const { renderStream } = createRenderer({ render: () => ({ appHtml: 'A' }) });

    const { done } = renderStream(pt, { onError, onAllReady }, {}, '/loc');

    await expect(done).rejects.toThrow('render exploded');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAllReady).not.toHaveBeenCalled();
  });
});

describe('the streaming bootstrap tag', () => {
  it('writes a module script tag with src and async, after appHtml and before end', async () => {
    const pt = new PassThrough();
    const text = collectText(pt);
    const { renderStream } = createRenderer({ render: () => ({ appHtml: 'A' }) });

    const { done } = renderStream(pt, {}, {}, '/loc', '/entry-client.js');
    await done;

    expect(text()).toBe('A<script type="module" src="/entry-client.js" async></script>');
  });

  it('includes an escaped nonce attribute only when cspNonce is given', async () => {
    const withoutNonce = new PassThrough();
    const withoutNonceText = collectText(withoutNonce);
    const { renderStream: renderA } = createRenderer({ render: () => ({}) });
    await renderA(withoutNonce, {}, {}, '/loc', '/e.js').done;
    expect(withoutNonceText()).toBe('<script type="module" src="/e.js" async></script>');

    const withNonce = new PassThrough();
    const withNonceText = collectText(withNonce);
    const { renderStream: renderB } = createRenderer({ render: () => ({}) });
    await renderB(withNonce, {}, {}, '/loc', '/e.js', {}, undefined, { cspNonce: 'ab"c' }).done;
    expect(withNonceText()).toBe('<script type="module" src="/e.js" async nonce="ab&quot;c"></script>');
  });

  it('escapes the bootstrap module src', async () => {
    const pt = new PassThrough();
    const text = collectText(pt);
    const { renderStream } = createRenderer({ render: () => ({}) });

    await renderStream(pt, {}, {}, '/loc', '/a"b.js').done;

    expect(text()).toContain('src="/a&quot;b.js"');
  });

  it('writes nothing when bootstrapModules is undefined', async () => {
    const pt = new PassThrough();
    const text = collectText(pt);
    const { renderStream } = createRenderer({ render: () => ({}) });

    await renderStream(pt, {}, {}, '/loc').done;

    expect(text()).toBe('');
  });
});
