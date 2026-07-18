import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MANAGED_CONTRIBUTION_BRAND } from '@taujs/server/config';
import { scopedPluginReact } from '@taujs/react/plugin';
import { scopedPluginSolid } from '@taujs/solid/plugin';
import { build, createFilter } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EffectiveScope, ManagedContributionShape } from '@taujs/server/config';

/**
 * ESC-1 acceptance matrix - real-Vite composition proof (RFC 0006 checkpoint section 11, cases 3 + 12).
 *
 * The two REAL scoped compilers (@vitejs/plugin-react + vite-plugin-solid), given the include/exclude
 * the host's effective-scope algebra computes (include = own claims, exclude = the other framework's
 * claims), compile a React file and a Solid file in ONE build with NO cross-framework contamination -
 * the exact defect naive composePlugins produced in S0-A2. The host pre-pass that computes these scopes
 * is unit-tested in @taujs/server; this proves the renderer plugins + real Vite honour them.
 */

const asShape = (contribution: unknown) => contribution as unknown as ManagedContributionShape;

let root: string;
let outDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'esc1-comp-'));
  outDir = path.join(root, 'dist');

  writeFileSync(path.join(root, 'tsconfig.react.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' }, include: ['src-react/**/*'] }));
  writeFileSync(path.join(root, 'tsconfig.solid.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['src-solid/**/*'] }));

  mkdirSync(path.join(root, 'src-react'), { recursive: true });
  mkdirSync(path.join(root, 'src-solid'), { recursive: true });
  writeFileSync(path.join(root, 'src-react', 'Comp.tsx'), 'export default function Comp() {\n  return <div className="react-root">hello react</div>;\n}\n');
  writeFileSync(path.join(root, 'src-solid', 'Comp.tsx'), 'export default function Comp() {\n  return <div class="solid-root">hello solid</div>;\n}\n');

  // A node_modules package that declares a `solid` export condition (ships JSX) - the classifier must
  // claim its directory (case 9, direct-package feasibility).
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'esc1-fixture-root', private: true, dependencies: { 'fake-solid-lib': '*' } }));
  const libDir = path.join(root, 'node_modules', 'fake-solid-lib');
  mkdirSync(path.join(libDir, 'src'), { recursive: true });
  writeFileSync(
    path.join(libDir, 'package.json'),
    JSON.stringify({ name: 'fake-solid-lib', version: '1.0.0', type: 'module', exports: { '.': { solid: './src/index.jsx', default: './src/index.jsx' } } }),
  );
  writeFileSync(path.join(libDir, 'src', 'index.jsx'), 'export default function Widget() {\n  return <div class="lib">lib</div>;\n}\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function buildScoped(): Promise<{ reactOut: string; solidOut: string }> {
  const reactContribution = asShape(scopedPluginReact({ project: 'tsconfig.react.json' }));
  const solidContribution = asShape(scopedPluginSolid({ project: 'tsconfig.solid.json' }));
  const prepareInput = { projectRoot: root, lifecycle: 'build' as const };

  const reactPlan = await reactContribution.impl.prepare([{ contribution: reactContribution, appId: 'web', appRoot: path.join(root, 'src-react') }], prepareInput);
  const solidPlan = await solidContribution.impl.prepare([{ contribution: solidContribution, appId: 'admin', appRoot: path.join(root, 'src-solid') }], prepareInput);

  // The host's effective-scope algebra (unit-tested in @taujs/server): include = own claims, exclude =
  // the other key's claims. The renderer folds its own tsconfig exclude in.
  const reactScope: EffectiveScope = { include: reactPlan.claims, exclude: solidPlan.claims };
  const solidScope: EffectiveScope = { include: solidPlan.claims, exclude: reactPlan.claims };

  const reactPlugin = reactPlan.createPlugin(reactScope);
  const solidPlugin = solidPlan.createPlugin(solidScope);

  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    // Both scoped compilers present in ONE build - scoping (not order) must keep them off each other's files.
    plugins: [reactPlugin, solidPlugin] as never,
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      write: true,
      lib: {
        entry: { react: path.join(root, 'src-react', 'Comp.tsx'), solid: path.join(root, 'src-solid', 'Comp.tsx') },
        formats: ['es'],
      },
      rollupOptions: {
        external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'solid-js', 'solid-js/web', 'solid-js/store', 'solid-js/h'],
        output: { entryFileNames: '[name].js' },
      },
    },
  });

  return {
    reactOut: readFileSync(path.join(outDir, 'react.js'), 'utf8'),
    solidOut: readFileSync(path.join(outDir, 'solid.js'), 'utf8'),
  };
}

describe('ESC-1 composition (real Vite build)', () => {
  it('cross-package brand literal matches the host (dependency-free marker stays in sync)', () => {
    expect(asShape(scopedPluginReact({ project: 'tsconfig.react.json' })).brand).toBe(MANAGED_CONTRIBUTION_BRAND);
    expect(asShape(scopedPluginSolid({ project: 'tsconfig.solid.json' })).brand).toBe(MANAGED_CONTRIBUTION_BRAND);
  });

  it('cases 3 + 12 - React and Solid compile together with no cross-framework contamination', async () => {
    const { reactOut, solidOut } = await buildScoped();

    // The React file was compiled by React (jsx-runtime), NOT by Solid.
    expect(reactOut).toMatch(/react\/jsx/);
    expect(reactOut).not.toMatch(/solid-js\/web/);
    expect(reactOut).not.toMatch(/_tmpl\$/);

    // The Solid file was compiled by Solid (solid-js/web template), NOT by React.
    expect(solidOut).toMatch(/solid-js\/web/);
    expect(solidOut).not.toMatch(/react\/jsx/);
    expect(solidOut).not.toMatch(/createElement/);
  });

  it('case 9 - the vitefu classifier claims a node_modules package with a solid export condition', async () => {
    const contribution = asShape(scopedPluginSolid({ project: 'tsconfig.solid.json' }));
    const plan = await contribution.impl.prepare([{ contribution, appId: 'admin', appRoot: path.join(root, 'src-solid') }], { projectRoot: root, lifecycle: 'build' });
    const owns = createFilter(plan.claims, plan.exclude);
    // the classifier added the exact package directory; a JSX file inside it is owned by Solid
    expect(owns(path.join(root, 'node_modules', 'fake-solid-lib', 'src', 'index.jsx'))).toBe(true);
    // a non-Solid path outside every claim is not owned
    expect(owns(path.join(root, 'node_modules', 'some-other-lib', 'index.jsx'))).toBe(false);
  });
});
