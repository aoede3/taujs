import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assembleManagedSources, composePlugins, prepareOwnership } from '@taujs/server/config';
import { scopedPluginReact } from '@taujs/react/plugin';
import { scopedPluginSolid } from '@taujs/solid/plugin';
import { createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ManagedContributionShape } from '@taujs/server/config';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * ESC-1 real SHARED-DEV evidence (RFC 0006 §11), through the REAL τjs host pre-pass - NOT a hand-rolled
 * scope. This drives the SAME functions SSRServer's dev branch calls:
 *   prepareOwnership()  (partition + group + assert-one-impl + renderer prepare over ALL apps)
 *   -> assembleManagedSources()  (fail-closed ownership diagnostic + raw/managed collision + fresh compilers)
 *   -> composePlugins()  (the §5 composition rule)
 *   -> Vite createServer  (the dev server; SSRServer wraps this via setupDevServer)
 * then exercises a real dev server: transformRequest, a file created AFTER startup, and a real
 * EDIT -> Vite watcher invalidation -> re-transform cycle. The browser/WebSocket HMR PUSH is S0-D2; this
 * proves the module invalidation/re-transform path.
 */

const asShape = (contribution: unknown) => contribution as unknown as ManagedContributionShape;
const REACT_MARK = /react\/jsx|jsxDEV|_jsx/;
const SOLID_MARK = /solid-js\/web|_tmpl\$|createComponent/;

const solidApp = (marker: string) => `export default function App() {\n  return <div class="s">${marker}</div>;\n}\n`;

let root: string;
let server: ViteDevServer;

const codeOf = async (url: string): Promise<string> => {
  const res = await server.transformRequest(url);
  return res?.code ?? '';
};

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'esc1-dev-'));
  // Resolve react/solid runtimes (react/jsx-runtime, solid-js/web) via the fixture's own node_modules.
  try {
    symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  } catch {
    /* symlink unavailable -> transformRequest import resolution may fail */
  }

  mkdirSync(path.join(root, 'src-react'), { recursive: true });
  mkdirSync(path.join(root, 'src-solid'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.react.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' }, include: ['src-react/**/*.tsx'] }));
  writeFileSync(path.join(root, 'tsconfig.solid.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['src-solid/**/*.tsx'] }));
  writeFileSync(path.join(root, 'src-react', 'App.tsx'), 'export default function App() {\n  return <div className="r">react</div>;\n}\n');
  writeFileSync(path.join(root, 'src-solid', 'App.tsx'), solidApp('solid-original'));

  const reactC = asShape(scopedPluginReact({ project: 'tsconfig.react.json' }));
  const solidC = asShape(scopedPluginSolid({ project: 'tsconfig.solid.json' }));

  // --- THE REAL taujs HOST PRE-PASS (identical to SSRServer's dev branch) ---
  const ownership = await prepareOwnership(
    [
      { appId: 'web', appRoot: path.join(root, 'src-react'), plugins: [reactC] },
      { appId: 'admin', appRoot: path.join(root, 'src-solid'), plugins: [solidC] },
    ],
    { projectRoot: root, lifecycle: 'dev' },
  );
  const managed = assembleManagedSources({ prepared: ownership, keysToInstantiate: [...ownership.plans.keys()], resolvedChain: [], env: 'dev' });
  const composed = composePlugins({
    sources: [
      ...managed.hostSources,
      { source: 'web', plugins: ownership.rawByApp.get('web') ?? [] },
      { source: 'admin', plugins: ownership.rawByApp.get('admin') ?? [] },
    ],
    internal: [],
  });
  // --------------------------------------------------------------------------

  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: { usePolling: true, interval: 40 } },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: composed as Plugin[],
  });
});

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ESC-1 real shared dev server through the taujs host pre-pass', () => {
  it('compiles each file with its framework, no cross-framework contamination in dev', async () => {
    const reactCode = await codeOf('/src-react/App.tsx');
    const solidCode = await codeOf('/src-solid/App.tsx');
    expect(reactCode).toMatch(REACT_MARK);
    expect(reactCode).not.toMatch(SOLID_MARK);
    expect(solidCode).toMatch(SOLID_MARK);
    expect(solidCode).not.toMatch(/react\/jsx/);
  });

  it('compiles a file CREATED AFTER startup immediately (post-start pattern recognition, no restart)', async () => {
    writeFileSync(path.join(root, 'src-solid', 'AddedLater.tsx'), solidApp('added-later'));
    const code = await codeOf('/src-solid/AddedLater.tsx');
    expect(code).toMatch(SOLID_MARK);
    expect(code).toContain('added-later');
    expect(code).not.toMatch(/react\/jsx/);
  });

  it('re-transforms an EDITED file through the Vite watcher invalidation path (HMR module cycle)', async () => {
    const before = await codeOf('/src-solid/App.tsx');
    expect(before).toContain('solid-original');

    // observe the REAL watcher, then edit the file
    const changed = new Promise<void>((resolve) => {
      const onChange = (file: string) => {
        if (file === path.join(root, 'src-solid', 'App.tsx')) {
          server.watcher.off('change', onChange);
          resolve();
        }
      };
      server.watcher.on('change', onChange);
    });
    writeFileSync(path.join(root, 'src-solid', 'App.tsx'), solidApp('solid-edited'));
    await Promise.race([changed, new Promise<void>((r) => setTimeout(r, 3000))]);

    // poll until the invalidation has re-transformed to the edited content
    let after = '';
    for (let i = 0; i < 40 && !after.includes('solid-edited'); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      after = await codeOf('/src-solid/App.tsx');
    }
    expect(after).toContain('solid-edited'); // the watcher invalidated + Vite re-transformed
    expect(after).not.toContain('solid-original');
    expect(after).toMatch(SOLID_MARK); // still Solid-compiled, no contamination
    expect(after).not.toMatch(/react\/jsx/);
  });
});
