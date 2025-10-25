// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  readFileMock: vi.fn<(p: string, enc: string) => Promise<string>>(),
  pathToFileURLMock: vi.fn((p: string) => ({ href: '/virtual/render-ok.js' })),
  getCssLinksMock: vi.fn(() => '[css-links]'),
  renderPreloadLinksMock: vi.fn(() => '[preload-links]'),
  createLoggerMock: vi.fn(),
  loggerErrorMock: vi.fn(),
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

vi.mock('../../logging/AppError', () => {
  class AppError extends Error {
    code?: string;
    extra?: any;
    static internal(message: string, extra?: any) {
      const e = new AppError(message);
      (e as any).code = 'INTERNAL';
      (e as any).extra = extra;
      return e;
    }
  }
  return { AppError };
});

vi.mock('../../logging/Logger', () => ({
  createLogger: hoisted.createLoggerMock,
}));

async function importer(isDev = true) {
  vi.resetModules();

  vi.doMock('fs/promises', () => ({ readFile: hoisted.readFileMock }));
  vi.doMock('url', () => ({ pathToFileURL: hoisted.pathToFileURLMock }));
  vi.doMock('../Templates', () => ({
    getCssLinks: hoisted.getCssLinksMock,
    renderPreloadLinks: hoisted.renderPreloadLinksMock,
  }));
  vi.doMock('../../logging/AppError', () => {
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

  vi.doMock('../../logging/Logger', () => ({
    createLogger: hoisted.createLoggerMock,
  }));
  vi.doMock('../System', () => ({
    isDevelopment: isDev,
  }));

  return await import('../AssetManager');
}

const { readFileMock, pathToFileURLMock, getCssLinksMock, renderPreloadLinksMock, createLoggerMock, loggerErrorMock } = hoisted;

vi.mock('/virtual/render-ok.js', () => ({ default: { render: 'ok' } }));

beforeEach(() => {
  readFileMock.mockReset();
  pathToFileURLMock.mockReset().mockImplementation((p: string) => ({ href: '/virtual/render-ok.js' }));
  getCssLinksMock.mockReset().mockReturnValue('[css-links]');
  renderPreloadLinksMock.mockReset().mockReturnValue('[preload-links]');
  createLoggerMock.mockReset().mockReturnValue({ error: loggerErrorMock.mockReset() });
});

afterEach(() => {
  vi.clearAllMocks();
});

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

describe('createMaps & processConfigs', () => {
  it('createMaps returns distinct empty maps', async () => {
    const { createMaps } = await importer(true);
    const maps = createMaps();

    expect(maps).toBeDefined();

    for (const v of Object.values(maps)) {
      expect(v instanceof Map).toBe(true);
      expect((v as Map<any, any>).size).toBe(0);
    }
    const values = Object.values(maps);

    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(values[i]).not.toBe(values[j]);
      }
    }
  });

  it('processConfigs maps inputs and applies defaults from TEMPLATE', async () => {
    const { processConfigs } = await importer(true);
    const TEMPLATE = {
      defaultEntryClient: 'src/main',
      defaultEntryServer: 'src/server',
      defaultHtmlTemplate: 'index.html',
    } as any;

    const cfgs = [
      { appId: 'a', entryPoint: 'appA' },
      { appId: 'b', entryPoint: 'appB', entryClient: 'clientB', entryServer: 'serverB', htmlTemplate: 'custom.html' },
    ] as any;

    const res = processConfigs(cfgs, '/root', TEMPLATE);
    expect(res).toEqual([
      {
        appId: 'a',
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main',
        entryServer: 'src/server',
        htmlTemplate: 'index.html',
      },
      {
        appId: 'b',
        clientRoot: '/root/appB',
        entryPoint: 'appB',
        entryClient: 'clientB',
        entryServer: 'serverB',
        htmlTemplate: 'custom.html',
      },
    ]);
  });
});

describe('loadAssets (development)', () => {
  it('reads template and sets bootstrapModules to raw entryClient path with adjusted relative', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();

    readFileMock.mockImplementation(async (p: string, enc: string) => {
      if (String(p).endsWith('/appA/index.html')) return '<html>A</html>';
      throw Object.assign(new Error('unexpected path'), { path: p });
    });

    const processed = [
      {
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main.tsx',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'a',
      },
    ];

    await loadAssets(
      processed as any,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      { debug: false },
    );

    expect(maps.templates.get('/root/appA')).toBe('<html>A</html>');
    expect(maps.bootstrapModules.get('/root/appA')).toBe('/appA/src/main.tsx');

    expect(maps.manifests.size).toBe(0);
    expect(maps.ssrManifests.size).toBe(0);
    expect(maps.cssLinks.size).toBe(0);
    expect(maps.preloadLinks.size).toBe(0);
    expect(maps.renderModules.size).toBe(0);
  });

  it('dev: adjustedRelativePath empty when clientRoot === baseClientRoot', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();

    readFileMock.mockImplementation(async (p: string) => {
      if (String(p).endsWith('/index.html')) return '<html>dev root</html>';
      throw new Error('unexpected path');
    });

    const processed = [
      {
        clientRoot: '/root', // equals baseClientRoot below
        entryPoint: '',
        entryClient: 'src/main.tsx',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'root',
      },
    ];

    await loadAssets(
      processed as any,
      '/root', // baseClientRoot === clientRoot
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      { debug: false },
    );

    expect(maps.templates.get('/root')).toBe('<html>dev root</html>');
    // adjustedRelativePath === '' → '/'+''+'/'+entryClient then //→/ collapsed to single '/'
    expect(maps.bootstrapModules.get('/root')).toBe('/src/main.tsx');
  });
});

describe('loadAssets (production)', () => {
  it('happy path: loads manifest + ssr-manifest, computes links, imports render module, stores everything', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();

    const manifest = {
      'src/main.tsx': { file: 'assets/app.js' },
    };
    const ssrManifest = { some: 'data' };

    readFileMock.mockImplementation(async (p: string, enc: string) => {
      const s = String(p);
      if (s.endsWith('/appA/index.html')) return '<html>prod</html>';
      if (s.endsWith('/appA/.vite/manifest.json')) return JSON.stringify(manifest);
      if (s.endsWith('/appA/.vite/ssr-manifest.json')) return JSON.stringify(ssrManifest);

      throw Object.assign(new Error('unexpected readFile path'), { path: s });
    });

    const processed = [
      {
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'a',
      },
    ];

    await loadAssets(
      processed as any,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      { debug: { all: true } as any },
    );

    expect(maps.templates.get('/root/appA')).toBe('<html>prod</html>');
    expect(maps.manifests.get('/root/appA')).toEqual(manifest);
    expect(maps.ssrManifests.get('/root/appA')).toEqual(ssrManifest);

    expect(maps.bootstrapModules.get('/root/appA')).toBe('/appA/assets/app.js');

    expect(renderPreloadLinksMock).toHaveBeenCalledWith(ssrManifest, '/appA');
    expect(getCssLinksMock).toHaveBeenCalledWith(manifest, '/appA');

    expect(maps.preloadLinks.get('/root/appA')).toBe('[preload-links]');
    expect(maps.cssLinks.get('/root/appA')).toBe('[css-links]');

    expect(maps.renderModules.get('/root/appA')).toEqual({ default: { render: 'ok' } });
  });

  it('logs AppError when entry client is missing in manifest', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();

    const badManifest = {
      'other.tsx': { file: 'assets/other.js' },
    };
    const ssrManifest = {};

    readFileMock.mockImplementation(async (p: string, enc: string) => {
      const s = String(p);
      if (s.endsWith('/appA/index.html')) return '<html>prod</html>';
      if (s.endsWith('/appA/.vite/manifest.json')) return JSON.stringify(badManifest);
      if (s.endsWith('/appA/.vite/ssr-manifest.json')) return JSON.stringify(ssrManifest);
      throw Object.assign(new Error('unexpected path'), { path: s });
    });

    const processed = [
      {
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'a',
      },
    ];

    await loadAssets(
      processed as any,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {},
    );

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:production',
        error: expect.objectContaining({
          name: 'AppError',
          message: expect.stringContaining('Entry client file not found in manifest'),
          code: 'INTERNAL',
        }),
      }),
      'Asset load failed',
    );

    expect(maps.templates.get('/root/appA')).toBe('<html>prod</html>');
    expect(maps.bootstrapModules.size).toBe(0);
  });

  it('logs AppError when render module import fails', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();

    const manifest = { 'src/main.tsx': { file: 'assets/app.js' } };
    const ssrManifest = {};

    readFileMock.mockImplementation(async (p: string, enc: string) => {
      const s = String(p);
      if (s.endsWith('/appA/index.html')) return '<html>prod</html>';
      if (s.endsWith('/appA/.vite/manifest.json')) return JSON.stringify(manifest);
      if (s.endsWith('/appA/.vite/ssr-manifest.json')) return JSON.stringify(ssrManifest);
      throw Object.assign(new Error('unexpected path'), { path: s });
    });

    pathToFileURLMock.mockReturnValueOnce({ href: '/virtual/render-missing.js' });

    const processed = [
      {
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'a',
      },
    ];

    await loadAssets(
      processed as any,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {},
    );

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:production',
        error: expect.objectContaining({
          name: 'AppError',
          message: expect.stringContaining('Failed to load render module'),
          code: 'INTERNAL',
        }),
      }),
      'Asset load failed',
    );

    expect(maps.bootstrapModules.get('/root/appA')).toBe('/appA/assets/app.js');
  });

  it('prod: adjustedRelativePath empty passes "" to link helpers', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();

    const manifest = { 'src/main.tsx': { file: 'assets/app.js' } };
    const ssrManifest = { ok: true };

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith('/index.html')) return '<html>prod root</html>';
      if (s.endsWith('/.vite/manifest.json')) return JSON.stringify(manifest);
      if (s.endsWith('/.vite/ssr-manifest.json')) return JSON.stringify(ssrManifest);
      throw new Error('unexpected path');
    });

    const processed = [
      {
        clientRoot: '/root',
        entryPoint: '',
        entryClient: 'src/main',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'root',
      },
    ];

    await loadAssets(
      processed as any,
      '/root', // base === clientRoot → adjustedRelativePath === ''
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {},
    );

    expect(maps.bootstrapModules.get('/root')).toBe('/assets/app.js');
    expect(renderPreloadLinksMock).toHaveBeenCalledWith({ ok: true }, '');
    expect(getCssLinksMock).toHaveBeenCalledWith(manifest, '');
    expect(maps.preloadLinks.get('/root')).toBe('[preload-links]');
    expect(maps.cssLinks.get('/root')).toBe('[css-links]');
  });

  it('prod: logs non-AppError Error with structured fields', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();

    // Make manifest read throw a plain Error (not AppError)
    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith('/index.html')) return '<html></html>';
      if (s.endsWith('/.vite/manifest.json')) throw new Error('manifest-kaboom');
      return '';
    });

    const processed = [
      {
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'a',
      },
    ];

    await loadAssets(
      processed as any,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {},
    );

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

  it('prod: logs non-AppError non-Error as String(err)', async () => {
    const { loadAssets } = await importer(false);
    const maps = makeMaps();

    readFileMock.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith('/index.html')) return '<html></html>';
      if (s.endsWith('/.vite/manifest.json')) throw 'string-fail'; // not an Error
      return '';
    });

    const processed = [
      {
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'a',
      },
    ];

    await loadAssets(
      processed as any,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {},
    );

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:production',
        // When err is not an Error, code uses String(err)
        error: 'string-fail',
      }),
      'Asset load failed',
    );
  });

  it('dev: top-level catch logs String(err) when template read rejects with non-Error', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();

    // Non-Error rejection → hits `: String(err)` branch
    readFileMock.mockRejectedValueOnce('template-bad-string');

    const processed = [
      {
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main.tsx',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'a',
      },
    ];

    await loadAssets(
      processed as any,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {},
    );

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:config',
        error: 'template-bad-string', // <- String(err)
      }),
      'Failed to process config',
    );
  });

  it('dev: top-level catch String(err) for non-Error object', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();

    readFileMock.mockRejectedValueOnce({ reason: 'bad' });

    const processed = [
      { clientRoot: '/root/appA', entryPoint: 'appA', entryClient: 'src/main.tsx', entryServer: 'server/entry', htmlTemplate: 'index.html', appId: 'a' },
    ] as any;

    await loadAssets(
      processed,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {},
    );

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:config',
        error: '[object Object]', // String({ reason: 'bad' })
      }),
      'Failed to process config',
    );
  });
});

describe('loadAssets - top-level failure (template read fails)', () => {
  it('catches and logs with stage loadAssets:config', async () => {
    const { loadAssets } = await importer(true);
    const maps = makeMaps();

    readFileMock.mockRejectedValueOnce(new Error('template-bad'));

    const processed = [
      {
        clientRoot: '/root/appA',
        entryPoint: 'appA',
        entryClient: 'src/main.tsx',
        entryServer: 'server/entry',
        htmlTemplate: 'index.html',
        appId: 'a',
      },
    ];

    await loadAssets(
      processed as any,
      '/root',
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      {},
    );

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'loadAssets:config',
        error: expect.objectContaining({
          message: 'template-bad',
          name: 'Error',
        }),
      }),
      'Failed to process config',
    );

    expect(maps.templates.size).toBe(0);
  });
});
