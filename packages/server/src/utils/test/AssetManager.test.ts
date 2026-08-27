// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ENTRY_EXTENSIONS, TEMPLATE } from '../../constants';
import { testRenderer } from '../../test/support/renderer';

const hoisted = vi.hoisted(() => ({
  // fs
  readFileMock: vi.fn<(p: string, enc: string) => Promise<string>>(),

  // node:fs - Finding 2 probes the render module by actual file existence
  existsSyncMock: vi.fn<(p: string) => boolean>(),

  // url
  pathToFileURLMock: vi.fn<(p: string) => { href: string }>(),

  // templates
  getCssLinksMock: vi.fn<(m: any, base: string) => string>(),
  getStaticModulePreloadLinksMock: vi.fn<(m: any, entryKey: string, base: string) => string>(),

  // logs
  resolveLogsMock: vi.fn<(l?: any) => any>(),
  loggerErrorMock: vi.fn(),
  noopLoggerErrorMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: hoisted.readFileMock,
}));

vi.mock('node:fs', () => ({
  existsSync: hoisted.existsSyncMock,
}));

vi.mock('url', () => ({
  pathToFileURL: hoisted.pathToFileURLMock,
}));

vi.mock('../Entry', () => ({
  resolveEntryFile: vi.fn((_clientRoot: string, stem: string) => `${stem}.tsx`),
}));

vi.mock('../Templates', () => ({
  getCssLinks: hoisted.getCssLinksMock,
  getStaticModulePreloadLinks: hoisted.getStaticModulePreloadLinksMock,
}));

vi.mock('../../core/logging/resolve', () => ({
  resolveLogs: hoisted.resolveLogsMock,
}));

vi.mock('../../core/errors/AppError', () => {
  // Mirrors the REAL static internal(message, cause?, details?, code?) shape (AppError.ts) so a
  // production call that gets the argument order wrong fails a test here too, instead of being
  // masked by a double that reshapes whatever it is handed.
  class AppError extends Error {
    code?: string;
    details?: unknown;
    override cause?: unknown;
    constructor(message: string, cause?: unknown, details?: unknown, code?: string) {
      super(message);
      this.name = 'AppError';
      this.details = details;
      this.code = code ?? 'INTERNAL';
      if (cause !== undefined) this.cause = cause;
    }
    static internal(message: string, cause?: unknown, details?: unknown, code?: string) {
      return new AppError(message, cause, details, code);
    }
    static isAppError(v: unknown) {
      return v instanceof AppError;
    }
  }
  return { AppError };
});

// Used by dynamic import in production success case. Renderer v1: the host now VALIDATES the loaded module
// against the app's declared renderer (key 'test' here, matching testRenderer()), so the render-fn doubles
// must carry the render-contract brand. (vi.mock is hoisted, so the brand is applied inline in the factory
// rather than via the support helper.)
vi.mock('/virtual/render-ok.js', () => {
  const TAG = Symbol.for('taujs.render-contract/v1');
  const brand = (fn: any) => {
    Object.defineProperty(fn, TAG, { value: { key: 'test', contractVersion: 'v1' }, enumerable: false });
    return fn;
  };
  return { renderSSR: brand(() => 'ok'), renderStream: brand(() => 'ok') };
});

async function importer(isDev: boolean) {
  vi.resetModules();

  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = isDev ? 'development' : 'production';

  vi.doMock('../../System', () => ({
    isDevelopment: isDev,
    runtimeMode: isDev ? 'development' : 'production',
  }));

  const mod = await import('../AssetManager');

  process.env.NODE_ENV = prev;
  return mod;
}

const {
  readFileMock,
  existsSyncMock,
  pathToFileURLMock,
  getCssLinksMock,
  getStaticModulePreloadLinksMock,
  resolveLogsMock,
  loggerErrorMock,
  noopLoggerErrorMock,
} = hoisted;

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
    templates: new Map<string, string>(),
    templateLoadFailures: new Map<string, unknown>(),
  };
}

beforeEach(() => {
  readFileMock.mockReset();
  existsSyncMock.mockReset();
  pathToFileURLMock.mockReset();
  getCssLinksMock.mockReset();
  getStaticModulePreloadLinksMock.mockReset();
  resolveLogsMock.mockReset();

  loggerErrorMock.mockReset();
  noopLoggerErrorMock.mockReset();

  // defaults
  resolveLogsMock.mockImplementation((l?: any) => l ?? makeNoopLogger());
  getCssLinksMock.mockReturnValue('[css-links]');
  getStaticModulePreloadLinksMock.mockReturnValue('[preload-links]');
  pathToFileURLMock.mockImplementation(() => ({ href: '/virtual/render-ok.js' }));
  // Finding 2 default: the `.js` candidate exists, matching every pre-existing happy-path cell
  // (they never mocked `node:fs` before this unit and always resolved via `.js`).
  existsSyncMock.mockReturnValue(true);
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

    // Regression pin: shipped defaults must be extensionless stems — resolveEntryFile
    // and findManifestEntry both append ENTRY_EXTENSIONS to them.
    expect(TEMPLATE.defaultEntryClient).toBe('entry-client');
    expect(TEMPLATE.defaultEntryServer).toBe('entry-server');

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
      maps.templates,
      { logger },
    );

    expect(resolveLogsMock).toHaveBeenCalledWith(logger);

    expect(maps.templates.get('/root/src/client/appA')).toBe('<html>dev A</html>');
    expect(maps.bootstrapModules.get('/root/src/client/appA')).toBe('/appA/entry-client.tsx');

    // dev skips these
    expect(maps.manifests.size).toBe(0);
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
      maps.templates,
      { logger },
    );

    expect(maps.bootstrapModules.get('/root/src/client')).toBe('/entry-client.tsx');
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

  it('retains the original template read failure and still loads a second app in the same call', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();
    const logger = makeLogger();

    const retained = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: '/root/src/client/appA/index.html' });

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s === '/root/src/client/appA/index.html') throw retained;
      if (s === '/root/src/client/appB/index.html') return '<html>dev B</html>';
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
      {
        clientRoot: '/root/src/client/appB',
        entryPoint: 'appB',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'b',
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
        maps.templates,
        { logger, templateLoadFailures: maps.templateLoadFailures },
      ),
    ).resolves.toBeUndefined();

    // the exact failing value, not a message or a copy
    expect(maps.templateLoadFailures.get('/root/src/client/appA')).toBe(retained);
    expect(maps.templates.has('/root/src/client/appA')).toBe(false);

    // continuation preserved: the second app in the same call still loads
    expect(maps.templates.get('/root/src/client/appB')).toBe('<html>dev B</html>');
    expect(maps.bootstrapModules.get('/root/src/client/appB')).toBe('/appB/entry-client.tsx');
  });

  it('retains a later dev failure only when the template itself was not stored (control)', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();
    const logger = makeLogger();

    readFileMock.mockResolvedValueOnce('<html>dev ok</html>');

    // The template read succeeds; a LATER step in the same try (resolveEntryFile) throws. The
    // failure must still be logged and swallowed in dev, but not retained - the template DID load.
    const Entry = await import('../Entry');
    vi.mocked(Entry.resolveEntryFile).mockImplementationOnce(() => {
      throw new Error('entry file missing');
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

    await expect(
      loadAssets(
        processed as any,
        '/root/src/client',
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.templates,
        { logger, templateLoadFailures: maps.templateLoadFailures },
      ),
    ).resolves.toBeUndefined();

    expect(loggerErrorMock).toHaveBeenCalledWith(expect.objectContaining({ stage: 'loadAssets:development' }), 'Asset load failed');

    expect(maps.templates.get('/root/src/client/appA')).toBe('<html>dev ok</html>');
    expect(maps.templateLoadFailures.has('/root/src/client/appA')).toBe(false);
  });
});

describe('loadAssets (production)', () => {
  it('the same template read failure still throws and nothing is retained (control)', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();
    const logger = makeLogger();

    const failure = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('/dist/client/appA/index.html')) throw failure;
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
        maps.templates,
        { logger, templateLoadFailures: maps.templateLoadFailures },
      ),
    ).rejects.toBe(failure);

    expect(maps.templateLoadFailures.size).toBe(0);
  });

  it('happy path: loads manifest, computes links, imports render module, stores everything', async () => {
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

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');

      // template comes from clientRoot (which in prod is dist/client/<entryPoint>)
      if (s.endsWith('/dist/client/appA/index.html')) return '<html>prod</html>';

      // prod manifest (client only - the ssr-manifest is no longer generated or read)
      if (s.endsWith('/dist/client/appA/.vite/manifest.json')) return JSON.stringify(manifest);

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
        renderer: testRenderer(),
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
      maps.templates,
      { logger },
    );

    expect(maps.templates.get('/root/dist/client/appA')).toBe('<html>prod</html>');
    expect(maps.manifests.get('/root/dist/client/appA')).toEqual(manifest);

    // adjustedRelativePath "/appA"
    expect(maps.bootstrapModules.get('/root/dist/client/appA')).toBe('/appA/assets/app.js');

    expect(getStaticModulePreloadLinksMock).toHaveBeenCalledWith(manifest, manifestKey, '/appA');
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

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('/dist/client/appA/index.html')) return '<html>prod</html>';
      if (s.endsWith('/dist/client/appA/.vite/manifest.json')) return JSON.stringify(badManifest);
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

    let caught: any;
    try {
      await loadAssets(
        processed as any,
        '/root/dist/client',
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.templates,
        { logger },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.details?.tried).toEqual(ENTRY_EXTENSIONS.map((e) => `entry-client${e}`));
    expect(caught.details?.availableKeys).toEqual(['other.tsx']);
    expect(caught.cause).toBeUndefined();

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

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('/dist/client/appA/index.html')) return '<html>prod</html>';
      if (s.endsWith('/dist/client/appA/.vite/manifest.json')) return JSON.stringify(manifest);
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
        renderer: testRenderer(),
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
    const manifestKey = `entry-client${ext}`;
    const manifest: any = {
      [manifestKey]: { file: 'assets/app.js' },
    };

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('/dist/client/index.html')) return '<html>prod root</html>';
      if (s.endsWith('/dist/client/.vite/manifest.json')) return JSON.stringify(manifest);
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
        renderer: testRenderer(),
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
      maps.templates,
      { logger },
    );

    expect(maps.bootstrapModules.get('/root/dist/client')).toBe('/assets/app.js');
    expect(getStaticModulePreloadLinksMock).toHaveBeenCalledWith(manifest, manifestKey, '');
    expect(getCssLinksMock).toHaveBeenCalledWith(manifest, '');
  });

  describe('.js/.mjs render module extension probe', () => {
    const ext = ENTRY_EXTENSIONS[0] ?? '.ts';
    const manifestForRenderModuleTests: any = { [`entry-client${ext}`]: { file: 'assets/app.js' } };
    const jsPath = '/root/dist/ssr/appA/entry-server.js';
    const mjsPath = '/root/dist/ssr/appA/entry-server.mjs';

    const makeProcessed = () => [
      {
        clientRoot: '/root/dist/client/appA',
        entryPoint: 'appA',
        entryClient: 'entry-client',
        entryServer: 'entry-server',
        htmlTemplate: 'index.html',
        appId: 'a',
        plugins: [],
        renderer: testRenderer(),
      },
    ];

    const mockManifestReads = () => {
      readFileMock.mockImplementation(async (p: string) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/dist/client/appA/index.html')) return '<html>prod</html>';
        if (s.endsWith('/dist/client/appA/.vite/manifest.json')) return JSON.stringify(manifestForRenderModuleTests);
        throw Object.assign(new Error('unexpected readFile path'), { path: s });
      });
    };

    it('resolves via .mjs when only .mjs exists on disk', async () => {
      const { loadAssets } = await importer(false);
      const maps = makeMaps();
      const logger = makeLogger();

      mockManifestReads();
      existsSyncMock.mockImplementation((p: string) => String(p).replace(/\\/g, '/') === mjsPath);

      await loadAssets(
        makeProcessed() as any,
        '/root/dist/client',
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.templates,
        { logger },
      );

      expect(pathToFileURLMock).toHaveBeenCalledTimes(1);
      expect(String(pathToFileURLMock.mock.calls[0]![0]).replace(/\\/g, '/')).toBe(mjsPath);
      expect(maps.renderModules.get('/root/dist/client/appA')).toEqual({ renderSSR: expect.any(Function), renderStream: expect.any(Function) });
    });

    it('prefers .js over .mjs when both exist (never hands .mjs to pathToFileURL)', async () => {
      const { loadAssets } = await importer(false);
      const maps = makeMaps();
      const logger = makeLogger();

      mockManifestReads();
      existsSyncMock.mockReturnValue(true); // both candidates "exist"

      await loadAssets(
        makeProcessed() as any,
        '/root/dist/client',
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.templates,
        { logger },
      );

      expect(pathToFileURLMock).toHaveBeenCalledTimes(1);
      expect(String(pathToFileURLMock.mock.calls[0]![0]).replace(/\\/g, '/')).toBe(jsPath);
    });

    it('throws AppError naming both tried candidates when neither extension exists, without attempting an import', async () => {
      const { loadAssets } = await importer(false);
      const maps = makeMaps();
      const logger = makeLogger();

      mockManifestReads();
      existsSyncMock.mockReturnValue(false);

      let caught: any;
      try {
        await loadAssets(
          makeProcessed() as any,
          '/root/dist/client',
          maps.bootstrapModules,
          maps.cssLinks,
          maps.manifests,
          maps.preloadLinks,
          maps.renderModules,
          maps.templates,
          { logger },
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught.details?.tried).toEqual([jsPath, mjsPath]);
      expect(caught.details?.clientRoot).toBe('/root/dist/client/appA');
      expect(caught.details?.entryServer).toBe('entry-server');
      expect(caught.details?.ssrDistPath).toBe('/root/dist/ssr/appA');
      expect(caught.cause).toBeUndefined();

      expect(pathToFileURLMock).not.toHaveBeenCalled();
    });

    it("reports the existing .js module's own evaluation failure and never falls through to .mjs", async () => {
      const { loadAssets } = await importer(false);
      const maps = makeMaps();
      const logger = makeLogger();

      mockManifestReads();
      existsSyncMock.mockImplementation((p: string) => String(p).replace(/\\/g, '/') === jsPath);
      pathToFileURLMock.mockReturnValueOnce({ href: '/virtual/render-missing.js' });

      let caught: any;
      try {
        await loadAssets(
          makeProcessed() as any,
          '/root/dist/client',
          maps.bootstrapModules,
          maps.cssLinks,
          maps.manifests,
          maps.preloadLinks,
          maps.renderModules,
          maps.templates,
          { logger },
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught.cause).toBeInstanceOf(Error);
      expect(caught.details?.moduleUrl).toBe('/virtual/render-missing.js');

      // .find() short-circuits at the first existing candidate, so existsSync is never consulted
      // for .mjs once .js is found to exist.
      expect(existsSyncMock).toHaveBeenCalledTimes(1);
      expect(pathToFileURLMock).toHaveBeenCalledTimes(1);
      expect(String(pathToFileURLMock.mock.calls[0]![0]).replace(/\\/g, '/')).toBe(jsPath);

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
    });
  });
});
