import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateApp } from '../SSRHydration';
import { createSSRStore } from '../SSRDataStore';
import { createLogger } from '../utils/Logger';

import type { Mock } from 'vitest';

vi.mock('react-dom/client', () => {
  const mockRender = vi.fn();
  return {
    hydrateRoot: vi.fn(),
    createRoot: vi.fn(() => ({
      render: mockRender,
    })),
  };
});

vi.mock('../SSRDataStore', () => ({
  createSSRStore: vi.fn(),
  SSRStoreProvider: ({ children }: Record<string, unknown>) => <>{children}</>,
}));

vi.mock('../utils/Logger', () => ({
  createLogger: vi.fn(),
}));

declare global {
  interface Window {
    __INITIAL_DATA__?: Record<string, unknown>;
    __CUSTOM_DATA__?: Record<string, unknown>;
  }
}

describe('hydrateApp', () => {
  let logMock: Mock<() => void>;
  let warnMock: Mock<() => void>;
  let errorMock: Mock<() => void>;
  let appComponent: React.ReactElement;
  let mockRender: Mock;

  beforeEach(() => {
    logMock = vi.fn();
    warnMock = vi.fn();
    errorMock = vi.fn();
    appComponent = <div>Test Component</div>;

    (createLogger as unknown as Mock).mockReturnValue({
      log: logMock,
      warn: warnMock,
      error: errorMock,
    });

    mockRender = vi.fn();
    (createRoot as Mock).mockReturnValue({ render: mockRender });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('should log and hydrate when root element and initial data are present', () => {
    const mockElement = document.createElement('div');
    mockElement.id = 'root';
    document.body.appendChild(mockElement);

    window.__INITIAL_DATA__ = { some: 'data' };

    hydrateApp({ appComponent });

    expect(logMock).toHaveBeenCalledWith('Hydration started');
    expect(logMock).toHaveBeenCalledWith('Initial data loaded:', { some: 'data' });
    expect(createSSRStore).toHaveBeenCalledWith(Promise.resolve({ some: 'data' }));
    expect(hydrateRoot).toHaveBeenCalledWith(mockElement, expect.anything());
    expect(logMock).toHaveBeenCalledWith('Hydration completed');
  });

  it('should warn if initial data key is undefined on window', () => {
    const mockElement = document.createElement('div');
    mockElement.id = 'root';
    document.body.appendChild(mockElement);

    delete window.__INITIAL_DATA__;

    hydrateApp({ appComponent });

    expect(warnMock).toHaveBeenCalledWith('Initial data key "__INITIAL_DATA__" is undefined on window. Defaulting to SPA createRoot');
    expect(createRoot).toHaveBeenCalledWith(mockElement);
    expect(mockRender).toHaveBeenCalledWith(<React.StrictMode>{appComponent}</React.StrictMode>);
  });

  it('should log an error if root element is not found', () => {
    const getElementByIdSpy = vi.spyOn(document, 'getElementById').mockReturnValue(null);

    hydrateApp({ appComponent });

    expect(errorMock).toHaveBeenCalledWith('Root element with id "root" not found.');

    getElementByIdSpy.mockRestore();
  });

  it('should defer hydration until DOMContentLoaded if document is still loading', () => {
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');

    hydrateApp({ appComponent });

    expect(addEventListenerSpy).toHaveBeenCalledWith('DOMContentLoaded', expect.any(Function));
  });

  it('should immediately bootstrap if document is already loaded', () => {
    const mockElement = document.createElement('div');
    mockElement.id = 'root';
    document.body.appendChild(mockElement);

    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');

    hydrateApp({ appComponent });

    expect(logMock).toHaveBeenCalledWith('Hydration started');
  });

  it('should use custom initialDataKey if provided', () => {
    const mockElement = document.createElement('div');
    mockElement.id = 'root';
    document.body.appendChild(mockElement);

    window.__CUSTOM_DATA__ = { custom: 'data' };

    hydrateApp({ appComponent, initialDataKey: '__CUSTOM_DATA__' });

    expect(logMock).toHaveBeenCalledWith('Initial data loaded:', { custom: 'data' });
  });

  it('should fallback to createRoot if hydrateRoot is unavailable', () => {
    const mockElement = document.createElement('div');
    mockElement.id = 'root';
    document.body.appendChild(mockElement);

    window.__INITIAL_DATA__ = undefined;

    hydrateApp({ appComponent });

    expect(createRoot).toHaveBeenCalledWith(mockElement);
    expect(mockRender).toHaveBeenCalledWith(<React.StrictMode>{appComponent}</React.StrictMode>);
  });

  it('should call bootstrap when DOMContentLoaded fires if document is loading', () => {
    const mockElement = document.createElement('div');
    mockElement.id = 'root';
    document.body.appendChild(mockElement);

    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

    hydrateApp({ appComponent });

    expect(addEventListenerSpy).toHaveBeenCalledWith('DOMContentLoaded', expect.any(Function));
  });
});
