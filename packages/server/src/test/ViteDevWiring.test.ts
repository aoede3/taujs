// @vitest-environment node
//
// VS4 (RFC 0005) - hard gate 3, dev half: the dev server consumes `config.vite` through the shared
// DEV_PROFILE engine. `resolveDevViteConfig` resolves the override ONCE with the serve context arm
// and `setupDevServer` applies the merged fragment to Vite's inline dev config. These tests drive
// the SAME two functions SSRServer wires together (resolve once -> pass the fragment in), with
// vite's `createServer`/`build` mocked so the resolved inline config is observable. The `define`
// symmetry claim drives ONE fixture through both dev and build.
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveDevViteConfig } from '../utils/ViteMergeEngine';
import type { TaujsViteConfig, TaujsViteContext, TaujsViteOverride } from '../ViteConfig';

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

// taujsBuild.deleteDist() does a REAL `rm(<projectRoot>/dist)` and this test passes
// projectRoot=process.cwd() (packages/server) - stub `rm` so it cannot delete the package's own built
// dist that dependent packages resolve at test time. Keep the rest of fs/promises real.
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

const projectRoot = process.cwd();
const clientBaseDir = path.join(projectRoot, 'src', 'client');

// Drive the exact SSRServer dev wiring: resolve `config.vite` ONCE (serve arm), then hand the merged
// fragment to `setupDevServer`. Returns the inline config vite's `createServer` was called with.
async function runDev(viteOverride?: TaujsViteOverride) {
  const { setupDevServer } = await import('../utils/DevServer');

  const viteConfig = resolveDevViteConfig({ viteOverride, clientRoot: clientBaseDir, appPlugins: [] });
  await setupDevServer({ app: makeApp(), clientRoot: clientBaseDir, debug: false, viteConfig });

  return createServerMock.mock.calls[0]![0] as any;
}

async function runBuild(viteOverride?: TaujsViteOverride) {
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
    },
  ];
  vi.mocked(setup.extractBuildConfigs).mockReturnValue(apps as any);
  vi.mocked(assets.processConfigs).mockReturnValue(apps as any);

  const { taujsBuild } = await import('../Build');
  await taujsBuild({ config: { apps: [], vite: viteOverride } as any, projectRoot, clientBaseDir, isSSRBuild: false });

  return buildMock.mock.calls[0]![0] as any;
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

describe('VS4 - config.vite.define reaches BOTH dev and build (symmetry claim)', () => {
  it('applies one fixture define to the dev inline config and to the build config', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const fixture: TaujsViteConfig = { define: { __APP_VERSION__: '"1.2.3"' } };

    const devConfig = await runDev(fixture);
    expect(devConfig.define.__APP_VERSION__).toBe('"1.2.3"');

    const buildConfig = await runBuild(fixture);
    expect(buildConfig.define.__APP_VERSION__).toBe('"1.2.3"');
  });
});

describe('VS4 - function form invoked once with the serve context arm', () => {
  it('invokes the vite() callback exactly ONCE with command "serve", no appId, for the dev boot', () => {
    const fn = vi.fn((_ctx: TaujsViteContext): TaujsViteConfig => ({ define: { __X__: '1' } }));

    resolveDevViteConfig({ viteOverride: fn, clientRoot: clientBaseDir, appPlugins: [] });

    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]![0];
    expect(ctx.command).toBe('serve');
    expect(ctx.mode).toBe('development');
    expect(ctx.isSSRBuild).toBe(false);
    expect(ctx.clientRoot).toBe(clientBaseDir);
    // The serve arm carries NO appId (per-app dev servers are rejected).
    expect((ctx as any).appId).toBeUndefined();
    expect((ctx as any).entryPoint).toBeUndefined();
  });
});

describe('VS4 - optimizeDeps is dev-only', () => {
  it('optimizeDeps.include reaches the dev inline config but is absent from the build config', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const fixture: TaujsViteConfig = { optimizeDeps: { include: ['legacy-cjs-dep'] } };

    const devConfig = await runDev(fixture);
    expect(devConfig.optimizeDeps.include).toContain('legacy-cjs-dep');

    const buildConfig = await runBuild(fixture);
    expect(buildConfig.optimizeDeps).toBeUndefined();
  });
});

describe('VS4 - dev invariants are protected: warned, never applied', () => {
  it('smuggled server / resolve.alias / root warn via the engine and do not reach the dev config', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The allowlist `TaujsViteConfig` type forbids all three; a JS/`as any` cast still reaches the
    // runtime engine, which must warn and drop them (RFC 0005 §4 - Protected in dev).
    const smuggled = {
      server: { port: 9999 },
      resolve: { alias: { '@evil': '/tmp/evil' } },
      root: '/tmp/not-the-root',
    } as unknown as TaujsViteConfig;

    const devConfig = await runDev(smuggled);

    // One aggregated warn line names every rejected field.
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('[taujs:dev]');
    expect(warned).toContain('server');
    expect(warned).toContain('resolve.alias');
    expect(warned).toContain('root');

    // None applied: dev keeps its own middlewareMode + hmr, its own root, and no smuggled alias.
    expect(devConfig.server.middlewareMode).toBe(true);
    expect(devConfig.server.hmr).toBeDefined();
    expect(devConfig.server.port).toBeUndefined();
    expect(devConfig.root).toBe(clientBaseDir);
    expect(devConfig.resolve.alias).not.toHaveProperty('@evil');
  });
});

describe('VS4 - scss modern-compiler default survives a user css merge', () => {
  it('deep-merges a user css.preprocessorOptions.scss without dropping the framework api default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const fixture: TaujsViteConfig = {
      css: { preprocessorOptions: { scss: { additionalData: '@use "shared/vars" as *;' } } },
    };

    const devConfig = await runDev(fixture);

    expect(devConfig.css.preprocessorOptions.scss.api).toBe('modern-compiler');
    expect(devConfig.css.preprocessorOptions.scss.additionalData).toBe('@use "shared/vars" as *;');
  });
});
