// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

vi.mock('react-dom/client', () => {
  let hydrateOpts: any;
  let createOpts: any;

  const hydrateRoot = vi.fn((el: any, node: any, opts?: any) => {
    hydrateOpts = opts;
    return {}; // ReactRoot-ish
  });

  const createRoot = vi.fn((el: any, opts?: any) => {
    createOpts = opts;
    return { render: vi.fn() };
  });

  return {
    hydrateRoot,
    createRoot,
    __getHydrateOpts: () => hydrateOpts,
    __getCreateOpts: () => createOpts,
  };
});

vi.mock('../SSRDataStore', () => {
  const createSSRStore = vi.fn((data: any) => ({ __store: data }));
  const SSRStoreProvider = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return { createSSRStore, SSRStoreProvider };
});

import { hydrateApp } from '../SSRHydration';
import * as RDC from 'react-dom/client';
import * as Store from '../SSRDataStore';

function setReadyState(state: DocumentReadyState) {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => state });
}

function resetDom() {
  document.body.innerHTML = '';
  (window as any).__INITIAL_DATA__ = undefined;
}

function addRoot(id = 'root') {
  const el = document.createElement('div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

describe('hydrateApp (lean bootstrap: hydrate if data, else CSR)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDom();
    setReadyState('complete');
    // jsdom lacks globalThis.reportError; stub it present so the renderer's global-surfacing takes the
    // reportError branch instead of dispatching an unhandled window 'error' event (which fails the run).
    (globalThis as { reportError?: unknown }).reportError = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { reportError?: unknown }).reportError;
  });

  it('hydrates: onStart fires, root-error adapter wired to hydrateRoot; success is DEFERRED to first commit (not sync)', () => {
    const root = addRoot('root');
    (window as any).__INITIAL_DATA__ = { hello: 'world' };

    const log = vi.fn(),
      warn = vi.fn(),
      error = vi.fn();
    const onStart = vi.fn(),
      onSuccess = vi.fn();

    hydrateApp({
      appComponent: <div>App</div>,
      enableDebug: true,
      logger: { log, warn, error },
      onStart,
      onSuccess,
    });

    // logs + store + hydrate
    expect(log).toHaveBeenCalledWith('Hydration started');
    expect(Store.createSSRStore).toHaveBeenCalledWith({ hello: 'world' });
    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
    expect((RDC.hydrateRoot as any).mock.calls[0]![0]).toBe(root);

    // R2-01: the single root-error adapter is wired — all three handlers present.
    const opts = (RDC as any).__getHydrateOpts();
    expect(typeof opts.onUncaughtError).toBe('function');
    expect(typeof opts.onCaughtError).toBe('function');
    expect(typeof opts.onRecoverableError).toBe('function');
    // recoverable → warn (log-only, never a failure)
    opts.onRecoverableError(new Error('rec'), { digest: 'x' });
    expect(warn).toHaveBeenCalledWith('Recoverable hydration error:', expect.any(Error), expect.objectContaining({ digest: 'x' }));

    expect(onStart).toHaveBeenCalledTimes(1);
    // Success is now a first-COMMIT signal (reporter effect). The no-op mock never commits, so
    // onSuccess has NOT fired synchronously — the real commit path is covered in the integration suite.
    expect(onSuccess).not.toHaveBeenCalled();

    // no CSR here
    expect(RDC.createRoot).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('never logs the route-data payload or store object, even with enableDebug (no disclosure through the logger)', () => {
    addRoot('root');
    const SECRET = 'super-secret-token-9f3a';
    (window as any).__INITIAL_DATA__ = { token: SECRET, nested: { x: SECRET } };
    const log = vi.fn(),
      warn = vi.fn(),
      error = vi.fn();

    hydrateApp({ appComponent: <div>App</div>, enableDebug: true, logger: { log, warn, error } });

    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    expect(logged).not.toContain(SECRET);
  });

  it('a throwing onStart is isolated — hydration still proceeds to hydrateRoot (single-settlement intact)', () => {
    addRoot('root');
    (window as any).__INITIAL_DATA__ = { a: 1 };
    const onStart = () => {
      throw new Error('onStart-boom');
    };

    expect(() => hydrateApp({ appComponent: <div>App</div>, logger: { error: vi.fn() }, onStart })).not.toThrow();
    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1); // reached despite the throw
  });

  it('failure-then-late-failure: a second uncaught error is telemetry only (one onHydrationError, one beacon)', () => {
    addRoot('root');
    (window as any).__INITIAL_DATA__ = { a: 1 };
    const emit = vi.fn();
    (window as any).__TAUJS_DEVTOOLS_HOOK__ = { emit };
    const onHydrationError = vi.fn();

    hydrateApp({ appComponent: <div>App</div>, logger: { error: vi.fn() }, onHydrationError });

    // Drive the captured root adapter twice — React can surface more than one root error.
    const opts = (RDC as any).__getHydrateOpts();
    opts.onUncaughtError(new Error('first'), {});
    opts.onUncaughtError(new Error('second'), {});

    expect(onHydrationError).toHaveBeenCalledTimes(1); // settled once
    expect((onHydrationError.mock.calls[0]![0] as Error).message).toBe('first');
    expect(emit.mock.calls.filter((c: any[]) => c[0] === 'hydration:error')).toHaveLength(1);

    delete (window as any).__TAUJS_DEVTOOLS_HOOK__;
  });

  it('R2-04: identifierPrefix reaches BOTH roots - hydrateRoot (data present) and createRoot (CSR fallback)', () => {
    // hydrate path
    addRoot('root');
    (window as any).__INITIAL_DATA__ = { a: 1 };
    hydrateApp({ appComponent: <div>App</div>, identifierPrefix: 'hyd-' });
    expect((RDC as any).__getHydrateOpts()).toEqual(expect.objectContaining({ identifierPrefix: 'hyd-' }));
    expect(RDC.createRoot).not.toHaveBeenCalled();

    // CSR fallback path (no SSR data) - the option must reach createRoot too, else two CSR roots on
    // one page collide on useId. Removing it from only this call would otherwise leave tests green.
    vi.clearAllMocks();
    resetDom();
    addRoot('root');
    (window as any).__INITIAL_DATA__ = undefined;
    hydrateApp({ appComponent: <div>App</div>, identifierPrefix: 'csr-' });
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();
    expect((RDC as any).__getCreateOpts()).toEqual(expect.objectContaining({ identifierPrefix: 'csr-' }));
    expect(RDC.createRoot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ identifierPrefix: 'csr-' }));
  });

  it('logs error and aborts when root element is missing', () => {
    (window as any).__INITIAL_DATA__ = { a: 1 };
    const error = vi.fn();

    hydrateApp({ appComponent: <div>App</div>, enableDebug: true, logger: { error } });

    expect(error).toHaveBeenCalledWith('Root element with id "root" not found.');
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();
    expect(RDC.createRoot).not.toHaveBeenCalled();
  });

  it('hard hydration error → logs, calls onHydrationError', () => {
    const root = addRoot('root');
    (window as any).__INITIAL_DATA__ = { a: 2 };
    root.innerHTML = '<span>pre</span>';

    // Make hydrateRoot throw
    (RDC.hydrateRoot as any).mockImplementationOnce((_el: any, _node: any, _opts?: any) => {
      throw new Error('kaboom');
    });

    const warn = vi.fn(),
      error = vi.fn(),
      onHydrationError = vi.fn();

    hydrateApp({
      appComponent: <div>App</div>,
      enableDebug: true,
      logger: { warn, error },
      onHydrationError,
    });

    expect(error).toHaveBeenCalledTimes(1);
    const [label, errObj] = (error as any).mock.calls[0]!;
    expect(label).toContain('Hydration error:');
    expect(errObj).toBeInstanceOf(Error);
    expect((errObj as Error).message).toBe('kaboom');

    expect(onHydrationError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('no SSR data → mounts CSR immediately; logs warn in debug; does NOT call hydrate', () => {
    const root = addRoot();
    root.innerHTML = '<i>server-stuff</i>';

    const warn = vi.fn(),
      log = vi.fn();
    const addSpy = vi.spyOn(window, 'addEventListener');

    hydrateApp({ appComponent: <div>App</div>, enableDebug: true, logger: { warn, log } });

    expect(warn).toHaveBeenCalledWith('No initial SSR data at window["__INITIAL_DATA__"]. Mounting CSR.');
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();

    // CSR render path — createRoot receives the root-error adapter (R2-01)
    expect(root.innerHTML).toBe('');
    expect(RDC.createRoot).toHaveBeenCalledWith(root, expect.objectContaining({ onUncaughtError: expect.any(Function) }));
    const rootInstance = (RDC.createRoot as any).mock.results[0]!.value;
    expect(rootInstance.render).toHaveBeenCalledTimes(1);

    // No waiting for custom window events in new code
    expect(addSpy).not.toHaveBeenCalledWith('taujs:data-ready', expect.any(Function), expect.anything());
  });

  it('defers to DOMContentLoaded when document is still loading (once)', () => {
    setReadyState('loading');
    const root = addRoot();
    (window as any).__INITIAL_DATA__ = { soon: true };

    const addSpy = vi.spyOn(document, 'addEventListener');
    hydrateApp({ appComponent: <div>App</div>, enableDebug: true });

    // defers
    expect(addSpy).toHaveBeenCalled();
    const [eventName, cb, opts] = addSpy.mock.calls[0]!;
    expect(eventName).toBe('DOMContentLoaded');
    // ensure once:true is set
    expect(opts).toEqual({ once: true });

    // fire it
    (cb as EventListener)(new Event('DOMContentLoaded'));

    // hydration occurs after DOM ready
    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
    expect((RDC.hydrateRoot as any).mock.calls[0]![0]).toBe(root);
  });

  it('supports custom rootElementId and dataKey', () => {
    const el = addRoot('app');
    (window as any).FOO_DATA = { z: 9 };

    const error = vi.fn(),
      log = vi.fn();

    hydrateApp({
      appComponent: <div>App</div>,
      rootElementId: 'app',
      dataKey: 'FOO_DATA',
      enableDebug: true,
      logger: { error, log },
    });

    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
    expect((RDC.hydrateRoot as any).mock.calls[0]![0]).toBe(el);
    expect(Store.createSSRStore).toHaveBeenCalledWith({ z: 9 });
    expect(log).toHaveBeenCalledWith('Hydration started');
    expect(error).not.toHaveBeenCalled();
  });

  it('CSR mode: onStart never fires; onSuccess is deferred to first commit (not synchronous)', () => {
    addRoot();
    const onStart = vi.fn(),
      onSuccess = vi.fn();
    hydrateApp({ appComponent: <div>App</div>, onStart, onSuccess });

    // onStart is a hydration-only signal (CSR is not a hydration). onSuccess IS emitted on the CSR
    // path — but on first commit, so the no-op mock never fires it (real commit tested in integration).
    expect(onStart).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(RDC.createRoot).toHaveBeenCalledTimes(1);
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();
  });

  it('no SSR data → mounts CSR with empty store; does NOT call hydrate', () => {
    const root = addRoot();
    root.innerHTML = '<i>server-stuff</i>';

    const warn = vi.fn();
    hydrateApp({ appComponent: <div>App</div>, enableDebug: true, logger: { warn } });

    expect(warn).toHaveBeenCalledWith('No initial SSR data at window["__INITIAL_DATA__"]. Mounting CSR.');

    expect(Store.createSSRStore).toHaveBeenCalledTimes(1);
    expect(Store.createSSRStore).toHaveBeenCalledWith({}); // the {} as T path

    expect(RDC.hydrateRoot).not.toHaveBeenCalled();
    expect(RDC.createRoot).toHaveBeenCalledWith(root, expect.objectContaining({ onUncaughtError: expect.any(Function) }));
  });
});
