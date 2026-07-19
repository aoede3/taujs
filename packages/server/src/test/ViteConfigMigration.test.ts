// @vitest-environment node
//
// VS1 (RFC 0005) - hard gate 1: no vite.config.* is ever read by τjs in dev or build, and a
// file sitting in a formerly-probed location triggers a targeted migration warning. These
// tests use real on-disk temp directories so the whole detection path (real existsSync) is
// exercised; project-root files are exempt because Vite never probed them on τjs's behalf.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testRenderer } from './support/renderer';

const MARKER_PLUGIN_NAME = 'vs1-marker-plugin';

const VITE_CONFIG_SOURCE = `export default { plugins: [{ name: '${MARKER_PLUGIN_NAME}' }] };\n`;

const hoisted = vi.hoisted(() => ({
  createServerMock: vi.fn(),
  buildMock: vi.fn(),
  createLoggerMock: vi.fn(),
  overrideCSSHMRConsoleErrorMock: vi.fn(),
  emitGraphArtifactMock: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('vite', () => ({
  createServer: hoisted.createServerMock,
  build: hoisted.buildMock,
}));

vi.mock('../logging/Logger', () => ({
  createLogger: hoisted.createLoggerMock,
}));

vi.mock('../utils/Templates', () => ({
  overrideCSSHMRConsoleError: hoisted.overrideCSSHMRConsoleErrorMock,
}));

vi.mock('../core/config/Setup', () => ({
  extractBuildConfigs: vi.fn(),
}));

vi.mock('../utils/AssetManager', () => ({
  processConfigs: vi.fn(),
}));

vi.mock('../utils/Entry', () => ({
  resolveEntryFile: vi.fn((_clientRoot: string, stem: string) => `${stem}.tsx`),
}));

vi.mock('../core/introspection/EmitGraph', () => ({
  emitGraphArtifact: hoisted.emitGraphArtifactMock,
}));

const { createServerMock, buildMock, createLoggerMock, overrideCSSHMRConsoleErrorMock, emitGraphArtifactMock, logger } = hoisted;

function makeApp() {
  const hooks: Record<string, Function[]> = {};
  return {
    hooks,
    addHook: (name: string, fn: Function) => {
      (hooks[name] ||= []).push(fn);
    },
  } as any;
}

function pluginNames(plugins: unknown): string[] {
  if (!Array.isArray(plugins)) return [];
  return plugins.map((p) => (p && typeof p === 'object' ? ((p as any).name ?? '') : '')).filter(Boolean);
}

let tmpRoot: string;

beforeEach(() => {
  vi.resetModules();

  createServerMock.mockReset().mockImplementation(async () => ({
    middlewares: Object.assign((_req: any, _res: any, next: Function) => next(), { use: vi.fn() }),
  }));
  buildMock.mockReset().mockResolvedValue({} as any);
  emitGraphArtifactMock.mockReset().mockResolvedValue(true);
  overrideCSSHMRConsoleErrorMock.mockReset();

  createLoggerMock.mockReset().mockReturnValue(logger);
  logger.debug.mockReset();
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();

  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'taujs-vs1-'));
});

afterEach(() => {
  // restore (not just clear): the console.log/warn spies below must not leak into other suites
  vi.restoreAllMocks();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('VS1 - dev server closes config-file discovery', () => {
  it('pins configFile: false, never surfaces a client-root vite.config marker, and warns naming the file', async () => {
    const baseClientRoot = path.join(tmpRoot, 'src', 'client');
    mkdirSync(baseClientRoot, { recursive: true });
    const planted = path.join(baseClientRoot, 'vite.config.ts');
    writeFileSync(planted, VITE_CONFIG_SOURCE);

    const { setupDevServer } = await import('../utils/DevServer');
    await setupDevServer({ app: makeApp(), clientRoot: baseClientRoot, debug: false });

    expect(createServerMock).toHaveBeenCalledTimes(1);
    const cfg = createServerMock.mock.calls[0]![0];

    // configFile is pinned off - Vite's discovery is disabled deterministically.
    expect(cfg.configFile).toBe(false);

    // The planted marker never reaches the resolved dev plugin list.
    expect(pluginNames(cfg.plugins)).not.toContain(MARKER_PLUGIN_NAME);

    // Migration warning fires, naming the exact file.
    const warnedWithFile = logger.warn.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes(planted) && arg.includes('no longer reads')),
    );
    expect(warnedWithFile).toBe(true);
  });

  it('does not warn when only a project-root vite.config exists (exempt - never probed)', async () => {
    const baseClientRoot = path.join(tmpRoot, 'src', 'client');
    mkdirSync(baseClientRoot, { recursive: true });
    // Planted at the PROJECT root, not the client base root.
    writeFileSync(path.join(tmpRoot, 'vite.config.ts'), VITE_CONFIG_SOURCE);

    const { setupDevServer } = await import('../utils/DevServer');
    await setupDevServer({ app: makeApp(), clientRoot: baseClientRoot, debug: false });

    expect(createServerMock.mock.calls[0]![0].configFile).toBe(false);
    const anyMigrationWarn = logger.warn.mock.calls.some((call) => call.some((arg) => typeof arg === 'string' && arg.includes('no longer reads')));
    expect(anyMigrationWarn).toBe(false);
  });
});

describe('VS1 - build closes config-file discovery', () => {
  async function runBuild(appConfig: any, clientBaseDir: string) {
    const { taujsBuild } = await import('../Build');
    const setup = await import('../core/config/Setup');
    const assets = await import('../utils/AssetManager');
    vi.mocked(setup.extractBuildConfigs).mockReturnValue([appConfig] as any);
    vi.mocked(assets.processConfigs).mockReturnValue([appConfig] as any);

    await taujsBuild({
      config: { apps: [] } as any,
      projectRoot: tmpRoot,
      clientBaseDir,
      isSSRBuild: false,
    });
  }

  it('pins configFile: false, never surfaces a per-entry-root vite.config marker, and warns naming the file', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const clientBaseDir = path.join(tmpRoot, 'src', 'client');
    const perEntryRoot = path.join(clientBaseDir, 'admin');
    mkdirSync(perEntryRoot, { recursive: true });
    const planted = path.join(perEntryRoot, 'vite.config.ts');
    writeFileSync(planted, VITE_CONFIG_SOURCE);

    await runBuild(
      {
        appId: 'admin-app',
        entryPoint: 'admin',
        clientRoot: perEntryRoot,
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
        renderer: testRenderer(),
      },
      clientBaseDir,
    );

    expect(buildMock).toHaveBeenCalledTimes(1);
    const cfg = buildMock.mock.calls[0]![0];

    expect(cfg.configFile).toBe(false);
    expect(pluginNames(cfg.plugins)).not.toContain(MARKER_PLUGIN_NAME);

    const warnedWithFile = consoleWarnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes(planted) && msg.includes('no longer reads'));
    expect(warnedWithFile).toBe(true);

    consoleWarnSpy.mockRestore();
  });

  it('does not warn when only a project-root vite.config exists (exempt - never probed), and still builds', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const clientBaseDir = path.join(tmpRoot, 'src', 'client');
    const perEntryRoot = path.join(clientBaseDir, 'admin');
    mkdirSync(perEntryRoot, { recursive: true });
    // Planted at the PROJECT root only.
    writeFileSync(path.join(tmpRoot, 'vite.config.ts'), VITE_CONFIG_SOURCE);

    await runBuild(
      {
        appId: 'admin-app',
        entryPoint: 'admin',
        clientRoot: perEntryRoot,
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
        renderer: testRenderer(),
      },
      clientBaseDir,
    );

    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(buildMock.mock.calls[0]![0].configFile).toBe(false);

    const anyMigrationWarn = consoleWarnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('no longer reads'));
    expect(anyMigrationWarn).toBe(false);

    consoleWarnSpy.mockRestore();
  });
});
