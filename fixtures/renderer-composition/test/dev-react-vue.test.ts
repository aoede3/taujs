import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reactRenderer } from '@taujs/react/renderer';
import { vueRenderer } from '@taujs/vue/renderer';
import { createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

// TEST-ONLY host-internal import via a Vitest alias (see vitest.config.ts -> @taujs/server-internal/*).
// The SAME dev composition SSRServer's dev branch runs, so this cell exercises the real chain rather
// than a hand-rolled copy.
import { assembleDevPluginChain } from '@taujs/server-internal/ownership';

import type { Plugin, ViteDevServer } from 'vite';

/**
 * Containment of the upstream `@vitejs/plugin-vue` fast-refresh defect on the ONE shared development
 * Vite server - `docs/followups/react-refresh-leaks-into-vue.md`, upstream
 * https://github.com/vitejs/vite-plugin-vue/issues/798 (fix pending in PR #814).
 *
 * Without containment, plugin-react's `oxc.jsx.refresh: true` reaches plugin-vue's own
 * `transformWithOxc` call for a `<script setup lang="ts">` block, oxc reads `useSlots()` as a hook and
 * emits a `$RefreshSig$()` signature, and the Vue SSR module throws `$RefreshSig$ is not defined`.
 *
 * Every assertion here is about the REAL transform output of a real Vite dev server composed through
 * `assembleDevPluginChain`, for BOTH declaration orders, plus a React-alone control that proves the
 * containment is conditioned on the composition rather than switched on globally.
 */

const REACT_MARK = /react\/jsx|jsxDEV|_jsx/;
const SFC_MARK = /_sfc_main|defineComponent/;
const REFRESH_SIG = /\$RefreshSig\$/;
const REFRESH_REG = /\$RefreshReg\$/;
const CONTAINMENT_PLUGIN = 'taujs:oxc-refresh-containment';

const REACT_APP = 'export default function App() {\n  return <div className="r">react</div>;\n}\n';

// The exact SFC shape the defect needs: `lang="ts"` (so plugin-vue transpiles the block itself) plus a
// `use*` call (which oxc's refresh pass reads as a hook).
const vueSfc = (marker: string) => `<script setup lang="ts">
import { useSlots } from 'vue';
const slots = useSlots();
void slots;
</script>
<template><div class="v">${marker}</div></template>
`;

type Booted = {
  root: string;
  server: ViteDevServer;
  plugins: Plugin[];
  onRefreshContainment: ReturnType<typeof vi.fn>;
};

const booted: Booted[] = [];

afterEach(async () => {
  for (const b of booted.splice(0)) {
    await b.server.close();
    rmSync(b.root, { recursive: true, force: true });
  }
});

/**
 * Scaffold a temp client root and compose the REAL dev chain for the given app order, then drive a real
 * Vite dev server with it. `withVue: false` is the control composition (managed React alone).
 */
async function boot(opts: { order: 'react-first' | 'vue-first'; withVue: boolean }): Promise<Booted> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'refresh-containment-'));
  try {
    symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  } catch {
    /* symlink unavailable -> transformRequest import resolution may fail */
  }

  mkdirSync(path.join(root, 'src-react'), { recursive: true });
  mkdirSync(path.join(root, 'src-vue'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.react.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' }, include: ['src-react/**/*.tsx'] }));
  writeFileSync(path.join(root, 'src-react', 'App.tsx'), REACT_APP);
  writeFileSync(path.join(root, 'src-vue', 'App.vue'), vueSfc('vue'));

  const reactApp = { appId: 'web', appRoot: path.join(root, 'src-react'), plugins: [], renderer: reactRenderer({ project: 'tsconfig.react.json' }) };
  const vueApp = { appId: 'shop', appRoot: path.join(root, 'src-vue'), plugins: [], renderer: vueRenderer() };
  const apps = !opts.withVue ? [reactApp] : opts.order === 'react-first' ? [reactApp, vueApp] : [vueApp, reactApp];

  const onRefreshContainment = vi.fn();
  const { plugins } = await assembleDevPluginChain({ apps, projectRoot: root, onRefreshContainment });

  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    // HMR must stay ENABLED: plugin-react turns oxc JSX fast refresh OFF by itself when
    // `server.hmr === false`, which would make the containment unobservable either way. `hmr.port: 0`
    // takes an ephemeral port so parallel boots in this file never collide.
    server: { middlewareMode: true, hmr: { port: 0 }, watch: { usePolling: true, interval: 40 } },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: plugins as Plugin[],
  });

  const record: Booted = { root, server, plugins: plugins as Plugin[], onRefreshContainment };
  booted.push(record);
  return record;
}

const codeOf = async (server: ViteDevServer, url: string, ssr = false): Promise<string> => {
  const res = await server.transformRequest(url, ssr ? { ssr: true } : undefined);
  return res?.code ?? '';
};

for (const order of ['react-first', 'vue-first'] as const) {
  describe(`React + Vue on one shared dev server (declaration order: ${order})`, () => {
    it('the Vue SFC SSR transform is Vue-compiled and carries neither $RefreshSig$ nor $RefreshReg$', async () => {
      const { server } = await boot({ order, withVue: true });
      const ssr = await codeOf(server, '/src-vue/App.vue', true);

      expect(ssr).toMatch(SFC_MARK);
      expect(ssr).not.toMatch(REFRESH_SIG);
      expect(ssr).not.toMatch(REFRESH_REG);
    });

    it('the Vue SFC CLIENT transform likewise carries neither $RefreshSig$ nor $RefreshReg$', async () => {
      const { server } = await boot({ order, withVue: true });
      const client = await codeOf(server, '/src-vue/App.vue');

      expect(client).toMatch(SFC_MARK);
      expect(client).not.toMatch(REFRESH_SIG);
      expect(client).not.toMatch(REFRESH_REG);
    });

    it('the React file still compiles as React and is not Vue-compiled', async () => {
      const { server } = await boot({ order, withVue: true });
      const react = await codeOf(server, '/src-react/App.tsx');

      expect(react).toMatch(REACT_MARK);
      expect(react).not.toMatch(SFC_MARK);
    });

    it('the React CLIENT transform carries NO $RefreshReg$/$RefreshSig$ under containment - the measured degradation the warning describes', async () => {
      const { server } = await boot({ order, withVue: true });
      const react = await codeOf(server, '/src-react/App.tsx');

      // This is the whole cost of the containment, measured rather than assumed: React modules lose
      // their fast-refresh registration on this server, so an edit falls back to a full reload.
      expect(react).not.toMatch(REFRESH_REG);
      expect(react).not.toMatch(REFRESH_SIG);
      expect(react).toMatch(REACT_MARK); // rendering itself is unaffected
    });

    it('a Vue SFC written AFTER startup transforms with no $RefreshSig$ (not the startup snapshot)', async () => {
      const { root, server } = await boot({ order, withVue: true });
      writeFileSync(path.join(root, 'src-vue', 'Later.vue'), vueSfc('later'));

      const ssr = await codeOf(server, '/src-vue/Later.vue', true);
      const client = await codeOf(server, '/src-vue/Later.vue');

      expect(ssr).toContain('later');
      expect(ssr).toMatch(SFC_MARK);
      expect(ssr).not.toMatch(REFRESH_SIG);
      expect(client).not.toMatch(REFRESH_SIG);
    });

    it('the containment plugin is in the composed chain and its callback fires exactly once with react/vue keys', async () => {
      const { plugins, onRefreshContainment } = await boot({ order, withVue: true });

      expect(plugins.map((p) => p.name)).toContain(CONTAINMENT_PLUGIN);
      expect(onRefreshContainment).toHaveBeenCalledTimes(1);
      expect(onRefreshContainment).toHaveBeenCalledWith({ managedKeys: ['react'], environmentRendererKeys: ['vue'] });
    });
  });
}

describe('CONTROL - managed React alone on the shared dev server', () => {
  it('React keeps $RefreshReg$, the containment plugin is absent and its callback never fires', async () => {
    const { server, plugins, onRefreshContainment } = await boot({ order: 'react-first', withVue: false });
    const react = await codeOf(server, '/src-react/App.tsx');

    // The counterpart of the paired measurement above: with no non-managed renderer sharing the server,
    // oxc JSX fast refresh stays ON. The containment is conditioned on the composition, not a global switch.
    expect(react).toMatch(REFRESH_REG);
    expect(plugins.map((p) => p.name)).not.toContain(CONTAINMENT_PLUGIN);
    expect(onRefreshContainment).not.toHaveBeenCalled();
  });
});
