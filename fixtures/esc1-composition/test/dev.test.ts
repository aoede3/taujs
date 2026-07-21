import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reactRenderer } from '@taujs/react/renderer';
import { solidRenderer } from '@taujs/solid/renderer';
import { createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// TEST-ONLY host-internal import via a Vitest alias (see vitest.config.ts -> @taujs/server-internal/*).
// assembleDevPluginChain is the SAME dev composition SSRServer's dev branch runs; the fixture drives it
// (rather than a hand-rolled copy) so the evidence exercises the real §5 ordering. It is NOT part of
// @taujs/server's public API - the alias exists only while the repo's own fixtures run.
import { assembleDevPluginChain } from '@taujs/server-internal/ownership';

import type { Plugin, ViteDevServer } from 'vite';

/**
 * ESC-1 real SHARED-DEV evidence (RFC 0006 §11), through the REAL τjs host composition - NOT a
 * hand-rolled scope. It drives `assembleDevPluginChain`, the SINGLE function SSRServer's dev branch also
 * calls, which internally runs:
 *   prepareOwnership()  (partition + group + assert-one-impl + renderer prepare over ALL apps)
 *   -> assembleManagedSources()  (fail-closed ownership diagnostic + raw/managed collision + fresh compilers)
 *   -> composePlugins()  (the §5 composition rule, in the ONE dev source order)
 * The composed plugins then drive Vite createServer (the dev server SSRServer wraps via setupDevServer),
 * and the test exercises transformRequest, a file created AFTER startup, and a real EDIT -> Vite watcher
 * invalidation -> re-transform cycle. The browser/WebSocket HMR PUSH is S0-D2; this proves the module
 * invalidation/re-transform path.
 */

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
  writeFileSync(
    path.join(root, 'tsconfig.solid.json'),
    JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['src-solid/**/*.tsx'] }),
  );
  writeFileSync(path.join(root, 'src-react', 'App.tsx'), 'export default function App() {\n  return <div className="r">react</div>;\n}\n');
  writeFileSync(path.join(root, 'src-solid', 'App.tsx'), solidApp('solid-original'));

  const reactC = reactRenderer({ project: 'tsconfig.react.json' });
  const solidC = solidRenderer({ project: 'tsconfig.solid.json' });

  // --- THE REAL taujs DEV COMPOSITION - the SAME assembleDevPluginChain SSRServer's dev branch runs, so
  // the fixture cannot drift from the host's §5 source ordering (host managed sources -> app raw sources
  // -> config.vite). No prepareOwnership/assembleManagedSources/composePlugins order is re-stated here. ---
  const { plugins } = await assembleDevPluginChain({
    apps: [
      { appId: 'web', appRoot: path.join(root, 'src-react'), plugins: [], renderer: reactC },
      { appId: 'admin', appRoot: path.join(root, 'src-solid'), plugins: [], renderer: solidC },
    ],
    projectRoot: root,
  });
  // ----------------------------------------------------------------------------------------------------

  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: { usePolling: true, interval: 40 } },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: plugins as Plugin[],
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

    // observe the REAL watcher, then edit the file. The timeout REJECTS (the evidence claims the watcher
    // event was observed), and the listener is removed on either outcome.
    const appTsx = path.join(root, 'src-solid', 'App.tsx');
    const onChange = (file: string): void => {
      if (file === appTsx) changeResolve();
    };
    let changeResolve: () => void = () => {};
    const changed = new Promise<void>((resolve) => {
      changeResolve = resolve;
    });
    server.watcher.on('change', onChange);
    writeFileSync(appTsx, solidApp('solid-edited'));
    try {
      await Promise.race([
        changed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Vite watcher "change" for App.tsx timed out')), 3000)),
      ]);
    } finally {
      server.watcher.off('change', onChange);
    }

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
