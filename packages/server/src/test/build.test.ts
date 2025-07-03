import path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vite from 'vite';
import { describe, it, beforeEach, vi, expect } from 'vitest';

import { taujsBuild } from '../build';

import type { Config } from '../build';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...(actual as Record<string, unknown>),
    rm: vi.fn(),
  };
});

vi.mock('vite', async () => {
  return {
    build: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../SSRServer', async () => {
  const original = await vi.importActual('../SSRServer');

  const mockProcessConfigs = vi.fn((configs: Config[]) =>
    configs.map((cfg) => ({
      ...cfg,
      clientRoot: path.resolve('test-client', cfg.entryPoint),
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
    })),
  );

  return {
    ...original,
    processConfigs: mockProcessConfigs,
    TEMPLATE: {},
    __mocked_processConfigs: mockProcessConfigs,
  };
});

import * as SSR from '../SSRServer';

declare module '../SSRServer' {
  export const __mocked_processConfigs: ReturnType<typeof vi.fn>;
}

const mockProcessConfigs = SSR.__mocked_processConfigs as ReturnType<typeof vi.fn>;

describe('taujsBuild', () => {
  const baseConfig: Config = {
    appId: 'test-app',
    entryPoint: 'test-entry',
  };

  const root = path.resolve();
  const clientBase = path.resolve('test-client');

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BUILD_MODE = ''; // avoid implicit SSR mode
  });

  it('deletes dist directory for non-SSR build', async () => {
    const fs = await import('node:fs/promises');

    await taujsBuild({
      configs: [baseConfig],
      projectRoot: root,
      clientBaseDir: clientBase,
      isSSRBuild: false,
    });

    expect(fs.rm).toHaveBeenCalledWith(path.resolve(root, 'dist'), {
      recursive: true,
      force: true,
    });
  });

  it('skips dist deletion for SSR build', async () => {
    const fs = await import('node:fs/promises');

    await taujsBuild({
      configs: [baseConfig],
      projectRoot: root,
      clientBaseDir: clientBase,
      isSSRBuild: true,
    });

    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('supports multiple configs with and without entryPoint', async () => {
    const configs: Config[] = [
      { appId: 'app1', entryPoint: 'foo' },
      { appId: 'app2', entryPoint: '' },
    ];

    await taujsBuild({
      configs,
      projectRoot: root,
      clientBaseDir: clientBase,
      isSSRBuild: false,
    });

    expect(mockProcessConfigs).toHaveBeenCalledWith(configs, clientBase, expect.anything());
    expect(vite.build).toHaveBeenCalledTimes(2);
  });

  it('handles optional plugins', async () => {
    const configWithPlugins: Config = {
      appId: 'test-app',
      entryPoint: 'test-entry',
      plugins: [{ name: 'customPlugin' }],
    };

    await taujsBuild({
      configs: [configWithPlugins],
      projectRoot: root,
      clientBaseDir: clientBase,
      isSSRBuild: false,
    });

    expect(vite.build).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.arrayContaining([expect.objectContaining({ name: 'customPlugin' })]),
      }),
    );
  });

  it('handles fs.rm error gracefully', async () => {
    const fs = await import('node:fs/promises');
    const err = new Error('Permission denied');
    (fs.rm as any).mockRejectedValueOnce(err);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await taujsBuild({
      configs: [baseConfig],
      projectRoot: root,
      clientBaseDir: clientBase,
      isSSRBuild: false,
    });

    expect(errorSpy).toHaveBeenCalledWith('Error deleting dist directory:', err);
    errorSpy.mockRestore();
  });

  it('logs build start and completion', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await taujsBuild({
      configs: [baseConfig],
      projectRoot: root,
      clientBaseDir: clientBase,
      isSSRBuild: false,
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Building for entryPoint: "test-entry"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Build complete for entryPoint: "test-entry"'));

    logSpy.mockRestore();
  });

  it('logs build error and exits', async () => {
    const error = new Error('build failed');
    (vite.build as any).mockRejectedValueOnce(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit was called'); // stop test
    });

    await expect(() =>
      taujsBuild({
        configs: [baseConfig],
        projectRoot: root,
        clientBaseDir: clientBase,
        isSSRBuild: false,
      }),
    ).rejects.toThrow('process.exit was called');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error building for entryPoint'), error);
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('executes the /api proxy rewrite function', async () => {
    const configWithPlugins: Config = {
      appId: 'test-app',
      entryPoint: 'test-entry',
    };

    await taujsBuild({
      configs: [configWithPlugins],
      projectRoot: root,
      clientBaseDir: clientBase,
      isSSRBuild: false,
    });

    const lastBuildCall = (vite.build as import('vitest').Mock).mock.calls.at(-1)?.[0];
    const rewrite = lastBuildCall?.server?.proxy?.['/api']?.rewrite;

    expect(rewrite('/api/test/123')).toBe('/test/123');
  });
});
