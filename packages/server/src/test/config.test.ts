import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { extractBuildConfigs, extractRoutes } from '../config';

import type { PluginOption } from 'vite';
import type { TaujsConfig } from '../config';

describe('extractBuildConfigs', () => {
  it('maps basic config without plugins', () => {
    const input = {
      apps: [{ appId: 'app1', entryPoint: './entry.ts' }],
    };
    const result = extractBuildConfigs(input);
    expect(result).toEqual([{ appId: 'app1', entryPoint: './entry.ts', plugins: undefined }]);
  });

  it('preserves plugins in config', () => {
    const mockPlugin: PluginOption = {
      name: 'mock-plugin',
      transform(code) {
        return code;
      },
    };

    const input = {
      apps: [{ appId: 'app2', entryPoint: './entry2.ts', plugins: [mockPlugin] }],
    };

    const result = extractBuildConfigs(input);
    expect(result).toEqual([{ appId: 'app2', entryPoint: './entry2.ts', plugins: [mockPlugin] }]);
  });

  it('handles multiple apps', () => {
    const input = {
      apps: [
        { appId: 'a1', entryPoint: 'e1' },
        { appId: 'a2', entryPoint: 'e2', plugins: [] },
      ],
    };
    const result = extractBuildConfigs(input);
    expect(result).toHaveLength(2);
  });
});

describe('extractRoutes', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts routes and adds appId', () => {
    const config: TaujsConfig = {
      apps: [
        {
          appId: 'web',
          entryPoint: 'entry.ts',
          routes: [{ path: '/a' }, { path: '/b/c' }],
        },
      ],
    };
    const result = extractRoutes(config);
    expect(result).toEqual([
      { path: '/b/c', appId: 'web' },
      { path: '/a', appId: 'web' },
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Prepared 2 route(s)'));
  });

  it('handles empty routes', () => {
    const config: TaujsConfig = {
      apps: [{ appId: 'empty', entryPoint: 'e.ts' }],
    };
    const result = extractRoutes(config);
    expect(result).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0 route(s)'));
  });

  it('warns on duplicate paths across apps', () => {
    const config: TaujsConfig = {
      apps: [
        {
          appId: 'a1',
          entryPoint: 'e1',
          routes: [{ path: '/shared' }],
        },
        {
          appId: 'a2',
          entryPoint: 'e2',
          routes: [{ path: '/shared' }],
        },
      ],
    };
    const result = extractRoutes(config);
    expect(result).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('declared in multiple apps'));
  });

  it('sorts routes by depth', () => {
    const config: TaujsConfig = {
      apps: [
        {
          appId: 'sort',
          entryPoint: 'e',
          routes: [{ path: '/' }, { path: '/a' }, { path: '/a/b/c' }],
        },
      ],
    };
    const result = extractRoutes(config);
    expect(result).toHaveLength(3);
    expect(result[0]?.path).toBe('/a/b/c');
    expect(result[1]?.path).toBe('/a');
    expect(result[2]?.path).toBe('/');
  });

  it('logs and rethrows on failure', () => {
    const config: TaujsConfig = {
      apps: [
        {
          appId: 'faulty',
          entryPoint: 'entry.ts',
          get routes() {
            throw new Error('routes access failed');
          },
        } as any,
      ],
    };

    expect(() => extractRoutes(config)).toThrow('routes access failed');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to prepare routes'));
  });

  it('computes lower score for dynamic segments', () => {
    const config: TaujsConfig = {
      apps: [
        {
          appId: 'dynamic',
          entryPoint: 'e',
          routes: [{ path: '/user/:id' }, { path: '/user/profile' }],
        },
      ],
    };
    const result = extractRoutes(config);
    const paths = result.map((r) => r.path);

    expect(paths).toEqual(['/user/profile', '/user/:id']);
  });
});
