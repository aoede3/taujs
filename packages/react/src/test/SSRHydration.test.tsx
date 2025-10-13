// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

vi.mock('react-dom/client', () => {
  let capturedRecoverable: ((err: any, info: any) => void) | undefined;

  const hydrateRoot = vi.fn((el: any, node: any, opts?: { onRecoverableError?: (e: any, info?: any) => void }) => {
    capturedRecoverable = opts?.onRecoverableError;
    return {};
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

describe('hydrateApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDom();
    setReadyState('complete');
  });

  afterEach(() => vi.restoreAllMocks());

  it('hydrates successfully; calls onStart/onSuccess and recoverable handler', () => {
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

    expect(log).toHaveBeenCalledWith('Hydration started with initial data');
    expect(Store.createSSRStore).toHaveBeenCalledWith({ hello: 'world' });
    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
    expect((RDC.hydrateRoot as any).mock.calls[0]![0]).toBe(root);

    // trigger recoverable hydration error
    const getRec = (RDC as any).__getCapturedRecoverable as () => ((e: any, info: any) => void) | undefined;
    const rec = getRec();
    expect(typeof rec).toBe('function');
    rec?.(new Error('rec'), { digest: 'x' });
    expect(warn).toHaveBeenCalledWith('Recoverable hydration error:', expect.any(Error), expect.objectContaining({ digest: 'x' }));

    expect(log).toHaveBeenCalledWith('Hydration completed');
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('logs error when root element is missing and aborts', () => {
    (window as any).__INITIAL_DATA__ = { a: 1 };
    const error = vi.fn();

    hydrateApp({ appComponent: <div>App</div>, debug: true, logger: { error } });

    expect(error).toHaveBeenCalledWith('Root element with id "root" not found.');
    expect(RDC.hydrateRoot).not.toHaveBeenCalled();
    expect(RDC.createRoot).not.toHaveBeenCalled();
  });

  it('throws during hydration and falls back to SPA render; calls onHydrationError and clears HTML', () => {
    const root = addRoot('root');
    (window as any).__INITIAL_DATA__ = { a: 2 };
    root.innerHTML = '<span>pre</span>';

    // Make hydrateRoot throw once
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

    expect(error).toHaveBeenCalledWith('Hydration error:', expect.any(Error));
    expect(onHydrationError).toHaveBeenCalledWith(expect.any(Error));
    expect(warn).toHaveBeenCalledWith('Falling back to SPA rendering.');

    expect(root.innerHTML).toBe('');
    expect(RDC.createRoot).toHaveBeenCalledWith(root);

    const result0 = (RDC.createRoot as any).mock.results[0]!.value;
    expect(result0.render).toBeTypeOf('function');
    expect(result0.render).toHaveBeenCalledTimes(1);
  });

  it('waits for data when none is present; starts after taujs:data-ready and removes the listener', () => {
    addRoot();
    const warn = vi.fn(),
      log = vi.fn();

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    hydrateApp({ appComponent: <div>App</div>, debug: true, logger: { warn, log } });

    expect(warn).toHaveBeenCalledWith('No initial SSR data found under key "__INITIAL_DATA__". Waiting for server data.');
    expect(addSpy).toHaveBeenCalled();
    const firstAdd = addSpy.mock.calls[0]!;
    expect(firstAdd[0]).toBe('taujs:data-ready');

    (window as any).__INITIAL_DATA__ = { later: true };
    const handler = firstAdd[1] as EventListener;
    handler(new Event('taujs:data-ready'));

    expect(removeSpy).toHaveBeenCalledWith('taujs:data-ready', handler);
    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Hydration started with initial data');
  });

  it('defers to DOMContentLoaded when document is still loading', () => {
    setReadyState('loading');
    addRoot();
    (window as any).__INITIAL_DATA__ = { soon: true };

    const addSpy = vi.spyOn(document, 'addEventListener');
    hydrateApp({ appComponent: <div>App</div>, debug: true });

    expect(addSpy).toHaveBeenCalled();
    const call = addSpy.mock.calls[0]!;
    expect(call[0]).toBe('DOMContentLoaded');

    const cb = call[1] as EventListener;
    cb(new Event('DOMContentLoaded'));

    expect(RDC.hydrateRoot).toHaveBeenCalledTimes(1);
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
    expect(log).toHaveBeenCalledWith('Hydration started with initial data');
    expect(error).not.toHaveBeenCalled();
  });
});
