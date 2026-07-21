// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * Slice-6 packaging gates, on the BUILT dist (the shipped artifact - the property lives in tsup's
 * `bundle: false` output, not in src). CI builds before testing.
 *
 * A scaffolded client entry does `import { hydrateApp } from '@taujs/solid'`, and the ROOT entry
 * also exports `createRenderer`. So the root deliberately contains both halves, and what must hold
 * is that the SSR half is not REACHABLE from the client half: no `renderToStream`, no seroval, no
 * sanitiser, and above all none of the optional compiler/Vite/TypeScript peers, which a
 * client-only consumer does not install at all.
 *
 * Asserted on rollup MODULE IDS - the resolved graph - not on output bytes. Resolving a Node-only
 * or optional-peer module into a browser graph is a defect even when tree-shaking later drops it:
 * vite merely warns (and suppresses those warnings when NODE_ENV is pre-set, which vitest does),
 * while stricter bundlers hard-fail.
 */
const DIST_ROOT = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const DIST_RENDERER = fileURLToPath(new URL('../../dist/renderer.js', import.meta.url));

const bundleClient = async (source: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'taujs-solid-bundle-guard-'));
  try {
    const entry = path.join(dir, 'entry.js');
    writeFileSync(entry, source);

    const loadedModules: string[] = [];
    const result = (await build({
      logLevel: 'silent',
      configFile: false,
      envFile: false,
      root: dir,
      plugins: [
        {
          name: 'taujs-guard-graph-recorder',
          moduleParsed(info: { id: string }) {
            loadedModules.push(info.id);
          },
        },
      ],
      resolve: { alias: { '@taujs/solid': DIST_ROOT } },
      build: { outDir: path.join(dir, 'out'), emptyOutDir: true, rollupOptions: { input: entry } },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];

    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap((r) => r.output).filter((o): o is Rollup.OutputChunk => o.type === 'chunk');

    // `renderedLength` is what each module actually CONTRIBUTES to the emitted chunk - a far
    // stronger signal than a string grep, and it distinguishes "resolved then tree-shaken" from
    // "shipped".
    const shippedModules = chunks.flatMap((c) =>
      Object.entries(c.modules)
        .filter(([, m]) => (m as { renderedLength: number }).renderedLength > 0)
        .map(([id]) => id),
    );

    return { loadedModules, moduleIds: chunks.flatMap((c) => Object.keys(c.modules)), shippedModules, code: chunks.map((c) => c.code).join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('slice 6 - a client bundle pulls no SSR implementation', () => {
  it('the dist is the multi-module (bundle:false) shape, or reachability means nothing', () => {
    expect(existsSync(DIST_ROOT), `dist missing at ${DIST_ROOT} - run \`pnpm build\` first (CI builds before tests)`).toBe(true);
    expect(readFileSync(DIST_ROOT, 'utf8')).toMatch(/from ["']\.\/SSRHydration\.js["']/);
  });

  it('ships no SSR implementation: SSRRender, the sanitiser and seroval contribute ZERO bytes', { timeout: 120_000 }, async () => {
    const { moduleIds, shippedModules, code } = await bundleClient(`import { hydrateApp } from '@taujs/solid';\nconsole.log(hydrateApp);\n`);

    // Sanity: the graph really was built and the CLIENT runtime is in it.
    expect(moduleIds.some((id) => id.includes('solid-js'))).toBe(true);

    // The root entry deliberately exports BOTH halves, so a static re-export makes the SSR
    // modules reachable and they are RESOLVED. What the gate requires is that none of them is
    // SHIPPED. `renderedLength > 0` is the precise test for that.
    const shippedSSR = shippedModules.filter((id) => /SSRRender|SanitiseError|[/\\]seroval[/\\]/.test(id));
    expect(shippedSSR, `SSR implementation was SHIPPED in the client bundle:\n${shippedSSR.join('\n')}`).toEqual([]);

    // Belt on the emitted bytes: the sanitiser's constants and Solid's server API would be
    // unmistakable if tree-shaking ever silently stopped working.
    expect(code).not.toContain('[redacted]');
    expect(code).not.toContain('renderToStream');
    expect(code).not.toContain('createPlugin');
  });

  it('resolves the CLIENT solid-js/web build, never the server one, and no node builtins', { timeout: 120_000 }, async () => {
    // These are GRAPH assertions, deliberately stricter than the byte assertions above:
    // resolving a Node-only module into a browser graph is a defect even when tree-shaking drops
    // it, because stricter bundlers hard-fail where vite only warns (and vite suppresses those
    // warnings when NODE_ENV is pre-set, which vitest does).
    const { loadedModules, moduleIds } = await bundleClient(`import { hydrateApp } from '@taujs/solid';\nconsole.log(hydrateApp);\n`);
    const all = [...loadedModules, ...moduleIds];

    const serverBuild = all.filter((id) => /solid-js[/\\]web[/\\]dist[/\\]server|__vite-browser-external/.test(id));
    expect(serverBuild, `Solid's SERVER build or a node builtin was resolved into the browser graph:\n${serverBuild.join('\n')}`).toEqual([]);

    // ...and a CLIENT build IS there, so the assertion above is not vacuous. Deliberately not
    // pinned to `web.js`: vite picks the `development` condition when NODE_ENV is pre-set (vitest
    // sets NODE_ENV=test), so the client build is `dev.js` here and `web.js` in a real production
    // build. Either is correct; the SERVER build is what must never appear.
    const clientBuild = all.filter((id) => /solid-js[/\\]web[/\\]dist[/\\](web|dev)\.js/.test(id));
    expect(clientBuild.length, `no solid-js/web CLIENT build in the graph - the server-build assertion above would be vacuous`).toBeGreaterThan(0);
  });

  it('importing only hydrateApp reaches none of the OPTIONAL compiler/Vite/TypeScript peers', { timeout: 120_000 }, async () => {
    // A client-only consumer does not install these at all, so reaching them is a hard failure
    // for that consumer, not merely dead weight.
    const { loadedModules, moduleIds } = await bundleClient(`import { hydrateApp } from '@taujs/solid';\nconsole.log(hydrateApp);\n`);

    const optionalPeers = [...loadedModules, ...moduleIds].filter((id) =>
      /[/\\]vite-plugin-solid[/\\]|[/\\]typescript[/\\]|[/\\]vitefu[/\\]|[/\\]picomatch[/\\]|solidCompiler|solidOwnership|solidClassifier|tsconfigOwnership/.test(
        id,
      ),
    );
    expect(optionalPeers, `optional compiler/Vite peers reached the client graph:\n${optionalPeers.join('\n')}`).toEqual([]);
  });

  it('the renderer subpath is genuinely separate - it is NOT reachable from the root entry', () => {
    // The frozen root-vs-subpath split exists so the compiler never enters a client graph. If the
    // root ever re-exported `solidRenderer` "for convenience", this is the guard that fails.
    const rootSource = readFileSync(DIST_ROOT, 'utf8');

    expect(rootSource).not.toMatch(/from ["']\.\/renderer\.js["']/);
    expect(rootSource).not.toContain('solidRenderer');
    expect(existsSync(DIST_RENDERER)).toBe(true);
  });
});
