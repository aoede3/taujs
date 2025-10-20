// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

vi.mock('react-dom/client', () => {
  let capturedRecoverable: ((err: any, info: any) => void) | undefined;

  const hydrateRoot = vi.fn((el: any, node: any, opts?: { onRecoverableError?: (e: any, info?: any) => void }) => {
    capturedRecoverable = opts?.onRecoverableError;
    return {}; // ReactRoot-ish
  });

  const createRoot = vi.fn((el: any) => {
    return { render: vi.fn() };
  });

  return {
    hydrateRoot,
    createRoot,
    __getCapturedRecoverable: () => capturedRecoverable,
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
  });

  afterEach(() => vi.restoreAllMocks());

  it('hydrates successfully; calls onStart/onSuccess and wires recoverable handler', () => {
    const root = addRoot('root');
    (window as any).__INITIAL_DATA__ = { hello: 'world' };

    const log = vi.fn(),
      warn = vi.fn(),
      error = vi.fn();
    const onStart = vi.fn(),
      onSuccess = vi.fn();

    hydrateApp({
      appComponent: <div>App</div>,
      debug: true,
      logger: { log, warn, error },
      onStart,
      onSuccess,
    });

    // logs + store + hydrate
    expect(log).toHaveBeenCalledWith('Hydration started');
    expect(Store.createSSRStore).toHaveBeenCalledWith({ hello: 'world' });
    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
    expect((RDC.hydrateRoot as any).mock.calls[0]![0]).toBe(root);

    // recoverable error path
    const getRec = (RDC as any).__getCapturedRecoverable as () => ((e: any, info: any) => void) | undefined;
    const rec = getRec();
    expect(typeof rec).toBe('function');
    rec?.(new Error('rec'), { digest: 'x' });
    expect(warn).toHaveBeenCalledWith('Recoverable hydration error:', expect.any(Error), expect.objectContaining({ digest: 'x' }));

    // finished
    expect(log).toHaveBeenCalledWith('Hydration completed');
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    // no CSR here
    expect(RDC.createRoot).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('logs error and aborts when root element is missing', () => {
    (window as any).__INITIAL_DATA__ = { a: 1 };
    const error = vi.fn();

    hydrateApp({ appComponent: <div>App</div>, debug: true, logger: { error } });

    expect(error).toHaveBeenCalledWith('Root element with id "root" not found.');
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();
    expect(RDC.createRoot).not.toHaveBeenCalled();
  });

  it('hard hydration error → logs, calls onHydrationError, warns, falls back to CSR (clears HTML)', () => {
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
      debug: true,
      logger: { warn, error },
      onHydrationError,
    });

    expect(error).toHaveBeenCalledTimes(1);
    const [label, errObj] = (error as any).mock.calls[0]!;
    expect(label).toContain('Hydration error:');
    expect(errObj).toBeInstanceOf(Error);
    expect((errObj as Error).message).toBe('kaboom');

    expect(onHydrationError).toHaveBeenCalledWith(expect.any(Error));
    expect(warn).toHaveBeenCalledWith('Falling back to SPA rendering.');

    // CSR render happened and server HTML cleared
    expect(root.innerHTML).toBe('');
    expect(RDC.createRoot).toHaveBeenCalledWith(root);
    const rootInstance = (RDC.createRoot as any).mock.results[0]!.value;
    expect(rootInstance.render).toBeTypeOf('function');
    expect(rootInstance.render).toHaveBeenCalledTimes(1);
  });

  it('no SSR data → mounts CSR immediately; logs warn in debug; does NOT call hydrate', () => {
    const root = addRoot();
    root.innerHTML = '<i>server-stuff</i>';

    const warn = vi.fn(),
      log = vi.fn();
    const addSpy = vi.spyOn(window, 'addEventListener');

    hydrateApp({ appComponent: <div>App</div>, debug: true, logger: { warn, log } });

    expect(warn).toHaveBeenCalledWith('No initial SSR data at window["__INITIAL_DATA__"]. Mounting CSR.');
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();

    // CSR render path
    expect(root.innerHTML).toBe('');
    expect(RDC.createRoot).toHaveBeenCalledWith(root);
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
    hydrateApp({ appComponent: <div>App</div>, debug: true });

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
      debug: true,
      logger: { error, log },
    });

    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
    expect((RDC.hydrateRoot as any).mock.calls[0]![0]).toBe(el);
    expect(Store.createSSRStore).toHaveBeenCalledWith({ z: 9 });
    expect(log).toHaveBeenCalledWith('Hydration started');
    expect(error).not.toHaveBeenCalled();
  });

  it('does NOT call onStart/onSuccess in CSR mode (no SSR data)', () => {
    addRoot();
    const onStart = vi.fn(),
      onSuccess = vi.fn();
    hydrateApp({ appComponent: <div>App</div>, onStart, onSuccess });

    expect(onStart).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(RDC.createRoot).toHaveBeenCalledTimes(1);
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();
  });
});
