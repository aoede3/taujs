// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

// R3-05 (Q6, signed 2026-07-12) — vue's half of the entry-point guard. Unlike react, vue's client
// bundle was NEVER materially polluted: `@vue/server-renderer`'s import condition is pure ESM and
// tree-shakes to ~0 bytes. This guard is STRUCTURAL HARDENING — it pins the absence so the react
// defect class can never appear here if `@vue/server-renderer`'s build shape (or our module graph)
// changes. Assertion on rollup MODULE IDS + rendered bytes — authoritative, not a string grep.
//
// Runs against the BUILT dist (the shipped artifact). CI builds before testing.
const DIST_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

describe('R3-05 client bundle excludes the SSR renderer', () => {
  it('a production browser bundle importing only hydrateApp renders no @vue/server-renderer code', { timeout: 120_000 }, async () => {
    expect(existsSync(DIST_ENTRY), `dist missing at ${DIST_ENTRY} — run \`pnpm build\` first (CI builds before tests)`).toBe(true);
    // Belt: the dist must be the multi-module (bundle:false) shape, or reachability is meaningless.
    expect(readFileSync(DIST_ENTRY, 'utf8')).toMatch(/from ["']\.\/SSRHydration\.js["']/);

    const dir = mkdtempSync(path.join(tmpdir(), 'taujs-vue-bundle-guard-'));
    try {
      const entry = path.join(dir, 'entry.js');
      writeFileSync(entry, `import { hydrateApp } from '@taujs/vue';\nconsole.log(hydrateApp);\n`);

      // Gate-review fix (react twin): assert on the FULL RESOLVED GRAPH, not only the final
      // bytes. NB warnings are not a reliable channel — vite suppresses the externalization
      // warnings whenever NODE_ENV is pre-set (vitest sets NODE_ENV=test). `moduleParsed` fires
      // for every loaded module, including tree-shaken ones and `__vite-browser-external` stubs.
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
        resolve: { alias: { '@taujs/vue': DIST_ENTRY } },
        build: { outDir: path.join(dir, 'out'), emptyOutDir: true, rollupOptions: { input: entry } },
      })) as Rollup.RollupOutput | Rollup.RollupOutput[];

      const nodeOnlyLoaded = loadedModules.filter((id) => /__vite-browser-external/.test(id));
      expect(nodeOnlyLoaded, `Node-only modules were resolved into the browser build graph:\n${nodeOnlyLoaded.join('\n')}`).toEqual([]);

      const outputs = Array.isArray(result) ? result : [result];
      const chunks = outputs.flatMap((r) => r.output).filter((o): o is Rollup.OutputChunk => o.type === 'chunk');

      // Sanity: the graph really was built and includes vue itself.
      expect(chunks.flatMap((c) => Object.keys(c.modules)).some((id) => id.includes('node_modules'))).toBe(true);

      const serverRendered = chunks
        .flatMap((c) => Object.entries(c.modules))
        .filter(([id]) => id.includes('@vue/server-renderer') || id.includes('server-renderer'))
        .reduce((total, [, mod]) => total + ((mod as { renderedLength?: number }).renderedLength ?? 0), 0);

      expect(serverRendered, `@vue/server-renderer rendered ${serverRendered} bytes into the client bundle`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
