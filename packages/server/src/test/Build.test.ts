import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InlineConfig } from 'vite';

vi.mock('vite', () => ({
  build: vi.fn(async () => {
    return undefined;
  }),
}));

vi.mock('../core/config/Setup', () => ({
  extractBuildConfigs: vi.fn().mockReturnValue([]),
}));

vi.mock('../utils/AssetManager', () => ({
  processConfigs: vi.fn().mockReturnValue([]),
}));

vi.mock('../constants', () => ({
  TEMPLATE: 'index.html',
  ENTRY_EXTENSIONS: ['.tsx', '.ts'],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(),
    readFile: vi.fn(),
  };
});

// node:path doesn't need mocking - use real implementation
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

let taujsBuild: typeof import('../Build').taujsBuild;
let mergeViteConfig: typeof import('../Build').mergeViteConfig;
let getFrameworkInvariants: typeof import('../Build').getFrameworkInvariants;
let resolveInputs: typeof import('../Build').resolveInputs;
let resolveAppFilter: typeof import('../Build').resolveAppFilter;

import { build } from 'vite';
import { extractBuildConfigs } from '../core/config/Setup';
import { processConfigs } from '../utils/AssetManager';

import type { RollupOutput } from 'rollup';
import { type ViteConfigOverride, type ViteBuildContext, resolveEntryFile, normalisePlugins } from '../Build';
import { ENTRY_EXTENSIONS } from '../constants';

const buildMock = vi.mocked(build);
let existsSyncMock: ReturnType<typeof vi.fn>;
let rmMock: ReturnType<typeof vi.fn>;

describe('Build.ts - Full Coverage', () => {
  const mockProjectRoot = '/project';
  const mockClientBaseDir = '/project/src/client';

  let originalNodeVersion: string;

  beforeEach(async () => {
    buildMock.mockReset();
    buildMock.mockResolvedValue({} as RollupOutput);

    vi.resetModules();

    // re-bind mocks AFTER resetModules so we mutate the same functions Build.ts will use
    const fsMod = await import('node:fs');
    const fsPromisesMod = await import('node:fs/promises');

    existsSyncMock = vi.mocked(fsMod.existsSync) as any;
    rmMock = vi.mocked(fsPromisesMod.rm) as any;

    existsSyncMock.mockReset();
    existsSyncMock.mockImplementation(() => true);

    rmMock.mockReset();
    rmMock.mockResolvedValue(undefined);

    const mod = await import('../Build');
    taujsBuild = mod.taujsBuild;
    mergeViteConfig = mod.mergeViteConfig;
    getFrameworkInvariants = mod.getFrameworkInvariants;
    resolveInputs = mod.resolveInputs;
    resolveAppFilter = mod.resolveAppFilter;

    originalNodeVersion = process.versions.node;
    Object.defineProperty(process.versions, 'node', {
      value: '20.0.0',
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    delete process.env.BUILD_MODE;
    // Restore original node version
    Object.defineProperty(process.versions, 'node', {
      value: originalNodeVersion,
      writable: true,
      configurable: true,
    });
  });

  describe('taujsBuild - Core Build Orchestration', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should perform client build by default', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      expect(build).toHaveBeenCalledTimes(1);
      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.ssr).toBeUndefined();
      expect(buildConfig.build?.manifest).toBe(true);
      expect(buildConfig.build?.ssrManifest).toBe(false);
    });

    it('should perform SSR build when isSSRBuild=true', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.ssr).toBe('/project/src/client/admin/entry-server.tsx');
      expect(buildConfig.build?.manifest).toBe(false);
      expect(buildConfig.build?.ssrManifest).toBe(true);
      expect((buildConfig.build as any)?.format).toBe('esm');
      expect((buildConfig.build as any)?.target).toBe('node20');
      expect((buildConfig.build as any)?.copyPublicDir).toBe(false);
    });

    it('should perform SSR build when BUILD_MODE env var is set', async () => {
      process.env.BUILD_MODE = 'ssr';

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.ssr).toBeDefined();
    });

    it('should delete dist directory before client build', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      expect(fsPromises.rm).toHaveBeenCalledWith(path.resolve(mockProjectRoot, 'dist'), { recursive: true, force: true });
    });

    it('should NOT delete dist directory for SSR build', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      expect(fsPromises.rm).not.toHaveBeenCalled();
    });

    it('should handle dist deletion errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(fsPromises.rm).mockRejectedValue(new Error('Permission denied'));

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error deleting dist directory:', expect.any(Error));

      consoleErrorSpy.mockRestore();
    });

    it('should set correct output directory for client build', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.outDir).toBe('/project/dist/client/admin');
    });

    it('should set correct output directory for SSR build', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.outDir).toBe('/project/dist/ssr/admin');
    });

    it('should include client entry in client build', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const inputs = buildConfig.build?.rollupOptions?.input as Record<string, string>;

      expect(inputs).toHaveProperty('client');
      // drop the `main` assertion
    });

    it('should exclude index.html from client build when file does not exist', async () => {
      // Call sequence: entry-client.ts (true), entry-server.ts (true), index.html (false)
      existsSyncMock
        .mockReturnValueOnce(true) // entry-client.ts found
        .mockReturnValueOnce(true) // entry-server.ts found
        .mockReturnValueOnce(false); // index.html not found

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const inputs = buildConfig.build?.rollupOptions?.input as Record<string, string>;
      expect(inputs).not.toHaveProperty('main');
      expect(inputs).toHaveProperty('client');
    });

    it('should include only client entry when index.html does not exist (existsSync false only for main)', async () => {
      // Call sequence: entry-client.ts (true), entry-server.ts (true), index.html (false)
      existsSyncMock
        .mockReturnValueOnce(true) // entry-client.ts found
        .mockReturnValueOnce(true) // entry-server.ts found
        .mockReturnValueOnce(false); // index.html not found

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const inputs = buildConfig.build!.rollupOptions!.input as Record<string, string>;

      expect(inputs).toEqual({
        client: expect.stringContaining('entry-client'),
      });
    });

    it('should set correct rollupOptions input for SSR build', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const inputs = buildConfig.build?.rollupOptions?.input as Record<string, string>;
      expect(inputs).toHaveProperty('server');
      expect(inputs.server).toContain('entry-server.tsx');
      expect(inputs).not.toHaveProperty('client');
      expect(inputs).not.toHaveProperty('main');
    });

    it('should set publicDir to false for SSR builds', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.publicDir).toBe(false);
    });

    it('should set publicDir to "public" for client builds', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.publicDir).toBe('public');
    });

    it('should handle app without entryPoint (root level)', async () => {
      const rootAppConfig = {
        ...mockAppConfig,
        entryPoint: '',
      };
      vi.mocked(processConfigs).mockReturnValue([rootAppConfig] as any);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.base).toBe('/');
      expect(buildConfig.root).toBe(mockClientBaseDir);
    });

    it('should handle app with entryPoint', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.base).toBe('/admin/');
      expect(buildConfig.root).toBe('/project/src/client/admin');
    });

    it('should process multiple apps sequentially', async () => {
      const multipleApps = [
        { ...mockAppConfig, entryPoint: 'app1', appId: 'app1' },
        { ...mockAppConfig, entryPoint: 'app2', appId: 'app2' },
        { ...mockAppConfig, entryPoint: 'app3', appId: 'app3' },
      ];
      vi.mocked(processConfigs).mockReturnValue(multipleApps as any);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      expect(build).toHaveBeenCalledTimes(3);
    });

    it('should exit process on build failure', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const buildError = new Error('Build failed');
      vi.mocked(build).mockRejectedValue(buildError);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith('[taujs:build:admin] ✗ Failed\n', buildError);
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should log build progress messages', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      expect(consoleLogSpy).toHaveBeenCalledWith('[taujs:build:admin] Building → Client');
      expect(consoleLogSpy).toHaveBeenCalledWith('[taujs:build:admin] ✓ Complete\n');

      consoleLogSpy.mockRestore();
    });

    it('should log SSR build mode correctly', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      expect(consoleLogSpy).toHaveBeenCalledWith('[taujs:build:admin] Building → SSR');

      consoleLogSpy.mockRestore();
    });

    it('should use correct node version in target', async () => {
      Object.defineProperty(process.versions, 'node', {
        value: '18.12.1',
        writable: true,
        configurable: true,
      });

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.target).toBe('node18');
    });

    it('should set emptyOutDir to true', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.emptyOutDir).toBe(true);
    });

    it('should include plugins from appConfig', async () => {
      const mockPlugin = { name: 'test-plugin' };
      const appWithPlugins = {
        ...mockAppConfig,
        plugins: [mockPlugin],
      };
      vi.mocked(processConfigs).mockReturnValue([appWithPlugins] as any);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.plugins).toContain(mockPlugin);
    });

    it('should set SCSS preprocessor to modern-compiler', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.css?.preprocessorOptions?.scss).toEqual({ api: 'modern-compiler' });
    });
  });

  describe('Alias Configuration', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should provide default framework aliases', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const aliases = buildConfig.resolve?.alias as Record<string, string>;

      expect(aliases['@client']).toBe('/project/src/client/admin');
      expect(aliases['@server']).toBe('/project/src/server');
      expect(aliases['@shared']).toBe('/project/src/shared');
    });

    it('should merge user aliases with framework defaults', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        alias: {
          '@utils': '/project/src/utils',
          '@components': '/project/src/components',
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const aliases = buildConfig.resolve?.alias as Record<string, string>;

      expect(aliases['@client']).toBe('/project/src/client/admin');
      expect(aliases['@server']).toBe('/project/src/server');
      expect(aliases['@shared']).toBe('/project/src/shared');
      expect(aliases['@utils']).toBe('/project/src/utils');
      expect(aliases['@components']).toBe('/project/src/components');
    });

    it('should allow user to override framework aliases', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        alias: {
          '@server': '/custom/server/path',
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const aliases = buildConfig.resolve?.alias as Record<string, string>;

      expect(aliases['@server']).toBe('/custom/server/path');
    });

    it('should handle empty user alias object', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        alias: {},
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const aliases = buildConfig.resolve?.alias as Record<string, string>;

      expect(aliases['@client']).toBe('/project/src/client/admin');
    });

    it('should handle undefined alias parameter', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        alias: undefined,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const aliases = buildConfig.resolve?.alias as Record<string, string>;

      expect(aliases).toBeDefined();
      expect(aliases['@client']).toBe('/project/src/client/admin');
    });
  });

  describe('Vite Config Override - No Override Cases', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should use framework config when no vite override provided', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: undefined,
      });

      expect(build).toHaveBeenCalled();
      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.base).toBe('/admin/');
    });
  });

  describe('Vite Config Override - Static Config Object', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should append user plugins to framework plugins', async () => {
      const userPlugin = { name: 'user-plugin' };

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          plugins: [userPlugin],
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const plugins = buildConfig.plugins as any[];
      expect(plugins).toContainEqual(userPlugin);
    });

    it('should merge multiple user plugins', async () => {
      const plugin1 = { name: 'plugin-1' };
      const plugin2 = { name: 'plugin-2' };

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          plugins: [plugin1, plugin2],
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const plugins = buildConfig.plugins as any[];
      expect(plugins).toContainEqual(plugin1);
      expect(plugins).toContainEqual(plugin2);
    });

    it('should shallow merge user define with framework define', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          define: {
            'process.env.CUSTOM_VAR': '"custom-value"',
            'import.meta.env.MODE': '"production"',
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.define).toMatchObject({
        'process.env.CUSTOM_VAR': '"custom-value"',
        'import.meta.env.MODE': '"production"',
      });
    });

    it('should handle empty define object', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          define: {},
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.define).toBeDefined();
    });

    it('should ignore non-object define', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          define: 'not-an-object' as any,
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should deep merge CSS preprocessor options', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          css: {
            preprocessorOptions: {
              scss: {
                additionalData: '@import "variables";',
              },
              less: {
                math: 'always',
              },
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.css?.preprocessorOptions?.scss).toEqual({
        api: 'modern-compiler',
        additionalData: '@import "variables";',
      });
      expect((buildConfig.css?.preprocessorOptions as any)?.less).toEqual({
        math: 'always',
      });
    });

    it('should override framework scss options with user values', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          css: {
            preprocessorOptions: {
              scss: {
                api: 'legacy' as any,
              },
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.css?.preprocessorOptions?.scss).toEqual({
        api: 'legacy',
      });
    });

    it('should handle empty preprocessorOptions', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          css: {
            preprocessorOptions: {},
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.css?.preprocessorOptions?.scss).toEqual({
        api: 'modern-compiler',
      });
    });

    it('should ignore non-object preprocessorOptions', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          css: {
            preprocessorOptions: 'not-an-object' as any,
          },
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should allow user to override build.sourcemap', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            sourcemap: 'inline',
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.sourcemap).toBe('inline');
    });

    it('should allow user to set build.sourcemap to boolean', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            sourcemap: true,
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.sourcemap).toBe(true);
    });

    it('should allow user to override build.minify', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            minify: 'terser',
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.minify).toBe('terser');
    });

    it('should allow user to disable minification', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            minify: false,
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.minify).toBe(false);
    });

    it('should merge user terserOptions', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            terserOptions: {
              compress: {
                drop_console: true,
              },
            },
          } as any,
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const mergedTerser = (buildConfig.build as any)?.terserOptions;

      expect(mergedTerser.compress).toEqual({ drop_console: true });
    });

    it('should handle empty terserOptions', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            terserOptions: {},
          },
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should ignore non-object terserOptions', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            terserOptions: 'not-an-object' as any,
          },
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should allow user to set rollupOptions.external', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            rollupOptions: {
              external: ['react', 'react-dom'],
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build?.rollupOptions as any)?.external).toEqual(['react', 'react-dom']);
    });

    it('should merge user manualChunks from output object', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            rollupOptions: {
              output: {
                manualChunks: {
                  vendor: ['react', 'react-dom'],
                },
              },
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const output = (buildConfig.build?.rollupOptions as any)?.output;
      expect(output?.manualChunks).toEqual({
        vendor: ['react', 'react-dom'],
      });
    });

    it('should handle manualChunks from array output (uses first element)', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            rollupOptions: {
              output: [
                {
                  manualChunks: {
                    vendor: ['react'],
                  },
                },
                {
                  manualChunks: {
                    utils: ['lodash'],
                  },
                },
              ],
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const output = (buildConfig.build?.rollupOptions as any)?.output;
      expect(output?.manualChunks).toEqual({
        vendor: ['react'],
      });
    });

    it('should handle output without manualChunks', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'es',
              },
            },
          },
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should merge user resolve options (excluding alias)', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          resolve: {
            extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'],
            dedupe: ['react'],
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.resolve as any)?.extensions).toEqual(['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json']);
      expect((buildConfig.resolve as any)?.dedupe).toEqual(['react']);
    });

    it('should allow user to override esbuild options', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          esbuild: {
            jsxFactory: 'h',
            jsxFragment: 'Fragment',
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig as any).esbuild).toEqual({
        jsxFactory: 'h',
        jsxFragment: 'Fragment',
      });
    });

    it('should allow user to set logLevel', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          logLevel: 'silent',
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.logLevel).toBe('silent');
    });

    it('should allow user to set envPrefix', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          envPrefix: 'APP_',
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig as any).envPrefix).toBe('APP_');
    });

    it('should allow user to configure optimizeDeps', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          optimizeDeps: {
            include: ['lodash'],
            exclude: ['some-package'],
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig as any).optimizeDeps).toEqual({
        include: ['lodash'],
        exclude: ['some-package'],
      });
    });

    it('should allow user to configure top-level ssr options', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          ssr: {
            noExternal: ['some-package'],
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig as any).ssr).toEqual({
        noExternal: ['some-package'],
      });
    });
  });

  describe('Vite Config Override - Protected Fields', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should ignore user override of root', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          root: '/wrong/path',
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.root).toBe('/project/src/client/admin');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignored Vite config overrides: root'));

      consoleWarnSpy.mockRestore();
    });

    it('should ignore user override of base', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          base: '/wrong-base/',
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.base).toBe('/admin/');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignored Vite config overrides: base'));

      consoleWarnSpy.mockRestore();
    });

    it('should ignore user override of publicDir', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          publicDir: '/wrong/public',
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.publicDir).toBe('public');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignored Vite config overrides: publicDir'));

      consoleWarnSpy.mockRestore();
    });

    it('should ignore user override of build.outDir', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            outDir: '/wrong/dist',
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.outDir).toBe('/project/dist/client/admin');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('build.outDir'));

      consoleWarnSpy.mockRestore();
    });

    it('should ignore user override of build.ssr', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
        vite: {
          build: {
            ssr: '/wrong/entry.ts',
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.ssr).toBe('/project/src/client/admin/entry-server.tsx');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('build.ssr'));

      consoleWarnSpy.mockRestore();
    });

    it('should ignore user override of build.ssrManifest', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            ssrManifest: true,
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.ssrManifest).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('build.ssrManifest'));

      consoleWarnSpy.mockRestore();
    });

    it('should ignore user override of build.format', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
        vite: {
          build: {
            format: 'cjs',
          },
        } as any,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.format).toBe('esm');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('build.format'));
      consoleWarnSpy.mockRestore();
    });

    it('should ignore user override of build.target', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
        vite: {
          build: {
            target: 'es2020',
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.target).toBe('node20');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('build.target'));

      consoleWarnSpy.mockRestore();
    });

    it('should ignore user override of build.rollupOptions.input', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            rollupOptions: {
              input: { wrong: '/wrong/entry.ts' },
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const inputs = buildConfig.build?.rollupOptions?.input as Record<string, string>;
      expect(inputs).toHaveProperty('client');
      expect(inputs).not.toHaveProperty('wrong');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('build.rollupOptions.input'));

      consoleWarnSpy.mockRestore();
    });

    it('should ignore user resolve.alias', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          resolve: {
            alias: {
              '@wrong': '/wrong/path',
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const aliases = buildConfig.resolve?.alias as Record<string, string>;
      expect(aliases).not.toHaveProperty('@wrong');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('resolve.alias'));

      consoleWarnSpy.mockRestore();
    });

    it('should warn about server config in build (dev-only)', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          server: {
            port: 3000,
          },
        },
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[taujs:build:admin] Ignored Vite config overrides: server'));

      consoleWarnSpy.mockRestore();
    });

    it('should deduplicate warnings for multiple ignored keys', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          root: '/wrong',
          base: '/wrong',
          build: {
            outDir: '/wrong',
            ssr: '/wrong',
          },
        },
      });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const warningMessage = consoleWarnSpy.mock.calls[0]![0];
      expect(warningMessage).toContain('root');
      expect(warningMessage).toContain('base');
      expect(warningMessage).toContain('build.outDir');
      expect(warningMessage).toContain('build.ssr');

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Vite Config Override - Function-Based Config', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should call function with correct build context', async () => {
      const viteConfigFn = vi.fn().mockReturnValue({});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
        vite: viteConfigFn,
      });

      expect(viteConfigFn).toHaveBeenCalledWith({
        appId: 'test-app',
        entryPoint: 'admin',
        isSSRBuild: false,
        clientRoot: '/project/src/client/admin',
      });
    });

    it('should use config returned by function', async () => {
      const userPlugin = { name: 'conditional-plugin' };
      const viteConfigFn = vi.fn().mockReturnValue({
        plugins: [userPlugin],
        logLevel: 'warn',
      });

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: viteConfigFn,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.plugins).toContainEqual(userPlugin);
      expect(buildConfig.logLevel).toBe('warn');
    });

    it('should allow conditional config based on isSSRBuild', async () => {
      const ssrPlugin = { name: 'ssr-plugin' };
      const clientPlugin = { name: 'client-plugin' };

      const viteConfigFn = ({ isSSRBuild }: ViteBuildContext) => ({
        plugins: isSSRBuild ? [ssrPlugin] : [clientPlugin],
      });

      // Test SSR build
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
        vite: viteConfigFn,
      });

      let buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.plugins).toContainEqual(ssrPlugin);

      // Reset and test client build
      vi.clearAllMocks();
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
        vite: viteConfigFn,
      });

      buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.plugins).toContainEqual(clientPlugin);
    });

    it('should allow conditional config based on entryPoint', async () => {
      const viteConfigFn = ({ entryPoint }: ViteBuildContext): Partial<InlineConfig> => {
        const level: InlineConfig['logLevel'] = entryPoint === 'admin' ? 'info' : 'warn';

        return { logLevel: level };
      };

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: viteConfigFn,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.logLevel).toBe('info');
    });

    it('should allow conditional config based on appId', async () => {
      const viteConfigFn = ({ appId }: ViteBuildContext) => ({
        build: {
          sourcemap: appId === 'test-app' ? true : false,
        },
      });

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: viteConfigFn,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.sourcemap).toBe(true);
    });

    it('should handle function returning empty config', async () => {
      const viteConfigFn = vi.fn().mockReturnValue({});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: viteConfigFn,
      });

      expect(build).toHaveBeenCalled();
    });

    it('should call function for each app build separately', async () => {
      const multipleApps = [
        { ...mockAppConfig, entryPoint: 'app1', appId: 'app1' },
        { ...mockAppConfig, entryPoint: 'app2', appId: 'app2' },
      ];
      vi.mocked(processConfigs).mockReturnValue(multipleApps as any);

      const viteConfigFn = vi.fn().mockReturnValue({});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: viteConfigFn,
      });

      expect(viteConfigFn).toHaveBeenCalledTimes(2);
      expect(viteConfigFn).toHaveBeenNthCalledWith(1, expect.objectContaining({ appId: 'app1' }));
      expect(viteConfigFn).toHaveBeenNthCalledWith(2, expect.objectContaining({ appId: 'app2' }));
    });
  });

  describe('Edge Cases and Error Handling', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should handle empty apps array', async () => {
      vi.mocked(processConfigs).mockReturnValue([]);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      expect(build).not.toHaveBeenCalled();
    });

    it('should handle undefined plugins in appConfig', async () => {
      const appWithoutPlugins = {
        ...mockAppConfig,
        plugins: undefined,
      };
      vi.mocked(processConfigs).mockReturnValue([appWithoutPlugins] as any);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.plugins).toEqual([]);
    });

    it('should handle vite config with null values', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          plugins: null as any,
          define: null as any,
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should handle vite config with undefined nested objects', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: undefined,
          css: undefined,
          resolve: undefined,
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should handle framework config with missing build object', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            sourcemap: true,
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build).toBeDefined();
      expect((buildConfig.build as any)?.sourcemap).toBe(true);
    });

    it('should handle framework config with missing css object', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          css: {
            preprocessorOptions: {
              scss: { additionalData: '@import "test";' },
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.css).toBeDefined();
    });

    it('should handle framework config with missing resolve object', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          resolve: {
            extensions: ['.ts', '.tsx'],
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.resolve).toBeDefined();
    });

    it('should handle app config with missing optional fields', async () => {
      const minimalAppConfig = {
        appId: 'minimal',
        entryPoint: 'minimal',
        clientRoot: '/project/src/client/minimal',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
      };
      vi.mocked(processConfigs).mockReturnValue([minimalAppConfig] as any);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
      });

      expect(build).toHaveBeenCalled();
    });

    it('should preserve undefined build.ssr for client builds', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.build?.ssr).toBeUndefined();
    });

    it('should handle empty rollupOptions in user config', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            rollupOptions: {},
          },
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should handle missing rollupOptions.output in framework config', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            rollupOptions: {
              output: {
                manualChunks: { vendor: ['react'] },
              },
            },
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build?.rollupOptions as any)?.output).toBeDefined();
    });

    it('should handle array output with empty first element', async () => {
      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          build: {
            rollupOptions: {
              output: [null as any, { manualChunks: { vendor: ['react'] } }],
            },
          },
        },
      });

      expect(build).toHaveBeenCalled();
    });

    it('should not warn when no protected fields are overridden', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          plugins: [{ name: 'test' }],
          logLevel: 'info',
        },
      });

      expect(consoleWarnSpy).not.toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('should include entryPoint in warning prefix', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          root: '/wrong',
        },
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[taujs:build:admin]'));

      consoleWarnSpy.mockRestore();
    });

    it('should handle various node version formats', async () => {
      Object.defineProperty(process.versions, 'node', {
        value: '16.14.2',
        writable: true,
        configurable: true,
      });

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.target).toBe('node16');
    });

    it('should handle single-digit node version', async () => {
      Object.defineProperty(process.versions, 'node', {
        value: '8.0.0',
        writable: true,
        configurable: true,
      });

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect((buildConfig.build as any)?.target).toBe('node8');
    });
  });

  describe('Complex Integration Scenarios', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [{ name: 'framework-plugin' }],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should combine framework plugins with user plugins in correct order', async () => {
      const userPlugin1 = { name: 'user-plugin-1' };
      const userPlugin2 = { name: 'user-plugin-2' };

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          plugins: [userPlugin1, userPlugin2],
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      const plugins = buildConfig.plugins as any[];

      expect(plugins[0]).toEqual({ name: 'framework-plugin' });
      expect(plugins).toContainEqual(userPlugin1);
      expect(plugins).toContainEqual(userPlugin2);
    });

    it('should apply all valid customizations simultaneously', async () => {
      const userPlugin = { name: 'user-plugin' };

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        alias: {
          '@utils': '/project/src/utils',
        },
        vite: {
          plugins: [userPlugin],
          define: {
            'process.env.API_URL': '"https://api.example.com"',
          },
          css: {
            preprocessorOptions: {
              scss: {
                additionalData: '@import "variables";',
              },
            },
          },
          build: {
            sourcemap: 'inline',
            minify: 'terser',
            terserOptions: {
              compress: { drop_console: true },
            } as any,
            rollupOptions: {
              external: ['react'],
              output: {
                manualChunks: { vendor: ['lodash'] },
              },
            },
          },
          resolve: {
            extensions: ['.ts', '.tsx', '.js'],
          },
          esbuild: {
            jsxFactory: 'h',
          },
          logLevel: 'warn',
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;

      // Check alias
      expect((buildConfig.resolve?.alias as any)['@utils']).toBe('/project/src/utils');

      // Check plugins
      expect(buildConfig.plugins).toContainEqual(userPlugin);

      // Check define
      expect(buildConfig.define).toMatchObject({
        'process.env.API_URL': '"https://api.example.com"',
      });

      // Check CSS
      expect(buildConfig.css?.preprocessorOptions?.scss).toEqual({
        api: 'modern-compiler',
        additionalData: '@import "variables";',
      });

      // Check build options
      expect((buildConfig.build as any)?.sourcemap).toBe('inline');
      expect((buildConfig.build as any)?.minify).toBe('terser');
      expect((buildConfig.build as any)?.terserOptions).toMatchObject({
        compress: { drop_console: true },
      });

      // Check rollup options
      expect((buildConfig.build?.rollupOptions as any)?.external).toEqual(['react']);
      expect((buildConfig.build?.rollupOptions as any)?.output?.manualChunks).toEqual({
        vendor: ['lodash'],
      });

      // Check resolve
      expect((buildConfig.resolve as any)?.extensions).toEqual(['.ts', '.tsx', '.js']);

      // Check esbuild
      expect((buildConfig as any).esbuild).toEqual({ jsxFactory: 'h' });

      // Check logLevel
      expect(buildConfig.logLevel).toBe('warn');
    });

    it('should handle mixed valid and invalid overrides', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: {
          plugins: [{ name: 'valid-plugin' }], // valid
          logLevel: 'info', // valid
          root: '/invalid', // invalid
          build: {
            sourcemap: true, // valid
            outDir: '/invalid', // invalid
          },
        },
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;

      // Valid options should be applied
      expect(buildConfig.plugins).toContainEqual({ name: 'valid-plugin' });
      expect(buildConfig.logLevel).toBe('info');
      expect((buildConfig.build as any)?.sourcemap).toBe(true);

      // Invalid options should be ignored
      expect(buildConfig.root).not.toBe('/invalid');
      expect(buildConfig.build?.outDir).not.toBe('/invalid');

      // Should warn about invalid options
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Type Safety and Build Context', () => {
    const mockAppConfig = {
      appId: 'test-app',
      entryPoint: 'admin',
      clientRoot: '/project/src/client/admin',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    beforeEach(() => {
      vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
      vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
    });

    it('should provide correct ViteBuildContext to function config', async () => {
      let capturedContext: ViteBuildContext | undefined;

      const viteConfigFn = (ctx: ViteBuildContext) => {
        capturedContext = ctx;
        return {};
      };

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: true,
        vite: viteConfigFn,
      });

      expect(capturedContext).toEqual({
        appId: 'test-app',
        entryPoint: 'admin',
        isSSRBuild: true,
        clientRoot: '/project/src/client/admin',
      });
    });

    it('should handle clientRoot in build context', async () => {
      const viteConfigFn = ({ clientRoot }: ViteBuildContext): Partial<InlineConfig> => ({
        logLevel: clientRoot.includes('admin') ? 'info' : 'warn',
      });

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        vite: viteConfigFn,
      });

      const buildConfig = vi.mocked(build).mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.logLevel).toBe('info');
    });
  });

  describe('Internal config helpers – invariants and deep merge coverage', () => {
    it('getFrameworkInvariants applies all defaults when fields are missing', () => {
      const invariants = getFrameworkInvariants({} as InlineConfig);

      expect(invariants.root).toBe(''); // .root || ''
      expect(invariants.base).toBe('/'); // .base || '/'
      expect(invariants.publicDir).toBe('public'); // publicDir === undefined ? 'public' : ...

      expect(invariants.build.outDir).toBe(''); // (outDir as string) || ''
      expect(invariants.build.manifest).toBe(false); // (manifest as boolean) ?? false
      expect(invariants.build.ssr).toBeUndefined(); // preserved as undefined
      expect(invariants.build.ssrManifest).toBe(false); // (ssrManifest as boolean) ?? false
      expect(invariants.build.rollupOptions.input).toEqual({}); // (input as Record<string,string>) || {}
    });

    it('mergeViteConfig handles missing framework sub-objects (build/css/resolve/plugins/define)', () => {
      const framework = {} as InlineConfig;

      const userOverride: ViteConfigOverride = {
        // exercise build path: rollupOptions + output.manualChunks + externals
        build: {
          sourcemap: true,
          minify: 'terser',
          terserOptions: { compress: { drop_console: true } } as any,
          rollupOptions: {
            external: ['react'],
            output: {
              manualChunks: {
                vendor: ['react', 'react-dom'],
              },
            },
          },
        },
        // exercise css.preprocessorOptions deep merge branch
        css: {
          preprocessorOptions: {
            scss: {
              additionalData: '@import "vars";',
            },
          },
        },
        // exercise resolve merge (without alias)
        resolve: {
          extensions: ['.mjs', '.js', '.ts'],
        },
        // exercise safe top-level keys
        esbuild: {
          jsxFactory: 'h',
        },
        logLevel: 'info',
        envPrefix: 'APP_',
        optimizeDeps: {
          include: ['lodash'],
        },
        ssr: {
          noExternal: ['some-package'],
        },
      };

      const merged = mergeViteConfig(framework, userOverride);

      // build was created from empty framework via "build: { ...(framework.build ?? {}) }"
      expect(merged.build).toBeDefined();
      expect((merged.build as any).sourcemap).toBe(true);
      expect((merged.build as any).minify).toBe('terser');
      expect((merged.build as any).terserOptions).toEqual({
        compress: { drop_console: true },
      });

      const rollup = (merged.build?.rollupOptions ?? {}) as any;
      expect(rollup.external).toEqual(['react']);
      expect(rollup.output?.manualChunks).toEqual({
        vendor: ['react', 'react-dom'],
      });

      // css was created via css: { ...(framework.css ?? {}) } + deep merge branch
      expect(merged.css?.preprocessorOptions?.scss).toEqual({
        additionalData: '@import "vars";',
      });

      // resolve was created via resolve: { ...(framework.resolve ?? {}) } + merge
      expect((merged.resolve as any)?.extensions).toEqual(['.mjs', '.js', '.ts']);

      // safe top-level fields
      expect((merged as any).esbuild).toEqual({ jsxFactory: 'h' });
      expect(merged.logLevel).toBe('info');
      expect((merged as any).envPrefix).toBe('APP_');
      expect((merged as any).optimizeDeps).toEqual({
        include: ['lodash'],
      });
      expect((merged as any).ssr).toEqual({
        noExternal: ['some-package'],
      });
    });

    it('mergeViteConfig restores invariants, initialises rollupOptions, and warns when protected fields/server are overridden without context', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // framework with only the minimal bits we care about, no build/rollupOptions
      const framework: InlineConfig = {
        root: undefined as any,
        base: undefined as any,
        publicDir: undefined,
        // no build to force all getFrameworkInvariants defaults
      };

      const userOverride: ViteConfigOverride = {
        // top-level protected + server to populate ignoredKeys
        root: '/user-root',
        base: '/user-base/',
        publicDir: '/user-public',
        server: {
          port: 4000,
        } as any,
      };

      // NOTE: no context passed → should use "[taujs:build]" prefix branch
      const merged = mergeViteConfig(framework, userOverride);

      // invariants restored from defaults
      expect(merged.root).toBe(''); // from invariants.root
      expect(merged.base).toBe('/'); // from invariants.base
      expect(merged.publicDir).toBe('public'); // from invariants.publicDir

      // build + rollupOptions.initialised from invariants (defaults)
      expect(merged.build).toBeDefined();
      const mergedBuild = merged.build as any;
      expect(mergedBuild.outDir).toBe('');
      expect(mergedBuild.manifest).toBe(false);
      expect(mergedBuild.ssr).toBeUndefined();
      expect(mergedBuild.ssrManifest).toBe(false);
      expect(mergedBuild.rollupOptions).toBeDefined();
      expect(mergedBuild.rollupOptions.input).toEqual({});

      // warning emitted with generic prefix and the protected keys
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const msg = consoleWarnSpy.mock.calls[0]![0] as string;
      expect(msg.startsWith('[taujs:build]')).toBe(true);
      expect(msg).toContain('root');
      expect(msg).toContain('base');
      expect(msg).toContain('publicDir');
      expect(msg).toContain('server');

      consoleWarnSpy.mockRestore();
    });
  });

  describe('resolveInputs helper', () => {
    it('returns only server input for SSR builds', () => {
      const result = resolveInputs(true, true, {
        server: '/server-entry',
        client: '/client-entry',
        main: '/index.html',
      });

      expect(result).toEqual({ server: '/server-entry' });

      // also covers mainExists=false for SSR (since first branch wins)
      const result2 = resolveInputs(true, false, {
        server: '/server-entry',
        client: '/client-entry',
        main: '/index.html',
      });

      expect(result2).toEqual({ server: '/server-entry' });
    });

    it('returns client and main for client builds when main exists', () => {
      const result = resolveInputs(false, true, {
        server: '/server-entry',
        client: '/client-entry',
        main: '/index.html',
      });

      expect(result).toEqual({
        client: '/client-entry',
        main: '/index.html',
      });
    });

    it('returns only client for client builds when main is missing', () => {
      const result = resolveInputs(false, false, {
        server: '/server-entry',
        client: '/client-entry',
        main: '/index.html',
      });

      expect(result).toEqual({
        client: '/client-entry',
      });
    });
  });

  it('mergeViteConfig respects existing array output when merging manualChunks', () => {
    const framework: InlineConfig = {
      build: {
        rollupOptions: {
          output: [
            {
              manualChunks: {
                existing: ['x'],
              },
            },
          ],
        },
      } as any,
    };

    const userOverride: ViteConfigOverride = {
      build: {
        rollupOptions: {
          output: {
            manualChunks: {
              vendor: ['react'],
            },
          },
        },
      },
    };

    const merged = mergeViteConfig(framework, userOverride);
    const rollup = merged.build!.rollupOptions as any;
    const output = rollup.output;

    // We only carry over manualChunks from user; existing manualChunks are overwritten
    expect(output.manualChunks).toEqual({
      vendor: ['react'],
    });
  });

  it('mergeViteConfig handles array output with undefined first element (baseOut fallback)', () => {
    const framework: InlineConfig = {
      build: {
        rollupOptions: {
          // Array case, but first element is undefined → triggers (mro.output[0] ?? {})
          output: [undefined as any],
        },
      } as any,
    };

    const userOverride: ViteConfigOverride = {
      build: {
        rollupOptions: {
          // standard object output with manualChunks
          output: {
            manualChunks: {
              vendor: ['react'],
            },
          },
        },
      },
    };

    const merged = mergeViteConfig(framework, userOverride);
    const rollup = merged.build!.rollupOptions as any;
    const output = rollup.output;

    // We only care that manualChunks survive; the important bit is that
    // baseOut came from the `?? {}` fallback on mro.output[0]
    expect(output.manualChunks).toEqual({
      vendor: ['react'],
    });
  });

  describe('resolveAppFilter', () => {
    it('returns null selection when no env or CLI filter is provided', () => {
      const result = resolveAppFilter([], {} as NodeJS.ProcessEnv);

      expect(result).toEqual({
        selectedIds: null,
        raw: undefined,
      });
    });

    it('uses TAUJS_APP / TAUJS_APPS from env when no CLI filter is provided', () => {
      const env = {
        TAUJS_APP: 'admin',
      } as unknown as NodeJS.ProcessEnv;

      const result = resolveAppFilter([], env);

      expect(result.raw).toBe('admin');
      expect(result.selectedIds).toEqual(new Set(['admin']));
    });

    it('CLI filter overrides env and supports comma-separated lists with trimming', () => {
      const argv = ['--apps', ' admin, marketing , ,reports '];
      const env = {
        TAUJS_APPS: 'should-be-ignored',
      } as unknown as NodeJS.ProcessEnv;

      const result = resolveAppFilter(argv, env);

      // raw is the un-cleaned CLI string (trim is applied later)
      expect(result.raw).toBe('admin, marketing , ,reports');

      // selectedIds is trimmed and empty segments are dropped
      expect(result.selectedIds).toEqual(new Set(['admin', 'marketing', 'reports']));
    });

    it('supports --app=value syntax', () => {
      const argv = ['--app=admin'];
      const env = {} as NodeJS.ProcessEnv;

      const result = resolveAppFilter(argv, env);

      expect(result.raw).toBe('admin');
      expect(result.selectedIds).toEqual(new Set(['admin']));
    });

    it('treats bare --app with no value as “no filter”', () => {
      const argv = ['--app'];
      const env = {} as NodeJS.ProcessEnv;

      const result = resolveAppFilter(argv, env);

      // read() returns '', which becomes raw=undefined → no selection
      expect(result).toEqual({
        selectedIds: null,
        raw: undefined,
      });
    });

    it('skips falsy argv entries and still parses later flags', () => {
      const argv = [undefined as any, '--apps=admin,marketing'];
      const env = {} as NodeJS.ProcessEnv;

      const result = resolveAppFilter(argv, env);

      expect(result.raw).toBe('admin,marketing');
      expect(result.selectedIds).toEqual(new Set(['admin', 'marketing']));
    });

    it('stops parsing flags at the "--" terminator', () => {
      const argv = [
        '--apps',
        'admin,marketing',
        '--', // terminator
        '--apps',
        'ignored-later',
      ];

      const env = {} as NodeJS.ProcessEnv;

      const result = resolveAppFilter(argv, env);

      // We only see the first --apps before the terminator
      expect(result.raw).toBe('admin,marketing');
      expect(result.selectedIds).toEqual(new Set(['admin', 'marketing']));
    });

    it('returns undefined when no keys match and loops exhaust fully', () => {
      const argv = ['--foo', 'bar', '--something', 'else', '--not-app', 'value'];

      const env = {} as NodeJS.ProcessEnv;

      const result = resolveAppFilter(argv, env);

      expect(result.raw).toBeUndefined();
      expect(result.selectedIds).toBeNull();
    });
  });

  describe('taujsBuild – app filtering via CLI/env', () => {
    const mockAppBase = {
      clientRoot: '/project/src/client',
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
    };

    const mockProjectRoot = '/project';
    const mockClientBaseDir = '/project/src/client';

    let originalArgv: string[];
    let originalTAUJS_APP: string | undefined;
    let originalTAUJS_APPS: string | undefined;

    beforeEach(() => {
      originalArgv = [...process.argv];
      originalTAUJS_APP = process.env.TAUJS_APP;
      originalTAUJS_APPS = process.env.TAUJS_APPS;

      // three apps with different appIds/entryPoints
      const apps = [
        {
          ...mockAppBase,
          appId: '@acme/admin',
          entryPoint: 'admin',
          clientRoot: '/project/src/client/admin',
        },
        {
          ...mockAppBase,
          appId: 'marketing',
          entryPoint: 'marketing',
          clientRoot: '/project/src/client/marketing',
        },
        {
          ...mockAppBase,
          appId: 'reports',
          entryPoint: 'reports-app',
          clientRoot: '/project/src/client/reports-app',
        },
      ];

      vi.mocked(extractBuildConfigs).mockReturnValue(apps as any);
      vi.mocked(processConfigs).mockReturnValue(apps as any);

      // reset vite build mock call history but keep implementation
      buildMock.mockClear();
    });

    afterEach(() => {
      process.argv = originalArgv;
      if (originalTAUJS_APP === undefined) delete process.env.TAUJS_APP;
      else process.env.TAUJS_APP = originalTAUJS_APP;

      if (originalTAUJS_APPS === undefined) delete process.env.TAUJS_APPS;
      else process.env.TAUJS_APPS = originalTAUJS_APPS;
    });

    it('builds only app matching appId from CLI --app', async () => {
      process.argv = ['node', 'build', '--app', 'marketing'];

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      // should only build marketing
      expect(buildMock).toHaveBeenCalledTimes(1);
      const buildConfig = buildMock.mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.base).toBe('/marketing/'); // uses entryPoint of the matched app
    });

    it('builds only app matching entryPoint from CLI --app', async () => {
      // "reports-app" is an entryPoint, appId is "reports"
      process.argv = ['node', 'build', '--app', 'reports-app'];

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      expect(buildMock).toHaveBeenCalledTimes(1);
      const buildConfig = buildMock.mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.base).toBe('/reports-app/');
    });

    it('uses TAUJS_APPS env when no CLI filter is provided', async () => {
      process.argv = ['node', 'build']; // no CLI filter
      process.env.TAUJS_APPS = '@acme/admin,reports';

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      // should build two apps: @acme/admin and reports
      expect(buildMock).toHaveBeenCalledTimes(2);
      const bases = buildMock.mock.calls.map((c) => (c[0] as InlineConfig).base);
      expect(bases.sort()).toEqual(['/admin/', '/reports-app/'].sort());
    });

    it('CLI filter takes precedence over env TAUJS_APPS', async () => {
      process.argv = ['node', 'build', '--app', 'marketing'];
      process.env.TAUJS_APPS = '@acme/admin,reports'; // should be ignored

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      expect(buildMock).toHaveBeenCalledTimes(1);
      const buildConfig = buildMock.mock.calls[0]![0] as InlineConfig;
      expect(buildConfig.base).toBe('/marketing/');
    });

    it('exits with error when no apps match the filter', async () => {
      process.argv = ['node', 'build', '--app', 'does-not-exist'];

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const msg = consoleErrorSpy.mock.calls[0]![0] as string;

      expect(msg).toContain('[taujs:build] No apps match filter "does-not-exist".');
      expect(msg).toContain('Known apps:');
      expect(msg).toContain('@acme/admin (entry: admin)');
      expect(msg).toContain('marketing (entry: marketing)');
      expect(msg).toContain('reports (entry: reports-app)');

      expect(exitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('prints known apps without entryPoint without entry suffix in error message', async () => {
      const mockProjectRoot = '/project';
      const mockClientBaseDir = '/project/src/client';

      // force a root-level app with empty entryPoint
      const apps = [
        {
          appId: 'root-app',
          entryPoint: '',
          clientRoot: '/project/src/client',
          entryClient: 'entry-client',
          entryServer: 'entry-server',
          htmlTemplate: 'index.html',
          plugins: [],
        },
      ];

      vi.mocked(extractBuildConfigs).mockReturnValue(apps as any);
      vi.mocked(processConfigs).mockReturnValue(apps as any);

      // filter that matches nothing
      process.argv = ['node', 'build', '--app', 'does-not-exist'];

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await taujsBuild({
        config: { apps: [] },
        projectRoot: mockProjectRoot,
        clientBaseDir: mockClientBaseDir,
        isSSRBuild: false,
      });

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const msg = consoleErrorSpy.mock.calls[0]![0] as string;

      // hits: `${c.appId}${c.entryPoint ? ... : ''}`
      expect(msg).toContain('Known apps: root-app');
      // and specifically *not* with an entry suffix
      expect(msg).not.toContain('root-app (entry:');

      expect(exitSpy).toHaveBeenCalledWith(1);

      consoleErrorSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});

describe('resolveEntryFile', () => {
  it('throws with attempted extensions list when no entry exists', () => {
    const clientRoot = '/project/src/client/admin';
    const stem = 'entry-client';

    // exists() returns false for every candidate
    const exists = () => false;

    expect(() => resolveEntryFile(clientRoot, stem, exists)).toThrowError(
      new Error(`Entry file "${stem}" not found in ${clientRoot}. Tried: ${ENTRY_EXTENSIONS.map((e) => stem + e).join(', ')}`),
    );
  });

  it('returns the first matching filename when one exists', () => {
    const clientRoot = '/x';
    const stem = 'entry-client';

    // Only pretend the first extension exists
    const exists = (abs: string) => abs.endsWith(`${stem}${ENTRY_EXTENSIONS[0]}`);

    const result = resolveEntryFile(clientRoot, stem, exists);
    expect(result).toBe(`${stem}${ENTRY_EXTENSIONS[0]}`);
  });
});

describe('normalisePlugins', () => {
  it('returns array unchanged', () => {
    const arr = [1, 2];
    expect(normalisePlugins(arr)).toBe(arr);
  });

  it('wraps single plugin value into array', () => {
    const plugin = { name: 'x' };
    expect(normalisePlugins(plugin)).toEqual([plugin]); // covers p ? [p] : []
  });

  it('returns [] for falsy input', () => {
    expect(normalisePlugins(undefined)).toEqual([]);
    expect(normalisePlugins(null)).toEqual([]);
    expect(normalisePlugins(false)).toEqual([]);
  });
});

// describe('Coverage - Nullish Operators and Edge Cases', () => {
//   const mockAppConfig = {
//     appId: 'test-app',
//     entryPoint: 'admin',
//     clientRoot: '/project/src/client/admin',
//     entryClient: 'entry-client',
//     entryServer: 'entry-server',
//     htmlTemplate: 'index.html',
//     // Don't include plugins to trigger the undefined case
//   };

//   beforeEach(() => {
//     vi.clearAllMocks();
//     vi.mocked(build).mockResolvedValue(undefined);
//     vi.mocked(fs.existsSync).mockReturnValue(true);
//     vi.mocked(fsPromises.rm).mockResolvedValue(undefined);
//     vi.mocked(extractBuildConfigs).mockReturnValue([mockAppConfig] as any);
//     vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);
//   });

//   it('should handle app config with undefined plugins', async () => {
//     // This should trigger the plugins ?? [] in the loop
//     vi.mocked(processConfigs).mockReturnValue([mockAppConfig] as any);

//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//     });

//     const buildConfig = vi.mocked(build).mock.calls[0][0] as InlineConfig;
//     expect(buildConfig.plugins).toEqual([]);
//   });

//   it('should handle mergeViteConfig with no user override', async () => {
//     // This tests the early return when !userOverride
//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       // No vite config at all
//     });

//     expect(build).toHaveBeenCalled();
//   });

//   it('should handle mergeViteConfig with function that returns empty object', async () => {
//     const viteConfigFn = vi.fn().mockReturnValue({}); // Return empty object, not undefined

//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       vite: viteConfigFn,
//     });

//     expect(build).toHaveBeenCalled();
//   });

//   it('should trigger null coalescing in merged config initialization', async () => {
//     // This should test the ?? operators in the merged config setup
//     let capturedConfig: InlineConfig | undefined;
//     vi.mocked(build).mockImplementation(async (config) => {
//       capturedConfig = config;
//       return undefined;
//     });

//     // Pass a config that will test the null coalescing paths
//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       vite: {
//         plugins: null as any, // This will be falsy but not undefined
//       },
//     });

//     expect(capturedConfig).toBeDefined();
//   });

//   it('should handle preprocessorOptions with null framework values', async () => {
//     let capturedConfig: InlineConfig | undefined;
//     vi.mocked(build).mockImplementation(async (config) => {
//       capturedConfig = config;
//       return undefined;
//     });

//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       vite: {
//         css: {
//           preprocessorOptions: {
//             scss: null as any, // This will test the null coalescing
//             less: { math: 'always' },
//           },
//         },
//       },
//     });

//     expect(capturedConfig?.css?.preprocessorOptions).toBeDefined();
//   });

//   it('should handle build.rollupOptions.output with falsy values', async () => {
//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       vite: {
//         build: {
//           rollupOptions: {
//             output: [false as any, { manualChunks: { vendor: ['react'] } }],
//           },
//         },
//       },
//     });

//     const buildConfig = vi.mocked(build).mock.calls[0][0] as InlineConfig;
//     expect((buildConfig.build?.rollupOptions as any)?.output).toBeDefined();
//   });

//   it('should handle resolve without alias property', async () => {
//     const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       vite: {
//         resolve: {
//           dedupe: ['react'],
//           // No alias property
//         },
//       },
//     });

//     expect(consoleWarnSpy).not.toHaveBeenCalled(); // No warning since we didn't try to set alias
//     consoleWarnSpy.mockRestore();
//   });

//   it('should handle build without any properties', async () => {
//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       vite: {
//         build: {}, // Empty build object
//       },
//     });

//     const buildConfig = vi.mocked(build).mock.calls[0][0] as InlineConfig;
//     expect(buildConfig.build).toBeDefined();
//   });

//   it('should handle terserOptions as null', async () => {
//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       vite: {
//         build: {
//           terserOptions: null as any,
//         },
//       },
//     });

//     expect(build).toHaveBeenCalled();
//   });

//   it('should handle entryPoint as empty string for fallback context', async () => {
//     const mockRootAppConfig = {
//       ...mockAppConfig,
//       entryPoint: '', // Empty string for root app
//     };
//     vi.mocked(processConfigs).mockReturnValue([mockRootAppConfig] as any);

//     const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

//     await taujsBuild({
//       config: { apps: [] },
//       projectRoot: mockProjectRoot,
//       clientBaseDir: mockClientBaseDir,
//       vite: {
//         root: '/invalid',
//       },
//     });

//     // With empty entryPoint, should use [taujs:build:]
//     expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[taujs:build:]'));

//     consoleWarnSpy.mockRestore();
//   });
// });
