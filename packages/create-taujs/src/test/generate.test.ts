import { describe, expect, it } from 'vitest';

import { planFiles, type Framework, type ProjectConfig } from '../index';

const cfg = (framework: Framework): ProjectConfig => ({
  projectName: 'demo-app',
  packageManager: 'npm',
  installDeps: false,
  framework,
});

const fileMap = (framework: Framework): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const e of planFiles(cfg(framework))) {
    map[e.path] = 'json' in e ? JSON.stringify(e.json, null, 2) : e.content;
  }
  return map;
};

describe('planFiles — React golden', () => {
  // This snapshot freezes the React output so accidental drift is flagged.
  //
  // It is NO LONGER byte-identical to the pre-V2-02 generator, deliberately. Two proven defects
  // were corrected across react, vue AND solid (2026-07-20), and byte identity to a known-broken
  // baseline is not a property worth preserving:
  //   1. `src/server/types.d.ts` now IMPORTS '@taujs/server/config' before augmenting it. Without
  //      that import the block was an AMBIENT MODULE DECLARATION replacing the real module, so
  //      `defineConfig`/`defineService`/`defineServiceRegistry` reported TS2305 and route `data`
  //      callbacks fell to implicit `any` - no generated project of any framework typechecked.
  //   2. `esbuild` is now a declared devDependency; `build:server` shells out to its binary and
  //      failed with "esbuild: command not found".
  // Both were found by the end-to-end lifecycle gate, and both are asserted per-framework in
  // cli-solid.test.ts rather than resting on this snapshot alone.
  it('React file set + contents are frozen', () => {
    expect(fileMap('react')).toMatchSnapshot();
  });
});

describe('planFiles — Vue template', () => {
  const vue = fileMap('vue');
  const paths = Object.keys(vue);

  it('has the Vue client file set (SFCs + .ts entries + .vue shim) and no React client files', () => {
    for (const p of [
      'src/client/App.vue',
      'src/client/HomePage.vue',
      'src/client/StreamingPage.vue',
      'src/client/entry-client.ts',
      'src/client/entry-server.ts',
      'src/client/vite-env.d.ts',
    ]) {
      expect(paths, `missing ${p}`).toContain(p);
    }
    expect(paths).not.toContain('src/client/App.tsx');
    expect(paths).not.toContain('src/client/entry-client.tsx');
    expect(paths).not.toContain('src/client/entry-server.tsx');
    expect(vue['src/client/vite-env.d.ts']).toContain("declare module '*.vue'");
  });

  it('shares the server half unchanged with React (single source)', () => {
    const react = fileMap('react');
    for (const p of [
      'src/server/index.ts',
      'src/server/services/registry.ts',
      'src/server/services/example.service.ts',
      'src/server/types.d.ts',
      'build.ts',
      'src/client/index.html',
      'src/client/styles.css',
      'src/server/tsconfig.json',
      '.mcp.json',
      'CLAUDE.md',
    ]) {
      expect(vue[p], `server-half file diverged: ${p}`).toBe(react[p]);
    }
  });

  it('taujs.config declares renderer: vueRenderer() (not a raw pluginVue in plugins)', () => {
    expect(vue['taujs.config.ts']).toContain("import { vueRenderer } from '@taujs/vue/renderer';");
    expect(vue['taujs.config.ts']).toContain('renderer: vueRenderer(),');
    // vueRenderer supplies pluginVue internally - no raw pluginVue in the scaffolded config.
    expect(vue['taujs.config.ts']).not.toContain('pluginVue');
  });

  it('package.json swaps React deps for Vue, adds vue-tsc, and externals @taujs/vue', () => {
    const pkg = JSON.parse(vue['package.json']!);
    expect(pkg.dependencies).toHaveProperty('@taujs/vue');
    expect(pkg.dependencies).toHaveProperty('vue');
    expect(pkg.dependencies).toHaveProperty('@vue/server-renderer');
    expect(pkg.dependencies).not.toHaveProperty('@taujs/react');
    expect(pkg.dependencies).not.toHaveProperty('react');
    expect(pkg.dependencies).not.toHaveProperty('react-dom');
    expect(pkg.devDependencies).toHaveProperty('@vitejs/plugin-vue');
    expect(pkg.devDependencies).toHaveProperty('vue-tsc');
    expect(pkg.devDependencies).not.toHaveProperty('@vitejs/plugin-react');
    expect(pkg.scripts.lint).toBe('vue-tsc --noEmit');
    expect(pkg.scripts['build:server']).toContain('--external:@taujs/vue');
    expect(pkg.scripts['build:server']).not.toContain('@taujs/react');
    expect(pkg.scripts.build).toContain('--external:@taujs/vue');
  });

  it('tsconfig drops the React jsx option, otherwise identical to React', () => {
    const vts = JSON.parse(vue['tsconfig.json']!);
    const rts = JSON.parse(fileMap('react')['tsconfig.json']!);
    expect(vts.compilerOptions).not.toHaveProperty('jsx');
    expect(rts.compilerOptions).toHaveProperty('jsx', 'react-jsx');
    // everything except jsx matches
    const { jsx: _omit, ...rWithoutJsx } = rts.compilerOptions;
    expect(vts.compilerOptions).toEqual(rWithoutJsx);
  });

  it('demonstrates both consumption idioms', () => {
    expect(vue['src/client/HomePage.vue']).toContain('useSSRData<');
    expect(vue['src/client/HomePage.vue']).toContain('v-if="data"');
    expect(vue['src/client/StreamingPage.vue']).toContain('await useSSRDataAsync<');
    expect(vue['src/client/App.vue']).toContain('<Suspense');
  });

  it('references no removed APIs and no /__taujs paths', () => {
    const all = Object.values(vue).join('\n');
    expect(all).not.toMatch(/__taujs\//);
    expect(all).not.toMatch(/getSnapshotOrThrow|useSSRDataOrSuspend|RouteData|useRouteClientData/);
  });

  it('README documents the Vue file tree and Vue docs link', () => {
    expect(vue['README.md']).toContain('App.vue');
    expect(vue['README.md']).toContain('StreamingPage.vue');
    expect(vue['README.md']).toContain('[Vue Documentation](https://vuejs.org)');
    expect(vue['README.md']).not.toContain('[React Documentation]');
  });
});
