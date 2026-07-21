import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { taujsBuild } from '@taujs/server/build';
import { reactRenderer } from '@taujs/react/renderer';
import { solidRenderer } from '@taujs/solid/renderer';
import { vueRenderer } from '@taujs/vue/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ESC-1 acceptance matrix - REAL host wiring (RFC 0006 §11). Drives the PUBLIC `taujsBuild`, which runs
 * the actual host pre-pass end to end: extractBuildConfigs -> processConfigs -> prepareOwnership ->
 * per-app loop -> assembleManagedSources -> composePlugins -> real `vite.build`. No hand-rolled scope,
 * no bypass. Proves per-app build CONTAINMENT (each app instantiates only its own managed compiler and
 * emits only that framework's compiled output), both config orders, filtered builds, and that a
 * misconfigured ownership overlap fails closed before Vite starts.
 */

const REACT_APP = { entry: 'export { default } from "./App";\n', comp: 'export default function App() {\n  return <div className="r">react</div>;\n}\n' };
const SOLID_APP = { entry: 'export { default } from "./App";\n', comp: 'export default function App() {\n  return <div class="s">solid</div>;\n}\n' };

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  delete process.env.TAUJS_APP;
});

type AppSpec = { appId: string; entryPoint: string; framework: 'react' | 'solid' };

function scaffold(order: AppSpec[]): { projectRoot: string; clientBaseDir: string } {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'esc1-build-'));
  roots.push(projectRoot);
  const clientBaseDir = path.join(projectRoot, 'src', 'client');

  for (const app of order) {
    const dir = app.entryPoint ? path.join(clientBaseDir, app.entryPoint) : clientBaseDir;
    mkdirSync(dir, { recursive: true });
    const src = app.framework === 'react' ? REACT_APP : SOLID_APP;
    writeFileSync(path.join(dir, 'entry-client.tsx'), src.entry);
    writeFileSync(path.join(dir, 'entry-server.tsx'), src.entry);
    writeFileSync(path.join(dir, 'App.tsx'), src.comp);
    writeFileSync(
      path.join(dir, 'index.html'),
      `<!doctype html><html><body><div id="root"></div><script type="module" src="./entry-client.tsx"></script></body></html>\n`,
    );
    const tsconfig =
      app.framework === 'react' ? { compilerOptions: { jsx: 'react-jsx' } } : { compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' } };
    writeFileSync(path.join(dir, `tsconfig.${app.framework}.json`), JSON.stringify({ ...tsconfig, include: ['*.tsx'] }));
  }
  return { projectRoot, clientBaseDir };
}

function configFor(order: AppSpec[], projectRoot: string, clientBaseDir: string) {
  return {
    apps: order.map((app) => {
      const rel = (f: string) => path.relative(projectRoot, path.join(app.entryPoint ? path.join(clientBaseDir, app.entryPoint) : clientBaseDir, f));
      const project = rel(`tsconfig.${app.framework}.json`);
      const renderer = app.framework === 'react' ? reactRenderer({ project }) : solidRenderer({ project });
      return { appId: app.appId, entryPoint: app.entryPoint, renderer };
    }),
  };
}

const EXTERNAL = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'solid-js', 'solid-js/web', 'solid-js/store', 'vue'];

async function runBuild(order: AppSpec[], projectRoot: string, clientBaseDir: string, isSSRBuild = false) {
  await taujsBuild({
    config: configFor(order, projectRoot, clientBaseDir) as never,
    projectRoot,
    clientBaseDir,
    isSSRBuild,
    vite: { build: { rollupOptions: { external: EXTERNAL } }, logLevel: 'silent' } as never,
  });
}

// Read only THIS app's own chunks (its dir's direct files + its `assets/`), NOT sub-app directories -
// the root app (entryPoint '') lives at dist/<type>/ which also CONTAINS nested apps like `admin/`.
function readDirJs(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.mjs'))) out.push(readFileSync(path.join(dir, e.name), 'utf8'));
    }
  } catch {
    /* missing dir -> no chunks */
  }
  return out;
}

function readEmitted(projectRoot: string, entryPoint: string, type: 'client' | 'ssr' = 'client'): string {
  const base = path.join(projectRoot, 'dist', type, entryPoint);
  const chunks = [...readDirJs(base), ...readDirJs(path.join(base, 'assets'))];
  if (!chunks.length) throw new Error(`no emitted JS for ${type}/${entryPoint || '(root)'}`);
  return chunks.join('\n');
}

const SOLID_MARK = /solid-js\/web|_tmpl\$|createComponent/;
const REACT_MARK = /react\/jsx|jsxDEV|jsxRuntimeExports|_jsx/;

describe('ESC-1 real taujsBuild - per-app containment + correct compiler routing', () => {
  for (const order of [
    [
      { appId: 'web', entryPoint: '', framework: 'react' },
      { appId: 'admin', entryPoint: 'admin', framework: 'solid' },
    ],
    [
      { appId: 'admin', entryPoint: 'admin', framework: 'solid' },
      { appId: 'web', entryPoint: '', framework: 'react' },
    ],
  ] as AppSpec[][]) {
    it(`compiles each app with ITS framework, no cross-framework output (order: ${order.map((a) => a.framework).join(',')})`, async () => {
      const { projectRoot, clientBaseDir } = scaffold(order);
      await runBuild(order, projectRoot, clientBaseDir);

      const reactOut = readEmitted(projectRoot, '');
      const solidOut = readEmitted(projectRoot, 'admin');

      expect(reactOut).toMatch(REACT_MARK);
      expect(reactOut).not.toMatch(SOLID_MARK);
      expect(solidOut).toMatch(SOLID_MARK);
      expect(solidOut).not.toMatch(/React\.createElement|react\/jsx/);
    });
  }

  it('filtered build (TAUJS_APP) instantiates ONLY the selected app', async () => {
    const order: AppSpec[] = [
      { appId: 'web', entryPoint: '', framework: 'react' },
      { appId: 'admin', entryPoint: 'admin', framework: 'solid' },
    ];
    const { projectRoot, clientBaseDir } = scaffold(order);
    process.env.TAUJS_APP = 'web';
    await runBuild(order, projectRoot, clientBaseDir);

    // only the react app's output exists; the solid app was not built
    expect(readEmitted(projectRoot, '')).toMatch(REACT_MARK);
    expect(() => readEmitted(projectRoot, 'admin')).toThrow();
  });

  it('SSR build routes each app to its framework too (client + SSR both covered)', async () => {
    const order: AppSpec[] = [
      { appId: 'web', entryPoint: '', framework: 'react' },
      { appId: 'admin', entryPoint: 'admin', framework: 'solid' },
    ];
    const { projectRoot, clientBaseDir } = scaffold(order);
    await runBuild(order, projectRoot, clientBaseDir, true);

    expect(readEmitted(projectRoot, '', 'ssr')).toMatch(REACT_MARK);
    expect(readEmitted(projectRoot, 'admin', 'ssr')).toMatch(SOLID_MARK);
    expect(readEmitted(projectRoot, 'admin', 'ssr')).not.toMatch(/react\/jsx/);
  });

  it('two apps of the SAME framework each build (fresh compiler instance per vite.build())', async () => {
    const order: AppSpec[] = [
      { appId: 'web', entryPoint: '', framework: 'solid' },
      { appId: 'admin', entryPoint: 'admin', framework: 'solid' },
    ];
    const { projectRoot, clientBaseDir } = scaffold(order);
    await runBuild(order, projectRoot, clientBaseDir);
    // both solid apps compiled independently (no lifecycle-state leakage across the two vite.build calls)
    expect(readEmitted(projectRoot, '')).toMatch(SOLID_MARK);
    expect(readEmitted(projectRoot, 'admin')).toMatch(SOLID_MARK);
  });
});

describe('ESC-1 real taujsBuild - Vue coexistence (vueRenderer) alongside a managed compiler', () => {
  it('a vueRenderer() app coexists with a managed React app - both build, no false different-key hard error', async () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'esc1-vue-'));
    roots.push(projectRoot);
    const clientBaseDir = path.join(projectRoot, 'src', 'client');

    // React (managed) app at the root.
    mkdirSync(clientBaseDir, { recursive: true });
    writeFileSync(path.join(clientBaseDir, 'entry-client.tsx'), 'export { default } from "./App";\n');
    writeFileSync(path.join(clientBaseDir, 'entry-server.tsx'), 'export { default } from "./App";\n');
    writeFileSync(path.join(clientBaseDir, 'App.tsx'), 'export default function App() {\n  return <div className="r">react</div>;\n}\n');
    writeFileSync(
      path.join(clientBaseDir, 'index.html'),
      '<!doctype html><html><body><script type="module" src="./entry-client.tsx"></script></body></html>\n',
    );
    writeFileSync(path.join(clientBaseDir, 'tsconfig.react.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' }, include: ['*.tsx'] }));

    // Vue app (vueRenderer supplies pluginVue internally, compiles .vue - not part of the JSX collision
    // surface, not a managed JSX compiler).
    const vueDir = path.join(clientBaseDir, 'shop');
    mkdirSync(vueDir, { recursive: true });
    writeFileSync(path.join(vueDir, 'entry-client.ts'), 'import App from "./App.vue";\nexport default App;\n');
    writeFileSync(path.join(vueDir, 'entry-server.ts'), 'import App from "./App.vue";\nexport default App;\n');
    writeFileSync(path.join(vueDir, 'App.vue'), '<template><div class="v">vue</div></template>\n');
    writeFileSync(path.join(vueDir, 'index.html'), '<!doctype html><html><body><script type="module" src="./entry-client.ts"></script></body></html>\n');

    const config = {
      apps: [
        { appId: 'web', entryPoint: '', renderer: reactRenderer({ project: 'src/client/tsconfig.react.json' }) },
        { appId: 'shop', entryPoint: 'shop', renderer: vueRenderer() },
      ],
    };

    // No throw = the host does not mistake the Vue renderer's plugin pack for a different-key JSX compiler.
    await taujsBuild({
      config: config as never,
      projectRoot,
      clientBaseDir,
      isSSRBuild: false,
      vite: { build: { rollupOptions: { external: EXTERNAL } }, logLevel: 'silent' } as never,
    });

    expect(readEmitted(projectRoot, '')).toMatch(REACT_MARK);
    // the Vue app compiled its .vue via pluginVue (Vue runtime markers), with no React/Solid contamination
    const vueOut = readEmitted(projectRoot, 'shop');
    expect(vueOut).toMatch(/createElementBlock|openBlock|createVNode|vue/);
    expect(vueOut).not.toMatch(SOLID_MARK);
  });
});

describe('ESC-1 real taujsBuild - filtered build importing an absent-compiler file fails closed', () => {
  it('a filtered React build that imports a globally-classified Solid node_modules package hard-errors (classifier absent-compiler, real host)', async () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'esc1-absent-'));
    roots.push(projectRoot);
    const clientBaseDir = path.join(projectRoot, 'src', 'client');

    // React app 'web' whose entry imports a Solid node_modules package (a cross-framework mistake).
    mkdirSync(clientBaseDir, { recursive: true });
    writeFileSync(
      path.join(clientBaseDir, 'entry-client.tsx'),
      'import Widget from "solid-lib";\nexport default function App() {\n  return <div>{typeof Widget}</div>;\n}\n',
    );
    writeFileSync(path.join(clientBaseDir, 'entry-server.tsx'), 'export default function App() {\n  return <div className="r">r</div>;\n}\n');
    writeFileSync(
      path.join(clientBaseDir, 'index.html'),
      '<!doctype html><html><body><script type="module" src="./entry-client.tsx"></script></body></html>\n',
    );
    writeFileSync(path.join(clientBaseDir, 'tsconfig.react.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' }, include: ['*.tsx'] }));

    // Solid app 'admin' so the Solid classifier runs over the global universe.
    mkdirSync(path.join(clientBaseDir, 'admin'), { recursive: true });
    writeFileSync(path.join(clientBaseDir, 'admin', 'entry-client.tsx'), 'export default function A() {\n  return <div class="s">s</div>;\n}\n');
    writeFileSync(path.join(clientBaseDir, 'admin', 'entry-server.tsx'), 'export default function A() {\n  return <div class="s">s</div>;\n}\n');
    writeFileSync(
      path.join(clientBaseDir, 'admin', 'index.html'),
      '<!doctype html><html><body><script type="module" src="./entry-client.tsx"></script></body></html>\n',
    );
    writeFileSync(
      path.join(clientBaseDir, 'tsconfig.solid.json'),
      JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['admin/**/*.tsx'] }),
    );

    // A node_modules package declaring a `solid` export condition (the classifier owns it, no boundary).
    writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'absent-root', private: true, dependencies: { 'solid-lib': '*' } }));
    const libDir = path.join(projectRoot, 'node_modules', 'solid-lib');
    mkdirSync(path.join(libDir, 'src'), { recursive: true });
    writeFileSync(
      path.join(libDir, 'package.json'),
      JSON.stringify({ name: 'solid-lib', version: '1.0.0', type: 'module', exports: { '.': { solid: './src/index.jsx', default: './src/index.jsx' } } }),
    );
    writeFileSync(path.join(libDir, 'src', 'index.jsx'), 'export default () => <div>lib</div>;\n');

    const config = {
      apps: [
        { appId: 'web', entryPoint: '', renderer: reactRenderer({ project: 'src/client/tsconfig.react.json' }) },
        { appId: 'admin', entryPoint: 'admin', renderer: solidRenderer({ project: 'src/client/tsconfig.solid.json' }) },
      ],
    };

    // Filtered to the React app only: Solid is classified globally but NOT instantiated here.
    process.env.TAUJS_APP = 'web';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      await expect(
        taujsBuild({
          config: config as never,
          projectRoot,
          clientBaseDir,
          isSSRBuild: false,
          vite: { build: { rollupOptions: { external: EXTERNAL } }, logLevel: 'silent' } as never,
        }),
      ).rejects.toThrow();
      // the diagnostic hard-errored on the classified Solid package file (compiled by no compiler here)
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (a instanceof Error ? a.message : String(a)))
        .join('\n');
      expect(logged).toMatch(/compiled by NO compiler in this environment/);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('ESC-1 real taujsBuild - fail-closed before Vite starts', () => {
  it('rejects a same-key exclusion overlap during phase-1 preparation (finding 3a, through the real host)', async () => {
    // two Solid apps: app A excludes a directory app B claims -> assertNoExclusionConflicts throws inside
    // prepareOwnership, before any vite.build.
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'esc1-conflict-'));
    roots.push(projectRoot);
    const clientBaseDir = path.join(projectRoot, 'src', 'client');
    mkdirSync(path.join(clientBaseDir, 'admin'), { recursive: true });
    mkdirSync(path.join(clientBaseDir, 'shared'), { recursive: true });
    writeFileSync(
      path.join(clientBaseDir, 'tsconfig.web.json'),
      JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['*.tsx'], exclude: ['shared'] }),
    );
    writeFileSync(
      path.join(clientBaseDir, 'admin', 'tsconfig.admin.json'),
      JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['../shared/**/*.tsx'] }),
    );

    const config = {
      apps: [
        { appId: 'web', entryPoint: '', renderer: solidRenderer({ project: 'src/client/tsconfig.web.json' }) },
        { appId: 'admin', entryPoint: 'admin', renderer: solidRenderer({ project: 'src/client/admin/tsconfig.admin.json' }) },
      ],
    };
    await expect(taujsBuild({ config: config as never, projectRoot, clientBaseDir, isSSRBuild: false, vite: { logLevel: 'silent' } as never })).rejects.toThrow(
      /cancels another Solid project's claim/,
    );
  });

  it('rejects an app that omits `renderer:` entirely (renderer v1: `renderer:` is required, through the real host build path)', async () => {
    // A scaffolded React app whose build config declares NO `renderer:` - the host pre-pass hard-errors
    // fail-closed inside prepareOwnership, before any vite.build runs.
    const order: AppSpec[] = [{ appId: 'web', entryPoint: '', framework: 'react' }];
    const { projectRoot, clientBaseDir } = scaffold(order);
    const config = { apps: [{ appId: 'web', entryPoint: '' }] };
    await expect(
      taujsBuild({
        config: config as never,
        projectRoot,
        clientBaseDir,
        isSSRBuild: false,
        vite: { build: { rollupOptions: { external: EXTERNAL } }, logLevel: 'silent' } as never,
      }),
    ).rejects.toThrow(/must declare a valid renderer/);
  });
});
