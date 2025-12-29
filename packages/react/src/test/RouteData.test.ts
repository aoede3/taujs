import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { RouteDataError, readInitialDataOnce, fetchRouteData, getCurrentPath } from '../RouteData';

describe('RouteDataError', () => {
  describe('constructor', () => {
    it('should create error with all properties', () => {
      const error = new RouteDataError('Test error', {
        status: 404,
        statusText: 'Not Found',
        code: 'ERR_NOT_FOUND',
        body: { detail: 'Resource not found' },
      });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RouteDataError);
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('RouteDataError');
      expect(error.status).toBe(404);
      expect(error.statusText).toBe('Not Found');
      expect(error.code).toBe('ERR_NOT_FOUND');
      expect(error.body).toEqual({ detail: 'Resource not found' });
    });

    it('should create error without optional properties', () => {
      const error = new RouteDataError('Simple error', {
        status: 500,
        statusText: 'Internal Server Error',
      });

      expect(error.message).toBe('Simple error');
      expect(error.status).toBe(500);
      expect(error.statusText).toBe('Internal Server Error');
      expect(error.code).toBeUndefined();
      expect(error.body).toBeUndefined();
    });

    it('should maintain proper prototype chain', () => {
      const error = new RouteDataError('Proto test', {
        status: 400,
        statusText: 'Bad Request',
      });

      expect(Object.getPrototypeOf(error)).toBe(RouteDataError.prototype);
      expect(error instanceof Error).toBe(true);
      expect(error instanceof RouteDataError).toBe(true);
    });

    it('should handle different status codes', () => {
      const codes = [400, 401, 403, 404, 422, 500, 502, 503, 504];

      codes.forEach((status) => {
        const error = new RouteDataError(`Error ${status}`, {
          status,
          statusText: `Status ${status}`,
        });
        expect(error.status).toBe(status);
      });
    });

    it('should handle complex body objects', () => {
      const complexBody = {
        error: 'Validation failed',
        errors: [
          { field: 'email', message: 'Invalid email' },
          { field: 'age', message: 'Must be positive' },
        ],
        timestamp: '2024-01-01T00:00:00Z',
        nested: { deep: { value: 123 } },
      };

      const error = new RouteDataError('Validation error', {
        status: 422,
        statusText: 'Unprocessable Entity',
        code: 'VALIDATION_ERROR',
        body: complexBody,
      });

      expect(error.body).toEqual(complexBody);
    });
  });

  describe('error properties', () => {
    it('should have readonly properties', () => {
      const error = new RouteDataError('Test', {
        status: 404,
        statusText: 'Not Found',
      });

      // These should be readonly - TypeScript will catch this, but we can verify they exist
      expect(error.status).toBe(404);
      expect(error.statusText).toBe('Not Found');
      expect(() => {
        (error as any).status = 500;
      }).not.toThrow(); // JS doesn't enforce readonly, but TS does
    });
  });
});

describe('readInitialDataOnce', () => {
  let originalWindow: any;

  beforeEach(() => {
    // Save original window
    originalWindow = global.window;
  });

  afterEach(() => {
    // Restore original window
    if (originalWindow === undefined) {
      delete (global as any).window;
    } else {
      (global as any).window = originalWindow;
    }
  });

  describe('server environment (no window)', () => {
    beforeEach(() => {
      delete (global as any).window;
    });

    it('should return null when window is undefined', () => {
      expect(typeof window).toBe('undefined');
      const result = readInitialDataOnce();
      expect(result).toBeNull();
    });

    it('should return null with type parameter', () => {
      type TestData = { foo: string; bar: number };
      const result = readInitialDataOnce<TestData>();
      expect(result).toBeNull();
    });
  });

  describe('client environment (with window)', () => {
    beforeEach(() => {
      (global as any).window = {};
    });

    it('should return null when __INITIAL_DATA__ is undefined', () => {
      const result = readInitialDataOnce();
      expect(result).toBeNull();
    });

    it('should return null when __INITIAL_DATA__ is null', () => {
      (global.window as any).__INITIAL_DATA__ = null;
      const result = readInitialDataOnce();
      expect(result).toBeNull();
    });

    it('should return initial data when present', () => {
      const testData = { userId: 123, name: 'Test User' };
      (global.window as any).__INITIAL_DATA__ = testData;

      const result = readInitialDataOnce();
      expect(result).toEqual(testData);
    });

    it('should delete __INITIAL_DATA__ after first read', () => {
      const testData = { count: 42 };
      (global.window as any).__INITIAL_DATA__ = testData;

      const firstRead = readInitialDataOnce();
      expect(firstRead).toEqual(testData);
      expect((global.window as any).__INITIAL_DATA__).toBeUndefined();

      const secondRead = readInitialDataOnce();
      expect(secondRead).toBeNull();
    });

    it('should handle complex nested data structures', () => {
      const complexData = {
        user: {
          id: 1,
          profile: {
            name: 'John',
            settings: {
              theme: 'dark',
              notifications: true,
            },
          },
        },
        items: [1, 2, 3],
        metadata: {
          timestamp: '2024-01-01',
        },
      };
      (global.window as any).__INITIAL_DATA__ = complexData;

      const result = readInitialDataOnce();
      expect(result).toEqual(complexData);
    });

    it('should handle typed data correctly', () => {
      type UserData = {
        id: number;
        email: string;
        roles: string[];
      };

      const userData: UserData = {
        id: 456,
        email: 'test@example.com',
        roles: ['user', 'admin'],
      };
      (global.window as any).__INITIAL_DATA__ = userData;

      const result = readInitialDataOnce<UserData>();
      expect(result).toEqual(userData);
      expect(result?.id).toBe(456);
      expect(result?.roles).toContain('admin');
    });

    it('should handle empty object', () => {
      (global.window as any).__INITIAL_DATA__ = {};
      const result = readInitialDataOnce();
      expect(result).toEqual({});
    });

    it('should handle arrays', () => {
      const arrayData = [1, 2, 3, 4, 5];
      (global.window as any).__INITIAL_DATA__ = arrayData;
      const result = readInitialDataOnce();
      expect(result).toEqual(arrayData);
    });

    it('should handle primitives in data', () => {
      const data = {
        str: 'string',
        num: 123,
        bool: true,
        nul: null,
        undef: undefined,
      };
      (global.window as any).__INITIAL_DATA__ = data;
      const result = readInitialDataOnce();
      expect(result).toEqual(data);
    });
  });
});

describe('fetchRouteData', () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parameter validation', () => {
    it('should throw error when pathname is empty string', async () => {
      await expect(fetchRouteData('')).rejects.toThrow('fetchRouteData: pathname is required');
    });

    it('should throw error when pathname is not provided', async () => {
      await expect(fetchRouteData(null as any)).rejects.toThrow('fetchRouteData: pathname is required');
    });

    it('should throw error when pathname is undefined', async () => {
      await expect(fetchRouteData(undefined as any)).rejects.toThrow('fetchRouteData: pathname is required');
    });
  });

  describe('successful requests', () => {
    it('should fetch data from correct URL', async () => {
      const mockData = { userId: 123, name: 'Test' };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockData }),
      });

      await fetchRouteData('/app/dashboard');

      expect(fetchMock).toHaveBeenCalledWith(
        '/__taujs/route?url=%2Fapp%2Fdashboard',
        expect.objectContaining({
          credentials: 'include',
        }),
      );
    });

    it('should return data from response', async () => {
      const mockData = { count: 42, items: [1, 2, 3] };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockData }),
      });

      const result = await fetchRouteData('/app/items');
      expect(result).toEqual(mockData);
    });

    it('should handle URLs with query parameters', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await fetchRouteData('/app/search?q=test&page=2');

      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('url=%2Fapp%2Fsearch%3Fq%3Dtest%26page%3D2'), expect.any(Object));
    });

    it('should handle URLs with special characters', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await fetchRouteData('/app/user/@john+doe/profile');

      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('__taujs/route?url='), expect.any(Object));
    });

    it('should return empty object when data is undefined', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await fetchRouteData('/app/empty');
      expect(result).toEqual({});
    });

    it('should return empty object when data is null', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: null }),
      });

      const result = await fetchRouteData('/app/null');
      expect(result).toEqual({});
    });

    it('should handle typed responses', async () => {
      type UserProfile = {
        id: number;
        email: string;
        verified: boolean;
      };

      const mockData: UserProfile = {
        id: 789,
        email: 'user@test.com',
        verified: true,
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockData }),
      });

      const result = await fetchRouteData<UserProfile>('/app/profile');
      expect(result.id).toBe(789);
      expect(result.email).toBe('user@test.com');
      expect(result.verified).toBe(true);
    });

    it('should merge custom init options', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await fetchRouteData('/app/test', {
        headers: {
          'X-Custom-Header': 'value',
        },
        signal: new AbortController().signal,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          credentials: 'include',
          headers: {
            'X-Custom-Header': 'value',
          },
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('should not override credentials option', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      // Try to override credentials - should still be 'include'
      await fetchRouteData('/app/test', {
        credentials: 'omit' as any,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          credentials: 'omit', // init options override defaults
        }),
      );
    });
  });

  describe('error handling', () => {
    it('should throw RouteDataError on 404', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({
          error: 'Resource not found',
          statusText: 'Not Found',
          code: 'NOT_FOUND',
        }),
      });

      await expect(fetchRouteData('/app/missing')).rejects.toMatchObject({
        name: 'RouteDataError',
        message: 'Resource not found',
        status: 404,
        statusText: 'Not Found',
        code: 'NOT_FOUND',
      });
    });

    it('should throw RouteDataError on 500', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({
          error: 'Server error',
        }),
      });

      await expect(fetchRouteData('/app/error')).rejects.toMatchObject({
        status: 500,
        message: 'Server error',
      });
    });

    it('should handle non-JSON error responses', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new Error('Not JSON');
        },
        text: async () => 'Gateway timeout',
      });

      await expect(fetchRouteData('/app/gateway')).rejects.toMatchObject({
        status: 502,
        body: { error: 'Gateway timeout' },
      });
    });

    it('should handle text() failure with empty string', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => {
          throw new Error('Not JSON');
        },
        text: async () => {
          throw new Error('Cannot read text');
        },
      });

      await expect(fetchRouteData('/app/unavailable')).rejects.toMatchObject({
        status: 503,
        body: { error: '' },
      });
    });

    it('should use default message when error field is missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          statusText: 'Bad Request',
        }),
      });

      await expect(fetchRouteData('/app/bad')).rejects.toMatchObject({
        message: 'Request failed: 400',
        status: 400,
      });
    });

    it('should use response statusText as fallback', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({}),
      });

      await expect(fetchRouteData('/app/forbidden')).rejects.toMatchObject({
        statusText: 'Forbidden',
      });
    });

    it('should handle complex error body', async () => {
      const errorBody = {
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        statusText: 'Unprocessable Entity',
        errors: [
          { field: 'email', message: 'Invalid format' },
          { field: 'password', message: 'Too weak' },
        ],
      };

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => errorBody,
      });

      try {
        await fetchRouteData('/app/validate');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RouteDataError);
        const error = err as RouteDataError;
        expect(error.status).toBe(422);
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.body).toEqual(errorBody);
      }
    });

    it('should handle network errors', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network failure'));

      await expect(fetchRouteData('/app/network')).rejects.toThrow('Network failure');
    });

    it('should handle different HTTP error codes', async () => {
      const errorCodes = [400, 401, 403, 404, 422, 429, 500, 502, 503, 504];

      for (const status of errorCodes) {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status,
          statusText: `Status ${status}`,
          json: async () => ({
            error: `Error ${status}`,
          }),
        });

        await expect(fetchRouteData(`/app/error-${status}`)).rejects.toMatchObject({
          status,
          message: `Error ${status}`,
        });
      }
    });
  });

  describe('edge cases', () => {
    it('should handle root path', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { page: 'home' } }),
      });

      await fetchRouteData('/');
      expect(fetchMock).toHaveBeenCalledWith('/__taujs/route?url=%2F', expect.any(Object));
    });

    it('should handle deeply nested paths', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await fetchRouteData('/app/dashboard/analytics/reports/quarterly/2024/q1');
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('__taujs/route?url='), expect.any(Object));
    });

    it('should handle paths with hash (though hash not sent)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await fetchRouteData('/app/page#section');
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('page%23section'), expect.any(Object));
    });

    it('should preserve trailing slashes', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await fetchRouteData('/app/page/');
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('%2Fapp%2Fpage%2F'), expect.any(Object));
    });
  });
});

describe('getCurrentPath', () => {
  let originalWindow: any;

  beforeEach(() => {
    originalWindow = global.window;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as any).window;
    } else {
      (global as any).window = originalWindow;
    }
  });

  describe('server environment', () => {
    beforeEach(() => {
      delete (global as any).window;
    });

    it('should return null when window is undefined', () => {
      expect(typeof window).toBe('undefined');
      const result = getCurrentPath();
      expect(result).toBeNull();
    });
  });

  describe('client environment', () => {
    beforeEach(() => {
      (global as any).window = {
        location: {
          pathname: '/app/dashboard',
          search: '?tab=overview',
        },
      };
    });

    it('should return pathname and search combined', () => {
      const result = getCurrentPath();
      expect(result).toBe('/app/dashboard?tab=overview');
    });

    it('should return pathname only when no search', () => {
      (global.window as any).location.search = '';
      const result = getCurrentPath();
      expect(result).toBe('/app/dashboard');
    });

    it('should return root path', () => {
      (global.window as any).location.pathname = '/';
      (global.window as any).location.search = '';
      const result = getCurrentPath();
      expect(result).toBe('/');
    });

    it('should handle complex query strings', () => {
      (global.window as any).location.pathname = '/search';
      (global.window as any).location.search = '?q=test&filter=active&sort=date&page=2';
      const result = getCurrentPath();
      expect(result).toBe('/search?q=test&filter=active&sort=date&page=2');
    });

    it('should handle special characters in path', () => {
      (global.window as any).location.pathname = '/users/@john/posts';
      (global.window as any).location.search = '?id=123';
      const result = getCurrentPath();
      expect(result).toBe('/users/@john/posts?id=123');
    });

    it('should not include hash', () => {
      (global.window as any).location.pathname = '/app/page';
      (global.window as any).location.search = '?foo=bar';
      (global.window as any).location.hash = '#section';
      const result = getCurrentPath();
      expect(result).toBe('/app/page?foo=bar');
    });

    it('should handle encoded characters', () => {
      (global.window as any).location.pathname = '/path%20with%20spaces';
      (global.window as any).location.search = '?key=value%20encoded';
      const result = getCurrentPath();
      expect(result).toBe('/path%20with%20spaces?key=value%20encoded');
    });

    it('should handle multiple consecutive calls', () => {
      const first = getCurrentPath();
      const second = getCurrentPath();
      const third = getCurrentPath();

      expect(first).toBe('/app/dashboard?tab=overview');
      expect(second).toBe('/app/dashboard?tab=overview');
      expect(third).toBe('/app/dashboard?tab=overview');
    });

    it('should handle empty search string (with ?)', () => {
      (global.window as any).location.pathname = '/app';
      (global.window as any).location.search = '?';
      const result = getCurrentPath();
      expect(result).toBe('/app?');
    });

    it('should handle nested paths', () => {
      (global.window as any).location.pathname = '/a/b/c/d/e/f';
      (global.window as any).location.search = '?x=1';
      const result = getCurrentPath();
      expect(result).toBe('/a/b/c/d/e/f?x=1');
    });
  });
});

describe('Integration scenarios', () => {
  let fetchMock: any;
  let originalWindow: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    originalWindow = global.window;
    (global as any).window = {
      location: {
        pathname: '/app/dashboard',
        search: '?tab=overview',
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) {
      delete (global as any).window;
    } else {
      (global as any).window = originalWindow;
    }
  });

  it('should read initial data first, then fetch on second call', async () => {
    // Set initial data
    const initialData = { initial: true, count: 1 };
    (global.window as any).__INITIAL_DATA__ = initialData;

    // First call: read from window
    const first = readInitialDataOnce();
    expect(first).toEqual(initialData);

    // Second call: should return null
    const second = readInitialDataOnce();
    expect(second).toBeNull();

    // Now fetch would be needed
    const fetchedData = { initial: false, count: 2 };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: fetchedData }),
    });

    const fetched = await fetchRouteData('/app/dashboard');
    expect(fetched).toEqual(fetchedData);
  });

  it('should use getCurrentPath with fetchRouteData', async () => {
    const currentPath = getCurrentPath();
    expect(currentPath).toBe('/app/dashboard?tab=overview');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { fromPath: currentPath } }),
    });

    const data = await fetchRouteData(currentPath!);
    expect(data).toEqual({ fromPath: currentPath });
  });

  it('should handle complete SSR hydration flow', async () => {
    // SSR: data injected in window
    const ssrData = { user: { id: 1, name: 'John' }, isSSR: true };
    (global.window as any).__INITIAL_DATA__ = ssrData;

    // Client: read initial data
    const hydrated = readInitialDataOnce();
    expect(hydrated).toEqual(ssrData);

    // Navigate to new page
    (global.window as any).location.pathname = '/app/profile';
    (global.window as any).location.search = '';

    // No initial data on new page
    const noData = readInitialDataOnce();
    expect(noData).toBeNull();

    // Fetch for new page
    const newPath = getCurrentPath();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { user: { id: 1, name: 'John' }, isSSR: false } }),
    });

    const fetchedData = await fetchRouteData(newPath!);
    expect(fetchedData.isSSR).toBe(false);
  });

  it('should handle error recovery flow', async () => {
    // Initial data is corrupted/missing
    (global.window as any).__INITIAL_DATA__ = null;
    const initial = readInitialDataOnce();
    expect(initial).toBeNull();

    // Fetch fails first time
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'Server error' }),
    });

    try {
      await fetchRouteData('/app/data');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RouteDataError);
    }

    // Retry succeeds
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { recovered: true } }),
    });

    const recovered = await fetchRouteData('/app/data');
    expect(recovered).toEqual({ recovered: true });
  });
});
