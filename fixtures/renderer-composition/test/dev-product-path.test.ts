import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { refreshContainmentMessage } from '@taujs/server-internal/vite-plugins';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChildProcess } from 'node:child_process';

/**
 * The PRODUCT-PATH cell for the upstream `@vitejs/plugin-vue` fast-refresh defect -
 * `docs/followups/react-refresh-leaks-into-vue.md`. Its evidence bill requires the REAL development
 * path (`createServer` from `@taujs/server`), not the composition function: one τjs config with a
 * React app and a Vue app, one shared development Vite server, both SSR routes requested over HTTP.
 *
 * `@taujs/server` snapshots `NODE_ENV` at import, and this fixture's Vitest process runs without it,
 * so the server boots in a CHILD process (`test/support/dev-boot.mjs`, `NODE_ENV=development`, cwd =
 * this fixture so bare specifiers resolve here). The test owns the scaffold; the child owns the boot.
 */

const CHILD = path.resolve('test/support/dev-boot.mjs');
const FIXTURE_DIR = path.resolve('.');

const REACT_MARK = 'react-product-path';
const VUE_MARK = 'vue-product-path';

const CONTAINMENT_LINE = refreshContainmentMessage({ managedKeys: ['react'], environmentRendererKeys: ['vue'] });

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!--ssr-head-->
  </head>
  <body>
    <div id="root"><!--ssr-html--></div>
  </body>
</html>
`;

/**
 * A client root with the two apps the defect needs: a managed React app, and a Vue app whose SFC is
 * `<script setup lang="ts">` and calls a `use*` composable (`useSSRStore` from `@taujs/vue`) - the
 * exact shape oxc's refresh pass mistakes for a React hook.
 */
function scaffold(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'refresh-product-path-'));
  symlinkSync(path.join(FIXTURE_DIR, 'node_modules'), path.join(root, 'node_modules'), 'dir');

  writeFileSync(path.join(root, 'tsconfig.react.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' }, include: ['web/**/*.tsx'] }));

  const web = path.join(root, 'web');
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(web, 'App.tsx'), `export function App() {\n  return <div id="react-app">${REACT_MARK}</div>;\n}\n`);
  writeFileSync(
    path.join(web, 'entry-server.tsx'),
    [
      "import { createRenderer } from '@taujs/react';",
      "import { App } from './App';",
      '',
      'export const { renderSSR, renderStream } = createRenderer({',
      '  appComponent: () => <App />,',
      "  headContent: () => '<title>react</title>',",
      '});',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(web, 'entry-client.tsx'),
    [
      "import { hydrateApp } from '@taujs/react';",
      "import { App } from './App';",
      '',
      "hydrateApp({ appComponent: <App />, rootElementId: 'root' });",
      '',
    ].join('\n'),
  );

  const shop = path.join(root, 'shop');
  mkdirSync(shop, { recursive: true });
  writeFileSync(path.join(shop, 'index.html'), INDEX_HTML);
  writeFileSync(
    path.join(shop, 'App.vue'),
    [
      '<script setup lang="ts">',
      "import { useSSRStore } from '@taujs/vue';",
      '',
      'const store = useSSRStore();',
      'void store;',
      '</script>',
      '',
      `<template><div id="vue-app">${VUE_MARK}</div></template>`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(shop, 'entry-server.ts'),
    [
      "import { createRenderer } from '@taujs/vue';",
      "import App from './App.vue';",
      '',
      'export const { renderSSR, renderStream } = createRenderer({',
      '  appComponent: App,',
      "  headContent: () => '<title>vue</title>',",
      '});',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(shop, 'entry-client.ts'),
    ["import { hydrateApp } from '@taujs/vue';", "import App from './App.vue';", '', "hydrateApp({ appComponent: App, rootElementId: 'root' });", ''].join(
      '\n',
    ),
  );

  return root;
}

type Booted = { url: string; output: () => string };

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (text: string): string => text.replace(ANSI, '');

let child: ChildProcess | undefined;
let root: string | undefined;

// Teardown runs on FAILURE as well: a leaked child would hold its HMR port and its temp root.
afterEach(async () => {
  if (child) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = undefined;
  }
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

async function boot(order: 'react-first' | 'vue-first'): Promise<Booted> {
  root = scaffold();
  let captured = '';
  const proc = spawn(process.execPath, [CHILD, root, order], {
    cwd: FIXTURE_DIR,
    // Deterministic colour: the server's logger (picocolors) honours FORCE_COLOR/NO_COLOR, and a
    // maintainer shell exporting FORCE_COLOR wrapped the level tag in ANSI codes, so a substring pin on
    // `[warn] ...` missed. The child gets colour OFF explicitly, and the captured output is stripped of
    // ANSI before every assertion as well, so the pin holds under any terminal.
    env: { ...process.env, NODE_ENV: 'development', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => (captured += stripAnsi(chunk)));
  proc.stderr!.on('data', (chunk: string) => (captured += stripAnsi(chunk)));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev boot timed out; output was:\n${captured}`)), 45000);
    const check = (): void => {
      const match = /TAUJS_DEV_URL (\S+)/.exec(captured);
      if (!match) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(match[1]!);
    };
    const poll = setInterval(check, 50);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`dev boot exited early (code ${code}); output was:\n${captured}`));
    });
  });

  return { url, output: () => captured };
}

for (const order of ['react-first', 'vue-first'] as const) {
  describe(`real createServer development boot, React + Vue in one config (declaration order: ${order})`, () => {
    it('both SSR routes return 200 with their own marker and the Vue body carries no $RefreshSig$ error', async () => {
      const { url } = await boot(order);

      const react = await fetch(`${url}/react`);
      const vue = await fetch(`${url}/vue`);
      const reactBody = await react.text();
      const vueBody = await vue.text();

      expect(react.status).toBe(200);
      expect(reactBody).toContain(REACT_MARK);
      expect(vue.status).toBe(200);
      expect(vueBody).toContain(VUE_MARK);
      expect(vueBody).not.toContain('$RefreshSig$ is not defined');
    });

    it('the boot output carries the containment line exactly once, at warn level, with the ownership meta', async () => {
      const { url, output } = await boot(order);
      await fetch(`${url}/vue`);
      const captured = output();

      // Exactly once per boot: the config hook runs once for the one shared development server.
      expect(captured.split(CONTAINMENT_LINE)).toHaveLength(2);
      // Level and meta come from SSRServer's `onRefreshContainment` wiring; this is the real product
      // path, so the wiring is pinned here rather than against a mocked logger.
      expect(captured).toContain(`[warn] ${CONTAINMENT_LINE}`);
      expect(captured).toContain(
        '"component":"ownership","managedKeys":["react"],"environmentRendererKeys":["vue"],"upstream":"https://github.com/vitejs/vite-plugin-vue/issues/798"',
      );
    });
  });
}
