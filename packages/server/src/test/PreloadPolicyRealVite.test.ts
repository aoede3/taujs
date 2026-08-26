// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getCssLinks, getStaticModulePreloadLinks } from '../utils/Templates';
import { testRenderer } from './support/renderer';

import type { Manifest } from '../types';

/**
 * The evidence the preload policy rests on, against a manifest REAL Vite actually emitted.
 *
 * `vite` is deliberately NOT mocked. The defect this replaces survived for the life of the feature
 * because its only test fed `renderPreloadLinks` a HAND-WRITTEN manifest whose values happened to
 * follow the opposite prefixing convention to the real thing, and because no fixture in the repo
 * has a lazy import - so every in-repo SSR manifest mapped every module to `[]` and the mechanism
 * never emitted a link. Hand-built fixtures cannot pin this; only a real build can.
 */
const appConfigs = [
  {
    appId: 'web',
    entryPoint: '',
    clientRoot: '',
    entryClient: 'entry-client',
    entryServer: 'entry-server',
    htmlTemplate: 'index.html',
    plugins: [],
    renderer: testRenderer(),
  },
];

vi.mock('../utils/AssetManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/AssetManager')>()),
  processConfigs: vi.fn(() => appConfigs),
}));

let projectRoot: string;
let clientBaseDir: string;

beforeEach(async () => {
  vi.resetModules();
  projectRoot = await mkdtemp(path.join(tmpdir(), 'taujs-preload-'));
  clientBaseDir = path.join(projectRoot, 'src/client');
  appConfigs[0]!.clientRoot = clientBaseDir;
  appConfigs[0]!.entryPoint = '';

  await mkdir(clientBaseDir, { recursive: true });

  // A statically imported module FORCED into its own chunk (so it appears under `imports`), a
  // dynamically imported one (so it appears under `dynamicImports`), and a stylesheet.
  //
  // The module bodies are deliberately substantial and side-effecting. A first attempt used trivial
  // constants and Rolldown inlined and tree-shook the lot into a single 0-byte chunk, so the
  // manifest had no `imports` and no `dynamicImports` at all - and the cells below still passed,
  // because iterating an empty list asserts nothing. Both problems are fixed here: real work that
  // survives, and an explicit non-empty assertion before the loops.
  await writeFile(path.join(clientBaseDir, 'styles.css'), '.a{color:red}\n', 'utf8');
  await writeFile(
    path.join(clientBaseDir, 'shared-static.js'),
    'export function sharedWork(n) {\n  let total = 0;\n  for (let i = 0; i < n; i++) total += Math.sin(i) * Math.cos(i) * Math.tan(i % 7);\n  return `shared:${total.toFixed(4)}`;\n}\n',
    'utf8',
  );
  await writeFile(
    path.join(clientBaseDir, 'lazy-route.js'),
    'export function lazyWork(n) {\n  let total = 0;\n  for (let i = 0; i < n; i++) total += Math.log(i + 1) * Math.sqrt(i + 2);\n  return `lazy:${total.toFixed(4)}`;\n}\n',
    'utf8',
  );
  await writeFile(
    path.join(clientBaseDir, 'entry-client.tsx'),
    `import './styles.css';\nimport { sharedWork } from './shared-static.js';\nglobalThis.__taujsBoot = async (n) => {\n  const { lazyWork } = await import('./lazy-route.js');\n  return sharedWork(n) + lazyWork(n);\n};\n`,
    'utf8',
  );
  await writeFile(path.join(clientBaseDir, 'entry-server.tsx'), 'export const server = 1;\n', 'utf8');

  delete process.env.BUILD_MODE;
  delete process.env.TAUJS_APP;
  delete process.env.TAUJS_APPS;
});

const buildClient = async () => {
  const { taujsBuild } = await import('../Build');

  await taujsBuild({
    config: { apps: [{ appId: 'web', entryPoint: appConfigs[0]!.entryPoint, routes: [{ path: '/' }] }] },
    projectRoot,
    clientBaseDir,
    // Function form only - the object form is rejected at the configuration boundary. This forces
    // the statically imported module into its own chunk so it appears in the manifest's `imports`;
    // without it Vite inlines a single static import into the entry chunk and there is nothing to
    // preload, which is precisely why no existing fixture exercises this path.
    vite: { build: { rollupOptions: { output: { manualChunks: (id: string) => (id.includes('shared-static') ? 'shared-static' : undefined) } } } },
  });

  const clientDist = path.join(projectRoot, 'dist', 'client', appConfigs[0]!.entryPoint);
  const manifest = JSON.parse(await readFile(path.join(clientDist, '.vite', 'manifest.json'), 'utf8')) as Manifest;
  const entryKey = Object.keys(manifest).find((k) => k.endsWith('entry-client.tsx'))!;

  return { clientDist, manifest, entryKey };
};

const hrefsOf = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

/**
 * A browser resolves an href against the DOCUMENT, not against the site root. An earlier version of
 * this check asserted `href.startsWith(basePath ? `${basePath}/` : '')` - and EVERY string starts
 * with `''`, so at the default coordinate it asserted nothing at all and blessed relative hrefs. A
 * filesystem join does not model URL resolution either. So: require the href to be root-absolute,
 * then resolve it from a NESTED document and require the result to be unchanged.
 */
const expectServedFrom = (href: string, basePath: string, clientDist: string) => {
  expect(href.startsWith('/')).toBe(true);

  const resolved = new URL(href, 'https://example.test/product/42').pathname;
  expect(resolved).toBe(href);

  // Prove the prefix before slicing it away: a wrong prefix of the same LENGTH would otherwise be
  // sliced into a path that still resolves on disk, and the check would pass for the wrong reason.
  if (basePath) expect(resolved.startsWith(`${basePath}/`)).toBe(true);

  const served = basePath ? resolved.slice(basePath.length) : resolved;
  expect(existsSync(path.join(clientDist, served.replace(/^\//, '')))).toBe(true);
};

describe('preload policy, against a manifest real Vite emitted', () => {
  it('the manifest separates static imports from dynamic ones - the assumption the policy rests on', async () => {
    const { manifest, entryKey } = await buildClient();
    const entry = manifest[entryKey]!;

    // If Vite ever merged these, the policy would silently start preloading lazy chunks.
    expect(entry.imports?.length).toBeGreaterThan(0);
    expect(entry.dynamicImports?.length).toBeGreaterThan(0);
    expect(entry.imports).not.toEqual(entry.dynamicImports);
  }, 60_000);

  it('preloads the static import, never the dynamic one, and never the entry itself', async () => {
    const { manifest, entryKey } = await buildClient();
    const links = getStaticModulePreloadLinks(manifest, entryKey, '');
    const entryFile = manifest[entryKey]!.file;

    const staticFiles = (manifest[entryKey]!.imports ?? []).map((k) => manifest[k]!.file);
    const dynamicFiles = (manifest[entryKey]!.dynamicImports ?? []).map((k) => manifest[k]!.file);

    // Without these two, an empty manifest would make every loop below vacuously true.
    expect(staticFiles.length).toBeGreaterThan(0);
    expect(dynamicFiles.length).toBeGreaterThan(0);

    for (const file of staticFiles) expect(links).toContain(`href="/${file}"`);
    for (const file of dynamicFiles) expect(links).not.toContain(file);
    // The entry ships as the bootstrap <script type="module">; preloading it would request it twice.
    expect(links).not.toContain(entryFile);
  }, 60_000);

  it('every emitted URL resolves to a file that exists under dist/client, across all three addressing arms', async () => {
    const { clientDist, manifest, entryKey } = await buildClient();

    // The manifest's values are base-independent, which is exactly why one prepending convention is
    // correct for it - and why applying that same prepend to an ssr-manifest, whose values Vite has
    // ALREADY prefixed, produced the doubled path this unit removes.
    for (const basePath of ['', '/pub', '/pub/admin']) {
      const html = getStaticModulePreloadLinks(manifest, entryKey, basePath) + '\n' + getCssLinks(manifest, basePath);
      // Same guard as above: an empty href list would make the loop vacuously true.
      expect(hrefsOf(html).length).toBeGreaterThan(0);

      for (const href of hrefsOf(html)) {
        expectServedFrom(href, basePath, clientDist);
      }
    }
  }, 60_000);

  it('a non-root entryPoint with a publicBasePath resolves too', async () => {
    appConfigs[0]!.entryPoint = 'admin';
    appConfigs[0]!.clientRoot = path.join(clientBaseDir, 'admin');
    await mkdir(appConfigs[0]!.clientRoot, { recursive: true });
    for (const f of ['styles.css', 'shared-static.js', 'lazy-route.js', 'entry-client.tsx', 'entry-server.tsx']) {
      await writeFile(path.join(appConfigs[0]!.clientRoot, f), await readFile(path.join(clientBaseDir, f), 'utf8'), 'utf8');
    }

    const { clientDist, manifest, entryKey } = await buildClient();
    const html = getStaticModulePreloadLinks(manifest, entryKey, '/pub/admin') + '\n' + getCssLinks(manifest, '/pub/admin');

    expect(hrefsOf(html).length).toBeGreaterThan(0);
    for (const href of hrefsOf(html)) {
      expectServedFrom(href, '/pub/admin', clientDist);
    }
  }, 60_000);

  it('CSS is still emitted, as a plain stylesheet relation', async () => {
    const { manifest } = await buildClient();
    const css = getCssLinks(manifest, '/pub');

    expect(css).toContain('<link rel="stylesheet" href="/pub/');
    expect(css).toContain('.css');
    // taujs has no separate CSS-preload policy here: HTML processes each `rel` keyword as its own
    // relationship (`as` belongs to the `preload` one), so combining them creates no special mode,
    // and a head stylesheet already initiates its own fetch.
    expect(css).not.toContain('preload');
    expect(css).not.toContain('as="style"');
  }, 60_000);

  it('no ssr-manifest is generated any more', async () => {
    await buildClient();
    const { taujsBuild } = await import('../Build');
    await taujsBuild({
      config: { apps: [{ appId: 'web', entryPoint: '', routes: [{ path: '/' }] }] },
      projectRoot,
      clientBaseDir,
      isSSRBuild: true,
    });

    expect(existsSync(path.join(projectRoot, 'dist', 'ssr', '.vite', 'ssr-manifest.json'))).toBe(false);
  }, 60_000);
});
