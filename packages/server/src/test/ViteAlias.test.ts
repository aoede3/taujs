// @vitest-environment node
//
// VS5 (RFC 0005) - hard gate 4: one declarative `alias` resolves IDENTICALLY in dev and build.
// The shared layering (`utils/ViteAlias.ts`) is sourced by BOTH `setupDevServer` (dev) and
// `taujsBuild` (build); these tests exercise the pure layering, then drive both real call paths
// with the SAME `config.alias` and assert the resolved absolute path is equal (not merely present).
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { layerAlias, normaliseDeclarativeAlias } from '../utils/ViteAlias';
import { testRenderer } from './support/renderer';

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

// taujsBuild.deleteDist() does a REAL `rm(<projectRoot>/dist)`; these tests pass projectRoot=process.cwd()
// (packages/server), which would delete the package's own built dist that dependent packages
// (fixtures/renderer-composition) resolve at test time. Stub `rm` only; keep the rest of fs/promises real.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rm: vi.fn(async () => {}),
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VS5 - shared alias layering (utils/ViteAlias)', () => {
  it('normalises a relative declarative value against the project root; an absolute value passes through', () => {
    const projectRoot = path.join('/', 'project');

    const out = normaliseDeclarativeAlias({ '@rel': './src/client/shared', '@abs': path.join('/', 'elsewhere', 'x') }, projectRoot);

    expect(out['@rel']).toBe(path.resolve(projectRoot, './src/client/shared'));
    expect(out['@abs']).toBe(path.join('/', 'elsewhere', 'x'));
  });

  it('layers framework -> declarative -> programmatic: later layers win per key, others survive', () => {
    const onDeclarativeOverride = vi.fn();

    const result = layerAlias({
      defaults: { '@client': '/fw/client', '@server': '/fw/server', '@shared': '/fw/shared' },
      declarative: { '@server': path.join('/', 'decl', 'server'), '@declOnly': path.join('/', 'decl', 'only') },
      programmatic: { '@server': path.join('/', 'prog', 'server'), '@progOnly': path.join('/', 'prog', 'only') },
      projectRoot: path.join('/', 'project'),
      onDeclarativeOverride,
    });

    // Framework defaults survive where no later layer touches them.
    expect(result['@client']).toBe('/fw/client');
    expect(result['@shared']).toBe('/fw/shared');
    // Declarative overrides the framework default; programmatic overrides the declarative one.
    expect(result['@server']).toBe(path.join('/', 'prog', 'server'));
    // Unrelated keys from the declarative and programmatic layers both coexist.
    expect(result['@declOnly']).toBe(path.join('/', 'decl', 'only'));
    expect(result['@progOnly']).toBe(path.join('/', 'prog', 'only'));

    // The declarative-vs-programmatic conflict is surfaced once, for the debug logger only.
    expect(onDeclarativeOverride).toHaveBeenCalledTimes(1);
    expect(onDeclarativeOverride).toHaveBeenCalledWith('@server', path.join('/', 'decl', 'server'), path.join('/', 'prog', 'server'));
  });

  it('does not report a conflict when programmatic and declarative resolve to the same value', () => {
    const onDeclarativeOverride = vi.fn();

    layerAlias({
      defaults: {},
      declarative: { '@x': path.join('/', 'same') },
      programmatic: { '@x': path.join('/', 'same') },
      projectRoot: path.join('/', 'project'),
      onDeclarativeOverride,
    });

    expect(onDeclarativeOverride).not.toHaveBeenCalled();
  });
});

describe('VS5 - hard gate 4: declarative alias resolves identically in dev and build', () => {
  // projectRoot === process.cwd() here, the scaffold invariant; dev's projectRoot option
  // defaults to process.cwd() when not threaded (see the monorepo-shape test below for the
  // explicit-threading case where the two directories differ).
  const projectRoot = process.cwd();
  const clientBaseDir = path.join(projectRoot, 'src', 'client');
  const relativeAlias = { '@components': './src/client/shared/components' };
  const expectedAbsolute = path.resolve(projectRoot, './src/client/shared/components');

  async function runDev(declarativeAlias?: Record<string, string>, programmaticAlias?: Record<string, string>, devProjectRoot?: string) {
    const { setupDevServer } = await import('../utils/DevServer');
    await setupDevServer({
      app: makeApp(),
      clientRoot: clientBaseDir,
      alias: programmaticAlias,
      debug: false,
      declarativeAlias,
      projectRoot: devProjectRoot,
    });

    return createServerMock.mock.calls[0]![0].resolve.alias as Record<string, string>;
  }

  async function runBuildApps(apps: any[], config: any, buildProjectRoot: string = projectRoot) {
    const setup = await import('../core/config/Setup');
    const assets = await import('../utils/AssetManager');
    vi.mocked(setup.extractBuildConfigs).mockReturnValue(apps as any);
    vi.mocked(assets.processConfigs).mockReturnValue(apps as any);

    const { taujsBuild } = await import('../Build');
    await taujsBuild({ config, projectRoot: buildProjectRoot, clientBaseDir, isSSRBuild: false });

    return buildMock.mock.calls.map((call) => (call[0] as any).resolve.alias as Record<string, string>);
  }

  it('resolves a relative declarative alias to the SAME absolute path in dev and in every app build config', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const devAlias = await runDev(relativeAlias);

    const apps = [
      {
        appId: 'main',
        entryPoint: '',
        clientRoot: clientBaseDir,
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
        renderer: testRenderer(),
      },
      {
        appId: 'admin',
        entryPoint: 'admin',
        clientRoot: path.join(clientBaseDir, 'admin'),
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
        renderer: testRenderer(),
      },
    ];
    const buildAliases = await runBuildApps(apps, { apps: [], alias: relativeAlias });

    // Dev resolved the relative value to an absolute path.
    expect(devAlias['@components']).toBe(expectedAbsolute);

    // Every app's build config resolved it to the SAME absolute path (equality, not presence).
    expect(buildAliases).toHaveLength(2);
    for (const buildAlias of buildAliases) {
      expect(buildAlias['@components']).toBe(expectedAbsolute);
      expect(buildAlias['@components']).toBe(devAlias['@components']);
    }
  });

  it('monorepo shape: an explicit dev projectRoot (differing from cwd) matches a build with the same projectRoot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // The maintainer-review scenario: process runs from /repo, the app's projectRoot is deeper.
    const monorepoAppRoot = path.join(process.cwd(), 'apps', 'shop');
    expect(monorepoAppRoot).not.toBe(process.cwd());
    const expected = path.resolve(monorepoAppRoot, './src/components');

    const devAlias = await runDev({ '@mono': './src/components' }, undefined, monorepoAppRoot);
    expect(devAlias['@mono']).toBe(expected);
    // And explicitly NOT the cwd-based resolution the un-threaded default would produce.
    expect(devAlias['@mono']).not.toBe(path.resolve(process.cwd(), './src/components'));

    const apps = [
      {
        appId: 'shop',
        entryPoint: '',
        clientRoot: clientBaseDir,
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
        renderer: testRenderer(),
      },
    ];
    const buildAliases = await runBuildApps(apps, { apps: [], alias: { '@mono': './src/components' } }, monorepoAppRoot);
    expect(buildAliases[0]!['@mono']).toBe(expected);
    expect(buildAliases[0]!['@mono']).toBe(devAlias['@mono']);
  });

  it('passes an absolute declarative alias through untouched in both dev and build', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const absolute = path.join('/', 'opt', 'shared', 'components');
    const absoluteAlias = { '@components': absolute };

    const devAlias = await runDev(absoluteAlias);

    const apps = [
      {
        appId: 'main',
        entryPoint: '',
        clientRoot: clientBaseDir,
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
        renderer: testRenderer(),
      },
    ];
    const buildAliases = await runBuildApps(apps, { apps: [], alias: absoluteAlias });

    expect(devAlias['@components']).toBe(absolute);
    expect(buildAliases[0]!['@components']).toBe(absolute);
  });

  it('programmatic alias wins over the declarative one per key, in both dev and build', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    const declarative = { '@server': './declarative/server' };
    const programmatic = { '@server': path.join('/', 'programmatic', 'server') };

    const devAlias = await runDev(declarative, programmatic);
    expect(devAlias['@server']).toBe(path.join('/', 'programmatic', 'server'));

    // Build side: programmatic `taujsBuild({ alias })` over declarative `config.alias`.
    const setup = await import('../core/config/Setup');
    const assets = await import('../utils/AssetManager');
    const apps = [
      {
        appId: 'main',
        entryPoint: '',
        clientRoot: clientBaseDir,
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
        renderer: testRenderer(),
      },
    ];
    vi.mocked(setup.extractBuildConfigs).mockReturnValue(apps as any);
    vi.mocked(assets.processConfigs).mockReturnValue(apps as any);

    const { taujsBuild } = await import('../Build');
    await taujsBuild({ config: { apps: [], alias: declarative } as any, projectRoot, clientBaseDir, isSSRBuild: false, alias: programmatic });

    const buildAlias = (buildMock.mock.calls[0]![0] as any).resolve.alias as Record<string, string>;
    expect(buildAlias['@server']).toBe(path.join('/', 'programmatic', 'server'));
  });
});

describe('VS5 - smuggled resolve.alias still warns via the legacy taujsBuild vite type', () => {
  it('rejects and warns about resolve.alias supplied through taujsBuild({ vite })', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const apps = [
      {
        appId: 'main',
        entryPoint: '',
        clientRoot: path.join(process.cwd(), 'src', 'client'),
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
        renderer: testRenderer(),
      },
    ];
    const setup = await import('../core/config/Setup');
    const assets = await import('../utils/AssetManager');
    vi.mocked(setup.extractBuildConfigs).mockReturnValue(apps as any);
    vi.mocked(assets.processConfigs).mockReturnValue(apps as any);

    const { taujsBuild } = await import('../Build');
    await taujsBuild({
      config: { apps: [] } as any,
      projectRoot: process.cwd(),
      clientBaseDir: path.join(process.cwd(), 'src', 'client'),
      isSSRBuild: false,
      // The VS2 `TaujsViteConfig` type forbids `resolve.alias`; the legacy `ViteConfigOverride`
      // (Partial<InlineConfig>) still admits it structurally, so the runtime engine must warn.
      vite: { resolve: { alias: { '@smuggled': '/wrong/path' } } } as any,
    });

    const buildAlias = (buildMock.mock.calls[0]![0] as any).resolve.alias as Record<string, string>;
    expect(buildAlias).not.toHaveProperty('@smuggled');
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('resolve.alias'));
  });
});
