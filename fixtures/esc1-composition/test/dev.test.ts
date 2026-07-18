import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scopedPluginReact } from '@taujs/react/plugin';
import { scopedPluginSolid } from '@taujs/solid/plugin';
import { createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EffectiveScope, ManagedContributionShape } from '@taujs/server/config';

/**
 * ESC-1 real SHARED-DEV evidence (RFC 0006 §11; the post-start-file / HMR-recognition property that was
 * load-bearing for rejecting the snapshot design). Runs a real Vite dev server (middleware mode) with
 * BOTH scoped compilers - built from the real renderer prepare()/createPlugin() and the host's
 * effective-scope algebra (include = own claims, exclude = the other key's claims) - and drives real
 * `transformRequest`:
 *   - each file is compiled by ITS framework with no cross-framework contamination in dev;
 *   - a NEW file created AFTER server startup, matching an existing ownership pattern, is compiled
 *     IMMEDIATELY (normal HMR recognition - no process restart), because ownership is pattern-based, not
 *     a startup file snapshot.
 */

const asShape = (contribution: unknown) => contribution as unknown as ManagedContributionShape;
const REACT_MARK = /react\/jsx|jsxDEV|_jsx/;
const SOLID_MARK = /solid-js\/web|_tmpl\$|createComponent/;

let root: string;
let server: Awaited<ReturnType<typeof createServer>>;

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'esc1-dev-'));
  // Let the temp project resolve react/solid runtimes (react/jsx-runtime, solid-js/web) via the
  // fixture's own node_modules - transformRequest resolves the compiled imports.
  try {
    symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  } catch {
    /* symlink unavailable -> the resolve step may fail; the compile markers are still asserted */
  }
  mkdirSync(path.join(root, 'src-react'), { recursive: true });
  mkdirSync(path.join(root, 'src-solid'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.react.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' }, include: ['src-react/**/*.tsx'] }));
  writeFileSync(path.join(root, 'tsconfig.solid.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['src-solid/**/*.tsx'] }));
  writeFileSync(path.join(root, 'src-react', 'App.tsx'), 'export default function App() {\n  return <div className="r">react</div>;\n}\n');
  writeFileSync(path.join(root, 'src-solid', 'App.tsx'), 'export default function App() {\n  return <div class="s">solid</div>;\n}\n');

  const reactC = asShape(scopedPluginReact({ project: 'tsconfig.react.json' }));
  const solidC = asShape(scopedPluginSolid({ project: 'tsconfig.solid.json' }));
  const input = { projectRoot: root, lifecycle: 'dev' as const };
  const reactPlan = await reactC.impl.prepare([{ contribution: reactC, appId: 'web', appRoot: path.join(root, 'src-react') }], input);
  const solidPlan = await solidC.impl.prepare([{ contribution: solidC, appId: 'admin', appRoot: path.join(root, 'src-solid') }], input);

  // The host's effective-scope algebra (validated end-to-end by the taujsBuild suite): include = own
  // claims, exclude = the other key's claims.
  const reactScope: EffectiveScope = { include: reactPlan.claims, exclude: solidPlan.claims };
  const solidScope: EffectiveScope = { include: solidPlan.claims, exclude: reactPlan.claims };

  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [reactPlan.createPlugin(reactScope), solidPlan.createPlugin(solidScope)] as never,
  });
});

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ESC-1 real shared dev server (transformRequest)', () => {
  it('compiles each file with its framework, no cross-framework contamination in dev', async () => {
    const reactRes = await server.transformRequest('/src-react/App.tsx');
    const solidRes = await server.transformRequest('/src-solid/App.tsx');
    expect(reactRes?.code).toMatch(REACT_MARK);
    expect(reactRes?.code).not.toMatch(SOLID_MARK);
    expect(solidRes?.code).toMatch(SOLID_MARK);
    expect(solidRes?.code).not.toMatch(/react\/jsx/);
  });

  it('compiles a file CREATED AFTER server startup immediately (post-start recognition, no restart)', async () => {
    // A brand-new Solid file under the existing include pattern - not present when the server (or the
    // compiler filter) was constructed.
    writeFileSync(path.join(root, 'src-solid', 'AddedLater.tsx'), 'export default function Added() {\n  return <div class="new">added</div>;\n}\n');
    const res = await server.transformRequest('/src-solid/AddedLater.tsx');
    expect(res?.code).toMatch(SOLID_MARK);
    expect(res?.code).not.toMatch(/react\/jsx/);
  });
});
