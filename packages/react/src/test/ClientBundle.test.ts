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

      const result = (await build({
        logLevel: 'silent',
        configFile: false,
        envFile: false,
        root: dir,
        resolve: { alias: { '@taujs/react': DIST_ENTRY } },
        build: { outDir: path.join(dir, 'out'), emptyOutDir: true, rollupOptions: { input: entry } },
      })) as Rollup.RollupOutput | Rollup.RollupOutput[];

      const outputs = Array.isArray(result) ? result : [result];
      const chunks = outputs.flatMap((r) => r.output).filter((o): o is Rollup.OutputChunk => o.type === 'chunk');
      const moduleIds = chunks.flatMap((c) => Object.keys(c.modules));

      // Sanity: the graph really was built and includes the client renderer.
      expect(moduleIds.some((id) => id.includes('react-dom'))).toBe(true);

      // 'static.node' covers R3-06's prerenderToNodeStream entry (react-dom/static.node) — Node-only,
      // must never join a browser graph.
      const serverModules = moduleIds.filter((id) => id.includes('react-dom-server') || id.includes('server.browser') || id.includes('static.node'));
      expect(serverModules, `react-dom server renderer reached the client bundle:\n${serverModules.join('\n')}`).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
