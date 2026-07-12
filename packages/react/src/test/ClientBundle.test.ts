// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

// R3-05 (Q6, signed 2026-07-12) — the durable half of the entry-point fix: a production BROWSER
// bundle of the scaffolded client entry (`import { hydrateApp } from '@taujs/react'`) must not
// contain react-dom's server renderer. The defect mechanism: react-dom/server's browser condition
// is CJS and cannot be proven pure, so a bundler retains it once it is REACHABLE; the pre-R3-05
// single-module dist made it reachable from `hydrateApp` (+519 KB in the module graph, -49% raw /
// -48% gzip once split). The assertion is on rollup MODULE IDS — authoritative, not a string grep.
// If React ever ships an ESM browser server build, the config that makes this pass could become
// unnecessary — but this guard stays valid either way (absence is the contract).
//
// Runs against the BUILT dist (the shipped artifact — the property lives in tsup's `bundle: false`
// output, not in src). CI builds before testing (`pnpm run check` likewise).
const DIST_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

describe('R3-05 client bundle excludes the SSR renderer', () => {
  it('a production browser bundle importing only hydrateApp contains no react-dom server module', { timeout: 120_000 }, async () => {
    expect(existsSync(DIST_ENTRY), `dist missing at ${DIST_ENTRY} — run \`pnpm build\` first (CI builds before tests)`).toBe(true);
    // Belt: the dist must be the multi-module (bundle:false) shape, or reachability is meaningless.
    expect(readFileSync(DIST_ENTRY, 'utf8')).toMatch(/from ["']\.\/SSRHydration\.js["']/);

    const dir = mkdtempSync(path.join(tmpdir(), 'taujs-react-bundle-guard-'));
    try {
      const entry = path.join(dir, 'entry.js');
      writeFileSync(entry, `import { hydrateApp } from '@taujs/react';\nconsole.log(hydrateApp);\n`);

      // Gate-review fix: assert on the FULL RESOLVED GRAPH, not only the final bytes. Resolving a
      // Node-only module into the browser graph is a defect even when tree-shaking drops it from
      // the output (vite merely warns; stricter bundlers hard-fail on bare node builtins). NB the
      // warning channel itself is NOT a reliable guard: vite suppresses the "externalized for
      // browser compatibility" warnings whenever NODE_ENV is pre-set (vitest sets NODE_ENV=test)
      // — discovered empirically. `moduleParsed` fires for every loaded module, including ones
      // later tree-shaken and vite's `__vite-browser-external` builtin stubs, in any environment.
      const loadedModules: string[] = [];
      const graphRecorder = {
        name: 'taujs-guard-graph-recorder',
        moduleParsed(info: { id: string }) {
          loadedModules.push(info.id);
        },
      };

      const result = (await build({
        logLevel: 'silent',
        configFile: false,
        envFile: false,
        root: dir,
        plugins: [graphRecorder],
        resolve: { alias: { '@taujs/react': DIST_ENTRY } },
        build: { outDir: path.join(dir, 'out'), emptyOutDir: true, rollupOptions: { input: entry } },
      })) as Rollup.RollupOutput | Rollup.RollupOutput[];

      // Node-only server modules and browser-externalized node builtins must not even be LOADED.
      // (Browser-safe react-dom server modules being loaded then shaken is the accepted mechanism
      // — the OUTPUT assertions below cover those.)
      const nodeOnlyLoaded = loadedModules.filter((id) => /react-dom-server\.node|static\.node\.js|__vite-browser-external/.test(id));
      expect(nodeOnlyLoaded, `Node-only modules were resolved into the browser build graph:\n${nodeOnlyLoaded.join('\n')}`).toEqual([]);

      const outputs = Array.isArray(result) ? result : [result];
      const chunks = outputs.flatMap((r) => r.output).filter((o): o is Rollup.OutputChunk => o.type === 'chunk');
      const moduleIds = chunks.flatMap((c) => Object.keys(c.modules));

      // Sanity: the graph really was built and includes the client renderer.
      expect(moduleIds.some((id) => id.includes('react-dom'))).toBe(true);

      // 'static.node' would mean the Node prerender build joined the graph; 'static.browser' in
      // the OUTPUT would mean tree-shaking of the conditional static entry failed.
      const serverModules = moduleIds.filter(
        (id) => id.includes('react-dom-server') || id.includes('server.browser') || id.includes('static.node') || id.includes('static.browser'),
      );
      expect(serverModules, `react-dom server renderer reached the client bundle:\n${serverModules.join('\n')}`).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
