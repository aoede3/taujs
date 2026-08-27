// @vitest-environment node
//
// Finding 2 (real end-to-end pin): the other AssetManager.test.ts cells mock fs/url entirely, so
// they never prove a genuine `.mjs` module can actually be resolved and imported by Node - only
// that the resolver PICKS the right candidate path. This file mocks nothing except `../../System`
// (to force production mode, exactly like AssetManager.test.ts's own `importer`): a real temp
// directory tree, real `existsSync`, real `pathToFileURL`, and a real native `import()` of a
// genuine ES module written to disk as `entry-server.mjs` with no sibling `entry-server.js`.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTRY_EXTENSIONS } from '../../constants';
import { testRenderer } from '../../test/support/renderer';

async function importProductionAssetManager() {
  vi.resetModules();

  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  vi.doMock('../../System', () => ({
    isDevelopment: false,
    runtimeMode: 'production',
  }));

  const mod = await import('../AssetManager');

  process.env.NODE_ENV = prev;
  return mod;
}

describe('AssetManager: real .mjs render module (no mocks)', () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.doUnmock('../../System');
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('natively imports entry-server.mjs when no entry-server.js exists', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'taujs-mjs-'));

    const clientRoot = path.join(root, 'dist', 'client', 'appA');
    const ssrDir = path.join(root, 'dist', 'ssr', 'appA');

    await mkdir(path.join(clientRoot, '.vite'), { recursive: true });
    await mkdir(ssrDir, { recursive: true });

    await writeFile(path.join(clientRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>', 'utf-8');

    // ENTRY_EXTENSIONS drives the manifest key findManifestEntry probes for; pick the entry actually
    // used ('.tsx' is ENTRY_EXTENSIONS[1] today - checked directly rather than hardcoded).
    const manifestKey = `entry-client${ENTRY_EXTENSIONS.includes('.tsx' as (typeof ENTRY_EXTENSIONS)[number]) ? '.tsx' : ENTRY_EXTENSIONS[0]}`;
    await writeFile(path.join(clientRoot, '.vite', 'manifest.json'), JSON.stringify({ [manifestKey]: { file: 'assets/app.js' } }), 'utf-8');

    // A genuine ES module: real `export`, branded inline exactly as createRenderer() would brand it.
    // The key MUST equal testRenderer()'s key ('test') for assertRenderContract to accept it.
    const mjsSource = `
const TAG = Symbol.for('taujs.render-contract/v1');
function brand(fn) {
  Object.defineProperty(fn, TAG, { value: { key: 'test', contractVersion: 'v1' }, enumerable: false });
  return fn;
}
export const renderSSR = brand(async () => 'MJS_NATIVE_IMPORT_MARKER');
export const renderStream = brand(() => ({ abort() {}, done: Promise.resolve() }));
`;
    await writeFile(path.join(ssrDir, 'entry-server.mjs'), mjsSource, 'utf-8');
    // Deliberately no entry-server.js next to it.

    const { createMaps, loadAssets } = await importProductionAssetManager();
    const maps = createMaps();

    const processed = [
      {
        clientRoot,
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
        path.join(root, 'dist', 'client'),
        maps.bootstrapModules,
        maps.cssLinks,
        maps.manifests,
        maps.preloadLinks,
        maps.renderModules,
        maps.templates,
        {},
      ),
    ).resolves.toBeUndefined();

    const renderModule = maps.renderModules.get(clientRoot) as { renderSSR: () => Promise<string> } | undefined;
    expect(renderModule).toBeDefined();

    // Proves a real native import happened, not a mocked stand-in.
    await expect(renderModule!.renderSSR()).resolves.toBe('MJS_NATIVE_IMPORT_MARKER');
  });
});
