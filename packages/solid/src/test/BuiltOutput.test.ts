// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * Built-output import smoke - design 7.5's packaging leg.
 *
 * Every other suite in this package imports SOURCE. This one imports the PACKED ARTEFACT and
 * constructs the factory from it, which is the only way to catch defects that live in packaging
 * rather than in code: a missing file in the `files` allow-list, an export-map subpath that points
 * at something not shipped, a declaration that references a type stripped from the tarball, or a
 * runtime dependency that was never declared.
 *
 * It packs and installs rather than importing `dist/` in place. Importing `dist/` directly still
 * resolves through the workspace's own `node_modules`, so an undeclared dependency would be found
 * anyway and the check would pass while a real user's install failed.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const scratch = new Set<string>();
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

/** Pack @taujs/solid and its workspace deps, install into a consumer, return its root. */
const installPackedConsumer = (withOptionalPeers: boolean): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'taujs-solid-consumer-'));
  scratch.add(dir);

  const tarballs: string[] = [];
  for (const pkg of ['solid', 'server']) {
    const source = path.join(REPO_ROOT, 'packages', pkg);
    if (!existsSync(path.join(source, 'dist'))) throw new Error(`@taujs/${pkg} is not built - run \`pnpm -r build\` first`);
    execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: source, stdio: 'pipe' });
  }
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.tgz'))) tarballs.push(path.join(dir, file));

  // No workspace, no hoisting: nothing on disk but what the tarballs bring plus the peers a real
  // consumer would install. `solid-js` is a REQUIRED peer, so it is always present.
  const optionalPeers = withOptionalPeers ? ['vite@7.3.6', 'vite-plugin-solid@2.11.12', 'typescript@5.9.3'] : [];
  execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'pipe' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs, 'solid-js@1.9.14', ...optionalPeers], { cwd: dir, stdio: 'pipe' });

  return dir;
};

/** A CLIENT-ONLY consumer: none of the optional compiler/Vite peers installed. */
let bareConsumer: string | undefined;
const getBare = () => (bareConsumer ??= installPackedConsumer(false));

/** A FULL consumer: the optional compiler peers installed, as an app using `/renderer` would. */
let fullConsumer: string | undefined;
const getFull = () => (fullConsumer ??= installPackedConsumer(true));

const runIn = (root: string, source: string): string =>
  execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', stdio: 'pipe' });

const runInConsumer = (source: string): string => runIn(getBare(), source);

describe('built-output import smoke (packed artefact, real consumers)', () => {
  it('the packed tarball ships exactly the dist tree the export map points at', { timeout: 300_000 }, () => {
    const listing = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: 'pipe' });
    const files = (JSON.parse(listing) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);

    const exportMap = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).exports as Record<
      string,
      { import?: string; types?: string } | string
    >;

    for (const [subpath, target] of Object.entries(exportMap)) {
      if (typeof target === 'string') continue;
      for (const pointer of [target.import, target.types]) {
        if (!pointer) continue;
        const relative = pointer.replace(/^\.\//, '');
        expect(files, `${subpath} points at ${pointer}, which is NOT in the packed tarball`).toContain(relative);
      }
    }

    // ...and nothing from src leaks into the tarball.
    expect(files.filter((f) => f.startsWith('src/'))).toEqual([]);
  });

  it('constructs the renderer from the PACKED root entry', { timeout: 300_000 }, () => {
    const out = runInConsumer(`
      import { createRenderer, createSSRStore, useSSRStore, hydrateApp, escapeHtml } from '@taujs/solid';
      const mod = createRenderer({ appComponent: () => null, headContent: () => '<title>t</title>' });
      console.log(JSON.stringify({
        renderSSR: typeof mod.renderSSR,
        renderStream: typeof mod.renderStream,
        store: typeof createSSRStore,
        useStore: typeof useSSRStore,
        hydrate: typeof hydrateApp,
        escape: escapeHtml('<b>'),
      }));
    `);

    expect(JSON.parse(out)).toEqual({
      renderSSR: 'function',
      renderStream: 'function',
      store: 'function',
      useStore: 'function',
      hydrate: 'function',
      escape: '&lt;b&gt;',
    });
  });

  it('renders real SSR HTML from the packed artefact', { timeout: 300_000 }, () => {
    // The factory constructing is not enough - the packed module must actually RENDER, which
    // exercises its seroval dependency and the Solid server build together.
    const out = runInConsumer(`
      import { createRenderer } from '@taujs/solid';
      import { ssr } from 'solid-js/web';
      const { renderSSR } = createRenderer({
        appComponent: () => ssr('<div id="app">packed</div>'),
        headContent: ({ data }) => '<title>' + String(data.title) + '</title>',
      });
      const out = await renderSSR({ title: 'from-packed' }, '/', {}, undefined, { shouldHydrate: true });
      console.log(JSON.stringify({ head: out.headContent.slice(0, 40), hasApp: out.appHtml.includes('packed') }));
    `);

    const result = JSON.parse(out) as { head: string; hasApp: boolean };
    expect(result.hasApp).toBe(true);
    expect(result.head).toContain('from-packed');
  });

  it('constructs solidRenderer from the PACKED /renderer subpath (peers installed)', { timeout: 600_000 }, () => {
    const out = runIn(
      getFull(),
      `
      import { solidRenderer } from '@taujs/solid/renderer';
      const c = solidRenderer({ project: './tsconfig.solid.json' });
      console.log(JSON.stringify({ key: c.key, managedCompilation: c.managedCompilation }));
    `,
    );

    expect(JSON.parse(out)).toEqual({ key: 'solid', managedCompilation: true });
  });

  it('exposes the raw plugin from the PACKED /plugin subpath (peers installed)', { timeout: 600_000 }, () => {
    const out = runIn(
      getFull(),
      `
      import * as plugin from '@taujs/solid/plugin';
      console.log(JSON.stringify(Object.keys(plugin).sort()));
    `,
    );

    expect(JSON.parse(out)).toContain('pluginSolid');
  });

  it('ROOT-EXPORT KILL TEST: a peer-free consumer declares solidRenderer; the compiler peers are demanded only at lazy load', { timeout: 300_000 }, () => {
    // The v2 lazy contribution protocol changes the frozen property DELIBERATELY: in a consumer with NO
    // compiler peers installed,
    //   - the root entry loads and renders (proven by the tests above, same consumer);
    //   - `/renderer` now ALSO loads and declares (identity is synchronous and peer-free - this is what
    //     keeps production processes free of the compiler toolchain);
    //   - the OPTIONAL `vite-plugin-solid` peer is demanded exactly at `loadCompiler()` - the build/dev
    //     seam - with the package named in the failure.
    // If renderer.ts ever regains an eager compiler import, the declaration leg fails here; if the lazy
    // load stops naming the missing peer, the load leg fails.
    const out = runInConsumer(`
      const { solidRenderer } = await import('@taujs/solid/renderer');
      const c = solidRenderer({ project: './tsconfig.solid.json' });
      let loadError = '';
      try {
        await c.loadCompiler();
      } catch (e) {
        loadError = String((e && e.message) || e);
      }
      console.log(JSON.stringify({ key: c.key, managedCompilation: c.managedCompilation, loadErrorNamesPeer: loadError.includes('vite-plugin-solid') }));
    `);

    expect(JSON.parse(out)).toEqual({ key: 'solid', managedCompilation: true, loadErrorNamesPeer: true });
  });

  it('INTERNALS stay unreachable from the packed package', { timeout: 300_000 }, () => {
    // The encapsulation gate, verified against the artefact rather than the source tree.
    for (const internal of ['@taujs/solid/utils/SanitiseError.js', '@taujs/solid/dist/utils/SanitiseError.js', '@taujs/solid/internal']) {
      let failed = false;
      try {
        runInConsumer(`await import('${internal}'); console.log('reachable');`);
      } catch {
        failed = true;
      }
      expect(failed, `${internal} is importable from the packed package`).toBe(true);
    }
  });
});
