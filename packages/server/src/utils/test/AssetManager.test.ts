// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ENTRY_EXTENSIONS } from '../../constants';

const hoisted = vi.hoisted(() => ({
  // fs
  readFileMock: vi.fn<(p: string, enc: string) => Promise<string>>(),

  // url
  pathToFileURLMock: vi.fn<(p: string) => { href: string }>(),

  // templates
  getCssLinksMock: vi.fn<(m: any, base: string) => string>(),
  renderPreloadLinksMock: vi.fn<(m: any, base: string) => string>(),

  // logs
  resolveLogsMock: vi.fn<(l?: any) => any>(),
  loggerErrorMock: vi.fn(),
  noopLoggerErrorMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: hoisted.readFileMock,
}));

vi.mock('url', () => ({
  pathToFileURL: hoisted.pathToFileURLMock,
}));

vi.mock('../Templates', () => ({
  getCssLinks: hoisted.getCssLinksMock,
  renderPreloadLinks: hoisted.renderPreloadLinksMock,
}));

vi.mock('../../core/logging/resolve', () => ({
  resolveLogs: hoisted.resolveLogsMock,
}));

vi.mock('../../core/errors/AppError', () => {
  class AppError extends Error {
    code?: string;
    extra?: any;
    constructor(message: string) {
      super(message);
      this.name = 'AppError';
    }
    static internal(message: string, extra?: any) {
      const e = new AppError(message);
      (e as any).code = 'INTERNAL';
      (e as any).extra = extra;
      return e;
    }
  }
  return { AppError };
});

// Used by dynamic import in production success case
vi.mock('/virtual/render-ok.js', () => ({ renderSSR: () => 'ok', renderStream: () => 'ok' }));

async function importer(isDev: boolean) {
  vi.resetModules();

  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = isDev ? 'development' : 'production';

  vi.doMock('../../System', () => ({
    isDevelopment: isDev,
  }));

  const mod = await import('../AssetManager');

  process.env.NODE_ENV = prev;
  return mod;
}

const { readFileMock, pathToFileURLMock, getCssLinksMock, renderPreloadLinksMock, resolveLogsMock, loggerErrorMock, noopLoggerErrorMock } = hoisted;

const makeLogger = () => {
  const stub: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
    child: () => stub,
    isDebugEnabled: () => false,
  };
  return stub;
};

function makeNoopLogger() {
  const l: any = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: noopLoggerErrorMock,
    child: () => l,
    isDebugEnabled: () => false,
  };
  return l;
}

function makeMaps() {
  return {
    bootstrapModules: new Map<string, string>(),
    cssLinks: new Map<string, string>(),
    manifests: new Map<string, any>(),
    preloadLinks: new Map<string, string>(),
    renderModules: new Map<string, any>(),
    ssrManifests: new Map<string, any>(),
    templates: new Map<string, string>(),
  };
}

beforeEach(() => {
  readFileMock.mockReset();
  pathToFileURLMock.mockReset();
  getCssLinksMock.mockReset();
  renderPreloadLinksMock.mockReset();
  resolveLogsMock.mockReset();

  loggerErrorMock.mockReset();
  noopLoggerErrorMock.mockReset();

  // defaults
  resolveLogsMock.mockImplementation((l?: any) => l ?? makeNoopLogger());
  getCssLinksMock.mockReturnValue('[css-links]');
  renderPreloadLinksMock.mockReturnValue('[preload-links]');
  pathToFileURLMock.mockImplementation(() => ({ href: '/virtual/render-ok.js' }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createMaps & processConfigs', () => {
  it('createMaps returns distinct empty maps', async () => {
    const { createMaps } = await importer(true);
    const maps = createMaps();

    expect(maps).toBeDefined();

    for (const v of Object.values(maps)) {
      expect(v instanceof Map).toBe(true);
      expect((v as Map<any, any>).size).toBe(0);
    }

    // distinct instances
    const values = Object.values(maps);
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(values[i]).not.toBe(values[j]);
      }
    }
  });

  it('processConfigs maps inputs and applies TEMPLATE defaults (no file resolution side effects)', async () => {
    const { processConfigs } = await importer(true);

    const TEMPLATE = {
      defaultEntryClient: 'entry-client',
      defaultEntryServer: 'entry-server',
      defaultHtmlTemplate: 'index.html',
    } as any;

    const cfgs = [
      { appId: 'a', entryPoint: '' },
      { appId: 'b', entryPoint: 'admin', entryClient: 'client', entryServer: 'server', htmlTemplate: 'custom.html', plugins: ['p1'] },
    ] as any;

    const res = processConfigs(cfgs, '/root/src/client', TEMPLATE);

    expect(res).toEqual([
      {
        appId: 'a',
        clientRoot: '/root/src/client',
        entryPoint: '',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        plugins: [],
      },
      {
        appId: 'b',
        clientRoot: '/root/src/client/admin',
        entryPoint: 'admin',
        entryClient: 'client',
        entryServer: 'server',
        htmlTemplate: 'custom.html',
        plugins: ['p1'],
      },
    ]);
  });
});

describe('loadAssets (development)', () => {
  it('reads template and sets bootstrapModules using entryClient (with adjustedRelativePath)', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();
    const logger = makeLogger();

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s === '/root/src/client/appA/index.html') return '<html>dev A</html>';
      throw Object.assign(new Error('unexpected path'), { path: s });
    });

    const processed = [
      {
        clientRoot: '/root/src/client/appA',
        entryPoint: 'appA',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'a',
        plugins: [],
      },
    ];

    await loadAssets(
      processed as any,
      '/root/src/client',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      { logger },
    );

    expect(resolveLogsMock).toHaveBeenCalledWith(logger);

    expect(maps.templates.get('/root/src/client/appA')).toBe('<html>dev A</html>');
    expect(maps.bootstrapModules.get('/root/src/client/appA')).toBe('/appA/entry-client');

    // dev skips these
    expect(maps.manifests.size).toBe(0);
    expect(maps.ssrManifests.size).toBe(0);
    expect(maps.cssLinks.size).toBe(0);
    expect(maps.preloadLinks.size).toBe(0);
    expect(maps.renderModules.size).toBe(0);
  });

  it('adjustedRelativePath is empty when clientRoot === baseClientRoot', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();
    const logger = makeLogger();

    readFileMock.mockResolvedValueOnce('<html>dev root</html>');

    const processed = [
      {
        clientRoot: '/root/src/client',
        entryPoint: '',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'root',
        plugins: [],
      },
    ];

    await loadAssets(
      processed as any,
      '/root/src/client',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      { logger },
    );

    expect(maps.bootstrapModules.get('/root/src/client')).toBe('/entry-client');
  });

  it('dev: logs non-AppError non-Error as String(err) and does not throw', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();
    const logger = makeLogger();

    readFileMock.mockRejectedValueOnce({ reason: 'bad' }); // template read fails

    const processed = [
      {
        clientRoot: '/root/src/client/appA',
        entryPoint: 'appA',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'a',
        plugins: [],
      },
    ];

    await expect(
      loadAssets(
        processed as any,
        '/root/src/client',
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.ssrManifests,
        maps.templates,
        { logger },
      ),
    ).resolves.toBeUndefined();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:development',
        error: '[object Object]',
      }),
      'Asset load failed',
    );

    // template never stored
    expect(maps.templates.size).toBe(0);
  });
});

describe('loadAssets (production)', () => {
  it('happy path: loads manifest + ssr-manifest, computes links, imports render module, stores everything', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();
    const logger = makeLogger();

    // Pick one of ENTRY_EXTENSIONS to avoid coupling to the exact list
    const ext = ENTRY_EXTENSIONS[0] ?? '.ts';
    const stem = 'entry-client';
    const manifestKey = `${stem}${ext}`;

    const manifest: any = {
      [manifestKey]: { file: 'assets/app.js' },
    };
    const ssrManifest: any = { some: 'data' };

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');

      // template comes from clientRoot (which in prod is dist/client/<entryPoint>)
      if (s.endsWith('/dist/client/appA/index.html')) return '<html>prod</html>';

      // prod manifests
      if (s.endsWith('/dist/client/appA/.vite/manifest.json')) return JSON.stringify(manifest);
      if (s.endsWith('/dist/ssr/appA/.vite/ssr-manifest.json')) return JSON.stringify(ssrManifest);

      throw Object.assign(new Error('unexpected readFile path'), { path: s });
    });

    const processed = [
      {
        clientRoot: '/root/dist/client/appA',
        entryPoint: 'appA',
        entryClient: stem,
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'a',
        plugins: [],
      },
    ];

    await loadAssets(
      processed as any,
      '/root/dist/client',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      { logger },
    );

    expect(maps.templates.get('/root/dist/client/appA')).toBe('<html>prod</html>');
    expect(maps.manifests.get('/root/dist/client/appA')).toEqual(manifest);
    expect(maps.ssrManifests.get('/root/dist/client/appA')).toEqual(ssrManifest);

    // adjustedRelativePath "/appA"
    expect(maps.bootstrapModules.get('/root/dist/client/appA')).toBe('/appA/assets/app.js');

    expect(renderPreloadLinksMock).toHaveBeenCalledWith(ssrManifest, '/appA');
    expect(getCssLinksMock).toHaveBeenCalledWith(manifest, '/appA');

    expect(maps.preloadLinks.get('/root/dist/client/appA')).toBe('[preload-links]');
    expect(maps.cssLinks.get('/root/dist/client/appA')).toBe('[css-links]');

    expect(maps.renderModules.get('/root/dist/client/appA')).toEqual({ renderSSR: expect.any(Function), renderStream: expect.any(Function) });
  });

  it('throws AppError when entryClient cannot be found in manifest (and logs AppError shape)', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();
    const logger = makeLogger();

    const badManifest: any = {
      'other.tsx': { file: 'assets/other.js' },
    };
    const ssrManifest: any = {};

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('/dist/client/appA/index.html')) return '<html>prod</html>';
      if (s.endsWith('/dist/client/appA/.vite/manifest.json')) return JSON.stringify(badManifest);
      if (s.endsWith('/dist/ssr/appA/.vite/ssr-manifest.json')) return JSON.stringify(ssrManifest);
      throw Object.assign(new Error('unexpected path'), { path: s });
    });

    const processed = [
      {
        clientRoot: '/root/dist/client/appA',
        entryPoint: 'appA',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'a',
        plugins: [],
      },
    ];

    await expect(
      loadAssets(
        processed as any,
        '/root/dist/client',
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.ssrManifests,
        maps.templates,
        { logger },
      ),
    ).rejects.toBeTruthy();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:production',
        error: expect.objectContaining({
          name: 'AppError',
          code: 'INTERNAL',
          message: expect.stringContaining('Entry "entry-client" not found in manifest'),
        }),
      }),
      'Asset load failed',
    );
  });

  it('throws AppError when render module import fails (and logs AppError shape)', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();
    const logger = makeLogger();

    const ext = ENTRY_EXTENSIONS[0] ?? '.ts';
    const manifest: any = {
      [`entry-client${ext}`]: { file: 'assets/app.js' },
    };
    const ssrManifest: any = {};

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('/dist/client/appA/index.html')) return '<html>prod</html>';
      if (s.endsWith('/dist/client/appA/.vite/manifest.json')) return JSON.stringify(manifest);
      if (s.endsWith('/dist/ssr/appA/.vite/ssr-manifest.json')) return JSON.stringify(ssrManifest);
      return '';
    });

    // force dynamic import to fail
    pathToFileURLMock.mockReturnValueOnce({ href: '/virtual/render-missing.js' });

    const processed = [
      {
        clientRoot: '/root/dist/client/appA',
        entryPoint: 'appA',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'a',
        plugins: [],
      },
    ];

    await expect(
      loadAssets(
        processed as any,
        '/root/dist/client',
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.ssrManifests,
        maps.templates,
        { logger },
      ),
    ).rejects.toBeTruthy();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:production',
        error: expect.objectContaining({
          name: 'AppError',
          code: 'INTERNAL',
          message: expect.stringContaining('Failed to load render module'),
        }),
      }),
      'Asset load failed',
    );

    // it computed bootstrap before failing import
    expect(maps.bootstrapModules.get('/root/dist/client/appA')).toBe('/appA/assets/app.js');
  });

  it('logs non-AppError Error with structured fields and throws', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();
    const logger = makeLogger();

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('/dist/client/appA/index.html')) return '<html></html>';
      if (s.endsWith('/dist/client/appA/.vite/manifest.json')) throw new Error('manifest-kaboom');
      return '';
    });

    const processed = [
      {
        clientRoot: '/root/dist/client/appA',
        entryPoint: 'appA',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'a',
        plugins: [],
      },
    ];

    await expect(
      loadAssets(
        processed as any,
        '/root/dist/client',
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.ssrManifests,
        maps.templates,
        { logger },
      ),
    ).rejects.toBeTruthy();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:production',
        error: expect.objectContaining({
          name: 'Error',
          message: 'manifest-kaboom',
          stack: expect.any(String),
        }),
      }),
      'Asset load failed',
    );
  });

  it('adjustedRelativePath empty passes "" to link helpers and bootstrap path has no double slashes', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();
    const logger = makeLogger();

    const ext = ENTRY_EXTENSIONS[0] ?? '.ts';
    const manifest: any = {
      [`entry-client${ext}`]: { file: 'assets/app.js' },
    };
    const ssrManifest: any = { ok: true };

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('/dist/client/index.html')) return '<html>prod root</html>';
      if (s.endsWith('/dist/client/.vite/manifest.json')) return JSON.stringify(manifest);
      if (s.endsWith('/dist/ssr/.vite/ssr-manifest.json')) return JSON.stringify(ssrManifest);
      throw new Error(`unexpected path: ${s}`);
    });

    const processed = [
      {
        clientRoot: '/root/dist/client',
        entryPoint: '',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'root',
        plugins: [],
      },
    ];

    await loadAssets(
      processed as any,
      '/root/dist/client', // base === clientRoot → adjustedRelativePath === ''
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      { logger },
    );

    expect(maps.bootstrapModules.get('/root/dist/client')).toBe('/assets/app.js');
    expect(renderPreloadLinksMock).toHaveBeenCalledWith({ ok: true }, '');
    expect(getCssLinksMock).toHaveBeenCalledWith(manifest, '');
  });
});
