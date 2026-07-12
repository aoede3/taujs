// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

// R3-06: renderSSR renders via prerenderToNodeStream (conditional react-dom/static — Node build
// at runtime). The mock resolves with a one-chunk prelude, mirroring a completed prerender.
vi.mock('react-dom/static', async () => {
  const { Readable } = await import('node:stream');
  const prerenderToNodeStream = vi.fn(async (_el: any, _opts: any) => ({
    prelude: Readable.from(['<div>html</div>']),
    postponed: null,
  }));
  return { prerenderToNodeStream };
});

vi.mock('react-dom/server', () => {
  let lastOpts: any;
  const renderToPipeableStream = vi.fn((_el: any, opts: any) => {
    lastOpts = opts;

    return {
      abort: vi.fn(),
      pipe: vi.fn(), // called after head write / drain
      __opts: lastOpts,
    };
  });
  return {
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

  return {
    createStreamController,
    startShellTimer,
    wireWritableGuards,
    __getLastTimeoutHandler: () => lastTimeoutHandler,
  };
});

import { Readable } from 'node:stream';

import { createRenderer } from '../SSRRender';
import * as RDS from 'react-dom/server';
import * as RDStatic from 'react-dom/static';
import * as Store from '../SSRDataStore';
import * as Streaming from '../utils/Streaming';

type DrainableWritable = {
  write: (chunk: any) => boolean;
  once: (ev: string, fn: (...a: any[]) => void) => void;
};

function makeWritable() {
  return {
    writable: {
      // keep as plain object; pipe() is mocked on the stream, not on writable
      on: vi.fn(),
      once: vi.fn(),
      write: vi.fn(), // not used, but harmless if other code expects it
      end: vi.fn(),
      destroy: vi.fn(),
    } as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // reset dynamic snapshot impl
  (Store as any).__setSnapshotImpl(null);
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
    expect(RDStatic.prerenderToNodeStream).toHaveBeenCalledTimes(1);
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
    expect(RDStatic.prerenderToNodeStream).not.toHaveBeenCalled();

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

    // We’ll abort *after* render kicks off but before completion:
    // mock prerenderToNodeStream to flip the signal before resolving.
    (RDStatic.prerenderToNodeStream as any).mockImplementationOnce(async () => {
      // abort right before resolving to flip `aborted = true`
      ac.abort();
      return { prelude: Readable.from(['<div>html</div>']), postponed: null };
    });

    const out = await renderer.renderSSR({ title: 'Y' } as any, '/mid', {}, ac.signal);

    // Should have rendered, but then detected abort and returned aborted=true
    expect(Store.createSSRStore).toHaveBeenCalledTimes(1);
    expect(RDStatic.prerenderToNodeStream).toHaveBeenCalledTimes(1);

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
  it('passes bootstrapModules array to renderToPipeableStream when provided', () => {
    const { writable } = makeWritable();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    renderStream(
      writable as any,
      {},
      {},
      '/with-bootstrap',
      '/entry-client.tsx', // bootstrapModules param (truthy)
    );

    // Grab the options passed to renderToPipeableStream
    const opts = (RDS as any).__getLastOpts();
    expect(opts.bootstrapModules).toEqual(['/entry-client.tsx']);
  });

  it('passes bootstrapModules undefined when not provided', () => {
    const { writable } = makeWritable();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    renderStream(writable as any, {}, {}, '/no-bootstrap');

    const opts = (RDS as any).__getLastOpts();
    expect(opts.bootstrapModules).toBeUndefined();
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

  // NOTE: the old thrown-thenable deliver-retry dance in `onAllReady` was removed in R1-01 — final
  // data delivery is now owned by the bounded end-gate (deferred until store readiness settles).
  // That path is covered end-to-end against real react-dom/server in SSRRender.integration.test.tsx
  // (R2 data-loss + store-error → gate-fatal), which the mock (no-op pipe) cannot drive.

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

  it("React's onError is NON-FATAL (R1-01): routes to onRenderError, does not settle done, never calls the fatal onError", async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();
    const onRenderError = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    // No onShellReady() yet → shell not committed → phase is 'pre-shell', recoverable 'unknown'.
    const r = renderStream(writable as any, { onError, onRenderError }, {}, '/render-error');
    const opts = (RDS as any).__getLastOpts();
    const err = new Error('boundary boom');
    expect(() => opts.onError(err)).not.toThrow();

    // Structured, non-fatal observation — NOT the fatal channel, NOT a settlement.
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(onRenderError).toHaveBeenCalledWith({ error: err, phase: 'pre-shell', recoverable: 'unknown' });
    expect(onError).not.toHaveBeenCalled();

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    expect(ctrl.fatalAbort).not.toHaveBeenCalled();

    // done is settled by a separate channel, never by onError.
    ctrl.benignAbort('test-complete');
    await expect(r.done).resolves.toBeUndefined();
  });

  it('recheck: a throwing cb.onError does not veto fatal settlement — done rejects with the ORIGINAL error, single fire', async () => {
    const { writable } = makeWritable();
    const original = new Error('shell boom');
    const onError = vi.fn(() => {
      throw new Error('onError boom');
    });

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const r = renderStream(writable as any, { onError }, {}, '/fatal-throwing-cb');
    const opts = (RDS as any).__getLastOpts();
    opts.onShellError(original); // React surfaces a fatal shell error → the failFatal path

    // failFatal runs controller.fatalAbort even though cb.onError threw (old code skipped it →
    // done never settled). The original error is the reject reason.
    await expect(r.done).rejects.toBe(original);
    expect(onError).toHaveBeenCalledTimes(1); // single fire (no double-fire, no skip)
  });

  it("recheck-2: a hostile FRAMEWORK error (throwing message getter / Symbol.toPrimitive) doesn't throw before failFatal", async () => {
    const hostiles: ReadonlyArray<() => unknown> = [
      () => {
        const o: Record<string, unknown> = {};
        Object.defineProperty(o, 'message', {
          get() {
            throw new Error('getter boom');
          },
        });
        return o;
      },
      () => ({
        message: {
          [Symbol.toPrimitive]() {
            throw new Error('coercion boom');
          },
        },
      }),
    ];

    for (const make of hostiles) {
      const { writable } = makeWritable();
      const onError = vi.fn();
      const hostile = make();

      const { renderStream } = createRenderer<any>({
        appComponent: () => <div />,
        headContent: () => '<head/>',
      });

      const r = renderStream(writable as any, { onError }, {}, '/hostile-framework-error');
      const opts = (RDS as any).__getLastOpts();

      // React surfaces a hostile error on a fatal channel — failFatal must NOT coerce it before
      // aborting, so the call does not throw, and settlement/single-fire still happen with the
      // ORIGINAL value.
      expect(() => opts.onShellError(hostile)).not.toThrow();

      await expect(r.done).rejects.toBe(hostile);
      expect(onError).toHaveBeenCalledTimes(1);
      // reference check (toHaveBeenCalledWith would deep-equal the arg and trip the throwing getter)
      expect(onError.mock.calls[0]?.[0]).toBe(hostile);
    }
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

  it('per-call options override renderer defaults (shellTimeoutMs)', () => {
    const { writable } = makeWritable();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      streamOptions: { shellTimeoutMs: 10 },
    });

    renderStream(
      writable as any,
      {},
      {},
      '/opts',
      undefined,
      {},
      undefined,
      undefined,
      { shellTimeoutMs: 1 }, // override
    );

    expect(Streaming.startShellTimer).toHaveBeenCalledTimes(1);

    const [ms] = (Streaming.startShellTimer as any).mock.calls[0];
    expect(ms).toBe(1);
  });

  it('uses renderer default shellTimeoutMs when per-call override is not provided', () => {
    const { writable } = makeWritable();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      streamOptions: { shellTimeoutMs: 10 },
    });

    renderStream(writable as any, {}, {}, '/default');

    const [ms] = (Streaming.startShellTimer as any).mock.calls.at(-1);
    expect(ms).toBe(10);
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

  it('onShellReady callback throws → logs (advisory) but does not fatal', async () => {
    const { writable } = makeWritable();
    const errorLog = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
      enableDebug: true,
      logger: { error: errorLog },
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
    opts.onShellReady(); // triggers the throwing callback (isolated)

    // logged (advisory), and NOT fatal-aborted
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [label, err] = (errorLog as any).mock.calls[0]!;
    expect(label).toContain('onShellReady callback threw:');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('cb boom');

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    expect(ctrl.fatalAbort).not.toHaveBeenCalled();

    // finish the stream explicitly so `done` resolves
    ctrl.benignAbort('test-complete');
    await expect(done).resolves.toBeUndefined();
  });

  // NOTE: the store data-fetch-error path (store settles to status:'error') is now handled by the
  // bounded end-gate, not by a deliver-retry inside onAllReady. It fatal-aborts the response after
  // the gate observes readiness — covered against real react-dom/server in the integration suite
  // ('store data error → gate fatal'), which the no-op-pipe mock cannot drive.

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

  // NOTE: the old backpressure/onHead-return-value piping logic in onShellReady (write()-fallback,
  // drain-waiting, onHead-returns-false) was removed in R1-01. React now always pipes into the
  // delegating end-gate, and React ITSELF drives backpressure against the real writable (write()'s
  // boolean return + a 'drain' listener it attaches through the sink). That real drain path — and
  // the deferred end() / abort-mid-wait races — are covered against real react-dom/server in the
  // integration suite ('backpressure: a paused tiny-highWaterMark sink …', 'abort during the
  // deferred-end wait …'); the no-op-pipe mock here cannot exercise byte flow.

  it('onShellReady: a throwing onHead is FATAL (required callback) — onError + fatalAbort, nothing piped', async () => {
    const { writable } = makeWritable();
    const onError = vi.fn();

    const { renderStream } = createRenderer<any>({
      appComponent: () => <div />,
      headContent: () => '<head/>',
    });

    const onHead = vi.fn(() => {
      throw new Error('head-cb boom');
    });
    const { done } = renderStream(writable as any, { onHead, onError }, {}, '/onhead-throws');

    const opts = (RDS as any).__getLastOpts();
    // onHead commits the response head + connects the sink; a throw enters the fatal path and must
    // NOT leave the response half-committed — the renderer returns BEFORE piping.
    expect(() => opts.onShellReady()).not.toThrow();

    const streamInstance = (RDS.renderToPipeableStream as any).mock.results.at(-1)!.value;
    expect(streamInstance.pipe).not.toHaveBeenCalled();

    const ctrl = (Streaming.createStreamController as any).mock.results.at(-1)!.value;
    expect(ctrl.fatalAbort).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await expect(done).rejects.toThrow('head-cb boom');
  });
});
