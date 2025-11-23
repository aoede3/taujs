// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

vi.mock('react-dom/server', () => {
  let lastOpts: any;
  const renderToString = vi.fn(() => '<div>html</div>');
  const renderToPipeableStream = vi.fn((_el: any, opts: any) => {
    lastOpts = opts;

    return {
      abort: vi.fn(),
      pipe: vi.fn(), // called after head write / drain
      __opts: lastOpts,
    };
  });
  return {
    renderToString,
    renderToPipeableStream,
    __getLastOpts: () => lastOpts,
  };
});

vi.mock('../SSRDataStore', () => {
  let snapshotImpl: (() => any) | null = null;
  const createSSRStore = vi.fn((data: any) => ({
    getSnapshot: () => {
      if (snapshotImpl) return snapshotImpl();
      return data;
    },
  }));
  const SSRStoreProvider = ({ children }: { children: React.ReactNode }) => <>{children}</>;

  return {
    createSSRStore,
    SSRStoreProvider,
    __setSnapshotImpl: (fn: (() => any) | null) => {
      snapshotImpl = fn;
    },
  };
});

vi.mock('../utils/Streaming', () => {
  const createStreamController = vi.fn((_w: any, _logger: any) => {
    let resolved!: () => void;
    let rejected!: (e: any) => void;
    const done = new Promise<void>((res, rej) => {
      resolved = res;
      rejected = rej;
    });
    const ctrl = {
      isAborted: false,
      done,
      setStreamAbort: vi.fn(),
      setStopShellTimer: vi.fn(),
      setRemoveAbortListener: vi.fn(),
      setGuardsCleanup: vi.fn(),
      benignAbort: vi.fn((_) => {
        ctrl.isAborted = true;
        resolved();
      }),
      fatalAbort: vi.fn((e) => {
        ctrl.isAborted = true;
        rejected(e);
      }),
      complete: vi.fn((_why?: string) => {
        resolved();
      }),
    };
    return ctrl;
  });

  // startShellTimer: capture the timeout handler so tests can trigger it
  let lastTimeoutHandler: (() => void) | undefined;
  const startShellTimer = vi.fn((_ms: number, onTimeout: () => void) => {
    lastTimeoutHandler = onTimeout;
    return vi.fn(); // stop function; we only assert it is called
  });

  // wireWritableGuards: return no-op cleanup (we verify it’s set, not effects)
  const wireWritableGuards = vi.fn((_w: any, _cfg: any) => ({ cleanup: vi.fn() }));

  // benign predicate configurable per test
  const isBenignStreamErr = vi.fn(() => false);

  return {
    DEFAULT_BENIGN_ERRORS: /x/i,
    createStreamController,
    startShellTimer,
    wireWritableGuards,
    isBenignStreamErr,
    __getLastTimeoutHandler: () => lastTimeoutHandler,
  };
});

import { createRenderer } from '../SSRRender';
import * as RDS from 'react-dom/server';
import * as Store from '../SSRDataStore';
import * as Streaming from '../utils/Streaming';

type DrainableWritable = {
  write: (chunk: any) => boolean;
  once: (ev: string, fn: (...a: any[]) => void) => void;
  cork?: () => void;
  uncork?: () => void;
};

function makeWritable({ willBackpressure = false, supportCork = false }: { willBackpressure?: boolean; supportCork?: boolean } = {}) {
  let drainHandler: (() => void) | null = null;
  const w: DrainableWritable = {
    write: vi.fn(() => !willBackpressure),
    once: vi.fn((ev: string, fn: any) => {
      if (ev === 'drain') drainHandler = fn;
    }),
    ...(supportCork ? { cork: vi.fn(), uncork: vi.fn() } : {}),
  };
  return {
    writable: w,
    triggerDrain: () => {
      drainHandler?.();
      drainHandler = null;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // reset dynamic snapshot impl
  (Store as any).__setSnapshotImpl(null);
  // ensure Node Writable supports cork in tests that need it
  // (set per-test explicitly via makeWritable)
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRenderer.renderSSR', () => {
  it('renders head + html and logs around render', async () => {
    const log = vi.fn();
    const renderer = createRenderer<any>({
      appComponent: ({ location }) => <div>{location}</div>,
      headContent: ({ data, meta }) => `<head>${data.title}-${meta.x}</head>`,
      enableDebug: true,
      logger: { log },
    });

    const out = await renderer.renderSSR({ title: 'T' } as any, '/home', { x: 1 });

    expect(Store.createSSRStore).toHaveBeenCalledWith({ title: 'T' });
    expect(RDS.renderToString).toHaveBeenCalledTimes(1);
    expect(out.headContent).toBe('<head>T-1</head>');
    expect(out.appHtml).toBe('<div>html</div>');

    expect(log).toHaveBeenCalledTimes(2);

    expect(log).toHaveBeenNthCalledWith(1, 'Starting SSR:', '/home');

    expect(log).toHaveBeenNthCalledWith(2, 'Completed SSR:', '/home');
  });

  it('skips immediately when AbortSignal is already aborted', async () => {
    const warn = vi.fn();
    const ac = new AbortController();
    ac.abort(); // already aborted before call

    const renderer = createRenderer<any>({
      appComponent: ({ location }) => <div>{location}</div>,
      headContent: () => '<head>x</head>',
      enableDebug: true,
      logger: { warn },
    });

    const out = await renderer.renderSSR({ title: 'X' } as any, '/skip', {}, ac.signal);

    // No render attempts
    expect(Store.createSSRStore).not.toHaveBeenCalled();
    expect(RDS.renderToString).not.toHaveBeenCalled();

    // Warn with prefix + message + context
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, meta] = (warn as any).mock.calls[0]!;
    expect(msg).toContain('SSR skipped; already aborted');
    expect(meta).toEqual({ location: '/skip' });
    expect(out).toEqual({ headContent: '', appHtml: '', aborted: true });
  });

  it('aborts during SSR: warns and returns aborted=true', async () => {
    const warn = vi.fn();
    const ac = new AbortController();

    const renderer = createRenderer<any>({
      appComponent: ({ location }) => <div>{location}</div>,
      headContent: () => '<head>y</head>',
      enableDebug: true,
      logger: { warn },
    });

    // We’ll abort *after* render kicks off but before completion
    // Mock renderToString to let us flip the signal in-between
    // const orig = RDS.renderToString as unknown as jest.Mock | vi.Mock;
    (RDS.renderToString as any).mockImplementationOnce(() => {
      // abort right before returning html to flip `aborted = true`
      ac.abort();
      return '<div>html</div>';
    });

    const out = await renderer.renderSSR({ title: 'Y' } as any, '/mid', {}, ac.signal);

    // Should have rendered, but then detected abort and returned aborted=true
    expect(Store.createSSRStore).toHaveBeenCalledTimes(1);
    expect(RDS.renderToString).toHaveBeenCalledTimes(1);

    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, meta] = (warn as any).mock.calls[0]!;
    expect(msg).toContain('SSR completed after client abort');
    expect(meta).toEqual({ location: '/mid' });
    expect(out).toEqual({ headContent: '', appHtml: '', aborted: true });
  });

  it('always removes abort listener in finally; errors from removeEventListener are swallowed', async () => {
    const ac = new AbortController();
    const spy = vi.spyOn(ac.signal, 'removeEventListener').mockImplementationOnce(() => {
      throw new Error('remove boom');
    });

    const renderer = createRenderer<any>({
      appComponent: () => <div>ok</div>,
      headContent: () => '<head>ok</head>',
    });

    // Normal (non-aborted) run
    const out = await renderer.renderSSR({ t: 1 } as any, '/ok', {}, ac.signal);

    // We completed normally
    expect(out.aborted).toBe(false);
    // removeEventListener was called and its error didn’t escape
    expect(spy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('renderSSR uses renderer-level logger when per-call opts.logger is not provided', async () => {
    const topLog = vi.fn();
    const overrideLog = vi.fn(); // should NOT be used

    const renderer = createRenderer<any>({
      appComponent: () => <div>ok</div>,
      headContent: () => '<head/>',
      enableDebug: true,
      logger: { log: topLog }, // renderer-level
    });

    await renderer.renderSSR({} as any, '/use-top', {});

    // Called twice: "Starting SSR with location:" and "Completed SSR for location:"
    expect(topLog).toHaveBeenCalledTimes(2);
    expect(topLog).toHaveBeenNthCalledWith(1, 'Starting SSR:', '/use-top');
    expect(topLog).toHaveBeenNthCalledWith(2, 'Completed SSR:', '/use-top');

    expect(overrideLog).not.toHaveBeenCalled();
  });

  it('renderSSR prefers per-call opts.logger over renderer-level logger', async () => {
    const topLog = vi.fn(); // renderer-level (should NOT be used)
    const callLog = vi.fn(); // per-call (should be used)
    const callWarn = vi.fn();

    const renderer = createRenderer<any>({
      appComponent: () => <div>ok</div>,
      headContent: () => '<head/>',
      enableDebug: true,
      logger: { log: topLog }, // default
    });

    await renderer.renderSSR({} as any, '/use-override', {}, undefined, { logger: { log: callLog, warn: callWarn } });

    // Per-call logger gets both messages
    expect(callLog).toHaveBeenCalledTimes(2);
    expect(callLog).toHaveBeenNthCalledWith(1, 'Starting SSR:', '/use-override');
    expect(callLog).toHaveBeenNthCalledWith(2, 'Completed SSR:', '/use-override');

    // Renderer-level logger not touched
    expect(topLog).not.toHaveBeenCalled();
    // We didn’t hit any warn path here; just assert it wasn’t called spuriously
    expect(callWarn).not.toHaveBeenCalled();
  });
});

describe('createRenderer.renderStream', () => {
  it('happy path: shell ready -> head write -> pipe -> all ready -> callbacks & finish; stop timer; done resolves', async () => {
    const { writable } = makeWritable();
    const log = vi.fn(),
      warn = vi.fn(),
      error = vi.fn();
    const onHead = vi.fn(),
      onShellReady = vi.fn(),
      onAllReady = vi.fn(),
      onFinish = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: ({ location }) => <div>{location}</div>,
      headContent: () => '<head>ok</head>',
      enableDebug: true,
      logger: { log, warn, error },
    });

    const { done } = renderStream(writable as any, { onHead, onShellReady, onAllReady, onFinish }, { data: 1 }, '/x', '/boot.js', { m: 1 }, 'nonce-1');

    const opts = (RDS as any).__getLastOpts();
    expect(opts.bootstrapModules).toEqual(['/boot.js']);
    opts.onShellReady();
    opts.onAllReady();

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('test-complete');
    await expect(done).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith('Shell ready:', '/x');
    expect(onHead).toHaveBeenCalledWith('<head>ok</head>');

    expect((writable.write as any).mock.calls.length).toBe(1);

    const streamInstance = (RDS.renderToPipeableStream as any).mock.results[0].value;
    expect(streamInstance.pipe).toHaveBeenCalledWith(writable);
    expect(onShellReady).toHaveBeenCalledTimes(1);

    expect(onAllReady).toHaveBeenCalledWith({ data: 1 });
    expect(onFinish).toHaveBeenCalledWith({ data: 1 });

    await expect(done).resolves.toBeUndefined();
  });

  it('backpressure: waits for drain before piping; cork/uncork used when supported', async () => {
    const { writable, triggerDrain } = makeWritable({ willBackpressure: true, supportCork: true });
    const log = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div>z</div>,
      headContent: () => '<head>bp</head>',
      enableDebug: true,
      logger: { log },
      streamOptions: { useCork: true },
    });

    const { done } = renderStream(writable as any, {}, {}, '/bp');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady(); // causes head write returning false and sets drain handler

    // corked
    expect((writable as any).cork).toHaveBeenCalledTimes(1);
    expect((writable as any).uncork).toHaveBeenCalledTimes(1);

    // no pipe yet
    const streamInstance = (RDS.renderToPipeableStream as any).mock.results[0].value;
    expect(streamInstance.pipe).not.toHaveBeenCalled();

    // drain fires -> then pipe
    triggerDrain();
    expect(streamInstance.pipe).toHaveBeenCalledWith(writable);

    opts.onAllReady();
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('test-complete');
    await expect(done).resolves.toBeUndefined();
  });

  it('headContent throws inside onShellReady → onError + fatalAbort; done rejects', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div>z</div>,
      headContent: () => {
        throw new Error('head boom');
      },
      enableDebug: true,
      logger: {},
    });

    const { done } = renderStream(writable as any, { onError }, {}, '/err');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady();

    await expect(done).rejects.toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    const ctrl = (Streaming.createStreamController as any).mock.results[0].value;
    expect(ctrl.fatalAbort).toHaveBeenCalled();
  });

  it('onAllReady: getSnapshot throws a thenable first → resolves then re-delivers; non-thenable throws → fatal', async () => {
    const { writable } = makeWritable();
    let delivered = 0;
    (Store as any).__setSnapshotImpl(() => {
      if (delivered === 0) {
        delivered++;
        let resume!: () => void;
        const p = new Promise<void>((r) => (resume = r));
        Promise.resolve().then(() => resume());

        throw p;
      }
      return { ok: true };
    });

    const onAllReady = vi.fn(),
      onFinish = vi.fn(),
      onError = vi.fn();
    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      enableDebug: true,
    });

    const { done } = renderStream(writable as any, { onAllReady, onFinish, onError }, {}, '/thenable');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady();
    opts.onAllReady();

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('test-complete');
    await expect(done).resolves.toBeUndefined();

    await expect(done).resolves.toBeUndefined();
    expect(onAllReady).toHaveBeenCalledWith({ ok: true });
    expect(onFinish).toHaveBeenCalledWith({ ok: true });
    expect(onError).not.toHaveBeenCalled();

    (Store as any).__setSnapshotImpl(() => {
      throw new Error('bad');
    });
    const { done: done2 } = renderStream(writable as any, { onError }, {}, '/bad');
    const opts2 = (RDS as any).__getLastOpts();
    opts2.onShellReady();
    opts2.onAllReady();

    const ctrl1 = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl1.benignAbort('test-complete');
    await expect(done).resolves.toBeUndefined();

    await expect(done2).rejects.toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('onShellError → fatalAbort + done rejects', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const { done } = renderStream(writable as any, { onError }, {}, '/shellerror');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellError(new Error('shell bad'));

    await expect(done).rejects.toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('onError benign → benignAbort resolves; onError fatal → fatalAbort rejects', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();

    (Streaming.isBenignStreamErr as any).mockReturnValueOnce(true);

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const r1 = renderStream(writable as any, { onError }, {}, '/benign');
    let opts = (RDS as any).__getLastOpts();
    opts.onError(new Error('ECONNRESET'));

    await expect(r1.done).resolves.toBeUndefined();

    // fatal case
    const r2 = renderStream(writable as any, { onError }, {}, '/fatal');
    opts = (RDS as any).__getLastOpts();
    opts.onError(new Error('boom'));

    await expect(r2.done).rejects.toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('AbortSignal already aborted: benign abort & no stream render; manual abort works', async () => {
    const { writable } = makeWritable();
    const ac = new AbortController();
    ac.abort(); // already aborted

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const r = renderStream(writable as any, {}, {}, '/sig', undefined, {}, undefined, ac.signal);
    expect(RDS.renderToPipeableStream).not.toHaveBeenCalled();
    await expect(r.done).resolves.toBeUndefined();

    const r2 = renderStream(writable as any, {}, {}, '/manual');
    r2.abort();
    await expect(r2.done).resolves.toBeUndefined();
  });

  it('AbortSignal triggers later and is removed via controller hook', async () => {
    const { writable } = makeWritable();
    const ac = new AbortController();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const r = renderStream(writable as any, {}, {}, '/later', undefined, {}, undefined, ac.signal);
    ac.abort();
    await expect(r.done).resolves.toBeUndefined();

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1).value;
    expect(ctrl.setRemoveAbortListener).toHaveBeenCalledTimes(1);
  });

  it('AbortSignal already aborted → returns dummy {abort, done}; abort is a no-op; controller.benignAbort called once; no render', async () => {
    const ac = new AbortController();
    ac.abort(); // already aborted
    const { writable } = makeWritable();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const r = renderStream(writable as any, {}, {}, '/aborted-early', undefined, {}, undefined, ac.signal);

    // controller.benignAbort called once by handleAbortSignal
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    expect(ctrl.benignAbort).toHaveBeenCalledTimes(1);

    // returned interface is the dummy
    expect(typeof r.abort).toBe('function');
    await expect(r.done).resolves.toBeUndefined();

    // Calling r.abort() is a no-op (does NOT call controller.benignAbort again)
    r.abort();
    expect(ctrl.benignAbort).toHaveBeenCalledTimes(1);

    // No streaming attempted
    expect(RDS.renderToPipeableStream).not.toHaveBeenCalled();
  });

  it('shell timeout fires when shell never becomes ready → fatalAbort', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      streamOptions: { shellTimeoutMs: 1234 },
    });

    const r = renderStream(writable as any, { onError }, {}, '/timeout');
    const timeoutFn = (Streaming as any).__getLastTimeoutHandler() as (() => void) | undefined;
    expect(typeof timeoutFn).toBe('function');
    timeoutFn!();

    await expect(r.done).rejects.toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('per-call options override renderer defaults (shellTimeout / useCork=false)', async () => {
    const { writable } = makeWritable({ willBackpressure: true, supportCork: true });

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      streamOptions: { shellTimeoutMs: 10, useCork: true },
    });

    // override useCork -> false; also override shellTimeout
    renderStream(writable as any, {}, {}, '/opts', undefined, {}, undefined, undefined, { shellTimeoutMs: 1, useCork: false });
    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady();

    // uncork/cork should NOT be used because per-call useCork=false
    expect((writable as any).cork).toBeDefined();
    expect((writable as any).cork).not.toHaveBeenCalled();
    expect((writable as any).uncork).not.toHaveBeenCalled();
  });

  it('setRemoveAbortListener uses try/catch around signal.removeEventListener and swallows errors', async () => {
    const { writable } = makeWritable();
    const ac = new AbortController();

    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener').mockImplementationOnce(() => {
      throw new Error('remove boom');
    });

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    renderStream(writable as any, {}, {}, '/later', undefined, {}, undefined, ac.signal);

    // Grab the function registered via controller.setRemoveAbortListener(...)
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    expect(ctrl.setRemoveAbortListener).toHaveBeenCalledTimes(1);
    const remover = ctrl.setRemoveAbortListener.mock.calls[0]![0] as () => void;

    // Should NOT throw even though removeEventListener throws
    expect(() => remover()).not.toThrow();
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('wireWritableGuards: benignAbort(why) → controller.benignAbort(why)', () => {
    const { writable } = makeWritable();
    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    renderStream(writable as any, {}, {}, '/guards-benign');

    // { benignAbort, fatalAbort, onError } to wireWritableGuards
    const cfg = (Streaming.wireWritableGuards as any).mock.calls.at(-1)![1];
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;

    cfg.benignAbort('client left'); // simulate guard firing
    expect(ctrl.benignAbort).toHaveBeenCalledWith('client left');
  });

  it('wireWritableGuards: fatalAbort(err) → calls onError and controller.fatalAbort(err)', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    renderStream(writable as any, { onError }, {}, '/guards-fatal');
    const { done } = renderStream(writable as any, { onError }, {}, '/guards-fatal');

    const cfg = (Streaming.wireWritableGuards as any).mock.calls.at(-1)![1];
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;

    const err = new Error('boom');
    cfg.fatalAbort(err);

    expect(onError).toHaveBeenCalledWith(err);
    expect(ctrl.fatalAbort).toHaveBeenCalledWith(err);
    await expect(done).rejects.toThrow('boom');
  });

  it('wireWritableGuards: onFinish() → controller.complete("Stream finished (normal completion)") and done resolves', async () => {
    const { writable } = makeWritable();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const { done } = renderStream(writable as any, {}, {}, '/guards-finish');

    const cfg = (Streaming.wireWritableGuards as any).mock.calls.at(-1)![1];
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;

    cfg.onFinish();

    await expect(done).resolves.toBeUndefined();
    expect(ctrl.complete).toHaveBeenCalledWith('Stream finished (normal completion)');
  });

  it('onShellReady callback throws → warns but does not fatal', async () => {
    const { writable } = makeWritable();
    const warn = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      enableDebug: true,
      logger: { warn },
    });

    const onShellReady = vi.fn(() => {
      throw new Error('cb boom');
    });
    const { done } = renderStream(
      writable as any,
      { onShellReady }, // this will throw inside the try/catch
      {},
      '/cb-throws',
    );

    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady(); // triggers the throwing callback (wrapped)

    // warned, and NOT fatal-aborted
    expect(warn).toHaveBeenCalledTimes(1);
    const [label, err] = (warn as any).mock.calls[0]!;
    expect(label).toContain('onShellReady callback threw:');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('cb boom');

    // finish the stream explicitly so `done` resolves
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('test-complete');
    await expect(done).resolves.toBeUndefined();
  });

  it('onAllReady → getSnapshot throws rejecting thenable → logs error, onError, fatalAbort (rejects)', async () => {
    const { writable } = makeWritable();

    // Throw a Promise that REJECTS later
    (Store as any).__setSnapshotImpl(() => {
      let reject!: (e: any) => void;
      const p = new Promise((_res, rej) => {
        reject = rej;
      });
      // reject in microtask
      Promise.resolve().then(() => reject(new Error('nope')));
      throw p; // Suspense-style thenable
    });

    const errorLog = vi.fn();
    const onError = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      enableDebug: true,
      logger: { error: errorLog },
    });

    const { done } = renderStream(writable as any, { onError }, {}, '/rejecting-thenable');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady();
    opts.onAllReady(); // deliver() runs; thenable rejects → catch path

    await expect(done).rejects.toBeInstanceOf(Error);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [label, err] = (errorLog as any).mock.calls[0]!;
    expect(label).toContain('Data promise rejected:');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('nope');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('renderToPipeableStream throws synchronously → onError + fatalAbort (rejects)', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();

    // First call throws synchronously when createRenderer tries to start streaming
    (RDS.renderToPipeableStream as any).mockImplementationOnce((_el: any, _opts: any) => {
      throw new Error('sync explode');
    });

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const { done } = renderStream(writable as any, { onError }, {}, '/sync-throw');

    await expect(done).rejects.toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('callbacks no-op when controller is already aborted (early return guards)', async () => {
    const { writable } = makeWritable();
    const headSpy = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: headSpy,
    });

    const { done } = renderStream(writable as any, {}, {}, '/aborted-callbacks');

    // flip to aborted before invoking any callbacks
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.isAborted = true;

    const opts = (RDS as any).__getLastOpts();
    // none of these should do anything or throw
    expect(() => opts.onShellReady()).not.toThrow();
    expect(() => opts.onAllReady()).not.toThrow();
    expect(() => opts.onShellError(new Error('x'))).not.toThrow();
    expect(() => opts.onError(new Error('y'))).not.toThrow();

    // no head calculation, no writes, no extra aborts
    expect(headSpy).not.toHaveBeenCalled();
    expect(writable.write as any).not.toHaveBeenCalled();
    expect(ctrl.benignAbort).not.toHaveBeenCalled();
    expect(ctrl.fatalAbort).not.toHaveBeenCalled();

    // finish explicitly to settle done
    ctrl.benignAbort('test-complete');
    await expect(done).resolves.toBeUndefined();
  });

  it('stopShellTimer throwing in onShellReady is swallowed (catch {})', async () => {
    const { writable } = makeWritable();
    // Make startShellTimer return a stop function that throws
    (Streaming.startShellTimer as any).mockImplementationOnce((_ms: number, _cb: () => void) => {
      return vi.fn(() => {
        throw new Error('stop fail');
      });
    });

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const { done } = renderStream(writable as any, {}, {}, '/stop-throws');
    const opts = (RDS as any).__getLastOpts();

    // Should not throw out of onShellReady despite stop throwing
    expect(() => opts.onShellReady()).not.toThrow();

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('complete');
    await expect(done).resolves.toBeUndefined();
  });

  it('uncork throwing is swallowed in finally block (catch {})', async () => {
    const { writable } = makeWritable({ willBackpressure: false, supportCork: true });
    // Make uncork throw
    (writable as any).uncork = vi.fn(() => {
      throw new Error('uncork boom');
    });

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      streamOptions: { useCork: true },
    });

    const { done } = renderStream(writable as any, {}, {}, '/uncork-throws');
    const opts = (RDS as any).__getLastOpts();

    // Should not throw out of onShellReady even though uncork throws in finally
    expect(() => opts.onShellReady()).not.toThrow();

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('complete');
    await expect(done).resolves.toBeUndefined();
  });

  it("onError with object lacking message (err?.message ?? '') and non-benign → fatalAbort", async () => {
    const { writable } = makeWritable();
    const onErrorCb = vi.fn();

    (Streaming.isBenignStreamErr as any).mockReturnValue(false);

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const { done } = renderStream(writable as any, { onError: onErrorCb }, {}, '/no-message');
    const opts = (RDS as any).__getLastOpts();

    // Pass exactly once: an object with no .message to hit (err?.message ?? '')
    const errObj: any = {}; // no .message
    opts.onError(errObj);

    await expect(done).rejects.toBe(errObj); // rejects with the same object
    expect(onErrorCb).toHaveBeenCalledWith(errObj);
  });

  it('onShellError triggers stopShellTimer catch and fatalAbort', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();
    // stop function throws to hit catch in onShellError
    (Streaming.startShellTimer as any).mockImplementationOnce((_ms: number, _cb: () => void) => {
      return vi.fn(() => {
        throw new Error('stop fail');
      });
    });

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const { done } = renderStream(writable as any, { onError }, {}, '/shell-error-stop');
    const opts = (RDS as any).__getLastOpts();

    expect(() => opts.onShellError(new Error('boom'))).not.toThrow();
    await expect(done).rejects.toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('shell timeout handler early-returns when controller is already aborted', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      streamOptions: { shellTimeoutMs: 111 }, // any value and invoke handler manually
    });

    const { done } = renderStream(writable as any, { onError }, {}, '/timeout-already-aborted');

    // grab controller + the captured timeout handler
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    const timeoutFn = (Streaming as any).__getLastTimeoutHandler() as (() => void) | undefined;
    expect(typeof timeoutFn).toBe('function');

    // simulate that the stream was aborted before the timer fires
    ctrl.isAborted = true;

    // invoking the timer should do nothing (early return), i.e., no onError/fatalAbort
    timeoutFn!();
    expect(onError).not.toHaveBeenCalled();
    expect(ctrl.fatalAbort).not.toHaveBeenCalled();

    // settle the promise to keep the test from hanging
    ctrl.benignAbort('test-complete');
    await expect(done).resolves.toBeUndefined();
  });

  it('onShellReady: cork() throws but is swallowed; uncork still called and stream proceeds', async () => {
    // writable supports cork/uncork; make cork throw
    const { writable } = makeWritable({ willBackpressure: false, supportCork: true });
    (writable as any).cork = vi.fn(() => {
      throw new Error('cork boom');
    });
    const warn = vi.fn(),
      error = vi.fn(),
      log = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      logger: { warn, error, log },
      streamOptions: { useCork: true },
    });

    const { done } = renderStream(writable as any, {}, {}, '/cork-throws');
    const opts = (RDS as any).__getLastOpts();

    // Should NOT throw despite cork throwing
    expect(() => opts.onShellReady()).not.toThrow();

    // uncork still attempted in finally
    expect((writable as any).uncork).toHaveBeenCalledTimes(1);

    // streaming should continue (pipe called)
    const streamInstance = (RDS.renderToPipeableStream as any).mock.results.at(-1)!.value;
    expect(streamInstance.pipe).toHaveBeenCalledWith(writable);

    // settle
    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('complete');
    await expect(done).resolves.toBeUndefined();
  });

  it('onShellReady: writable has no write() → fallback true path pipes immediately', async () => {
    // writable without write() to hit the "?: true" branch
    const w: any = {
      once: vi.fn(),
      // no write, no cork/uncork
    };
    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const { done } = renderStream(w as any, {}, {}, '/no-write');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady(); // should not throw

    // pipe was called immediately since wroteOk===true and onHead!==false
    const streamInstance = (RDS.renderToPipeableStream as any).mock.results.at(-1)!.value;
    expect(streamInstance.pipe).toHaveBeenCalledWith(w);
    expect(w.once).not.toHaveBeenCalled(); // no drain waiting

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('done');
    await expect(done).resolves.toBeUndefined();
  });
  it('onShellReady: onHead callback throws → warns and continues streaming', async () => {
    const { writable } = makeWritable();
    const warn = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      enableDebug: true,
      logger: { warn },
    });

    const onHead = vi.fn(() => {
      throw new Error('head-cb boom');
    });
    const { done } = renderStream(writable as any, { onHead }, {}, '/onhead-throws');

    const opts = (RDS as any).__getLastOpts();
    expect(() => opts.onShellReady()).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, errObj] = (warn as any).mock.calls[0]!;
    expect(msg).toContain('onHead callback threw:');
    expect(errObj).toBeInstanceOf(Error);
    expect((errObj as Error).message).toBe('head-cb boom');

    const streamInstance = (RDS.renderToPipeableStream as any).mock.results.at(-1)!.value;
    expect(streamInstance.pipe).toHaveBeenCalledWith(writable);

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('ok');
    await expect(done).resolves.toBeUndefined();
  });

  it('onShellReady: backpressure + writable has no once() method → pipes immediately (best effort)', async () => {
    // Create a writable that:
    // 1. Has write() returning false (backpressure)
    // 2. Does NOT have once() method - this triggers the "no drain support" else branch
    const w: any = {
      write: vi.fn(() => false), // backpressure = true
      // Intentionally NO once() method to hit: "no drain support; best effort start"
      // (not providing cork/uncork either)
    };

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const { done } = renderStream(w as any, {}, {}, '/no-drain-support');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady();

    // Should pipe immediately (best effort) even though:
    // - write() returned false (backpressure)
    // - onHead didn't return false
    // Because there's no once() method available to wait for 'drain'
    const streamInstance = (RDS.renderToPipeableStream as any).mock.results.at(-1)!.value;
    expect(streamInstance.pipe).toHaveBeenCalledWith(w);

    // write was called (and returned false due to backpressure)
    expect(w.write).toHaveBeenCalledTimes(1);

    // Verify that once() was NOT called (because it doesn't exist)
    expect(w.once).toBeUndefined();

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('done');
    await expect(done).resolves.toBeUndefined();
  });

  // Also test the case where onHead returns false (forces wait) but no once() available
  it('onShellReady: onHead returns false (force wait) + no once() → pipes immediately (best effort)', async () => {
    const w: any = {
      write: vi.fn(() => true), // no backpressure from write
      // NO once() method
    };

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const onHead = vi.fn(() => false); // explicitly request wait for drain
    const { done } = renderStream(w as any, { onHead }, {}, '/onhead-force-no-once');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellReady();

    // onHead returned false (wants to wait) but there's no once() to attach a listener,
    // so it falls through to best-effort startPipe()
    const streamInstance = (RDS.renderToPipeableStream as any).mock.results.at(-1)!.value;
    expect(streamInstance.pipe).toHaveBeenCalledWith(w);

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    ctrl.benignAbort('done');
    await expect(done).resolves.toBeUndefined();
  });
});
