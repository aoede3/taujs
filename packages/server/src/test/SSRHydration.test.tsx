import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mock } from 'vitest';
import { hydrateApp } from '../SSRHydration';
import { createSSRStore } from '../SSRDataStore';
import { createLogger } from '../utils/Logger';

vi.mock('react-dom/client', () => ({
  hydrateRoot: vi.fn(),
}));

vi.mock('../SSRDataStore', () => ({
  createSSRStore: vi.fn(),
  SSRStoreProvider: ({ children }: any) => <>{children}</>,
}));

vi.mock('../utils/Logger', () => ({
  createLogger: vi.fn(),
}));

declare global {
  interface Window {
    __INITIAL_DATA__?: Record<string, unknown>;
    __CUSTOM_DATA__?: any;
  }
}

describe('hydrateApp', () => {
  let logMock: any;
  let warnMock: any;
  let errorMock: any;
  let appComponent: React.ReactElement;

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
  });

  afterEach(() => {
    vi.clearAllMocks();
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

    expect(warnMock).toHaveBeenCalledWith('Initial data key "__INITIAL_DATA__" is undefined on window.');
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

  it('should use custom rootElementId if provided', () => {
    const customId = 'custom-root';
    const mockElement = document.createElement('div');
    mockElement.id = customId;
    document.body.appendChild(mockElement);

    hydrateApp({ appComponent, rootElementId: customId });

    expect(logMock).toHaveBeenCalledWith('Hydration started');
    expect(hydrateRoot).toHaveBeenCalledWith(mockElement, expect.anything());
  });

  it('should use custom initialDataKey if provided', () => {
    const mockElement = document.createElement('div');
    mockElement.id = 'root';
    document.body.appendChild(mockElement);

    window.__CUSTOM_DATA__ = { custom: 'data' };

    hydrateApp({ appComponent, initialDataKey: '__CUSTOM_DATA__' });

    expect(logMock).toHaveBeenCalledWith('Initial data loaded:', { custom: 'data' });
  });
});
