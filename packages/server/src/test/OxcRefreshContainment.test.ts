// @vitest-environment node
// (OwnershipPrepass imports Vite's `createFilter`, which loads esbuild; esbuild's TextEncoder
// invariant breaks under the package-default jsdom environment - mirrors OwnershipPrepass.test.ts.)
import { describe, expect, it, vi } from 'vitest';

import { MANAGED_CONTRIBUTION_BRAND } from '../utils/ManagedPlugins';
import { assembleDevPluginChain, REFRESH_CONTAINMENT_PLUGIN } from '../utils/OwnershipPrepass';
import { refreshContainmentMessage } from '../utils/VitePlugins';
import { rendererFromManaged, testRenderer } from './support/renderer';

import type { Plugin } from 'vite';
import type { CompilerImpl, ManagedContributionShape } from '../utils/ManagedPlugins';
import type { RefreshContainment } from '../utils/OwnershipPrepass';

/**
 * Unit pins for the development fast-refresh containment - `docs/followups/react-refresh-leaks-into-vue.md`.
 *
 * The behaviour under real Vite (Vue SSR carries no `$RefreshSig$`; React loses `$RefreshReg$`) is
 * proved by `fixtures/renderer-composition/test/dev-react-vue.test.ts`, and the real `createServer`
 * boot - including the warn level and the log meta SSRServer wires - by
 * `fixtures/renderer-composition/test/dev-product-path.test.ts`. What is pinned HERE is the
 * host-side decision surface: the composition condition, the config hook's arithmetic, and the
 * message text.
 */

const makeImpl = (key: string): CompilerImpl => ({
  key,
  prepare: vi.fn(async () => ({ key, claims: [], boundaries: [], createPlugin: () => ({ name: `${key}:compiler` }) })),
});

const managed = (key: string): ManagedContributionShape => ({
  brand: MANAGED_CONTRIBUTION_BRAND,
  key,
  impl: makeImpl(key),
  project: `./tsconfig.${key}.json`,
  options: {},
});

const managedApp = (appId: string, key: string) => ({ appId, appRoot: `/repo/${appId}`, plugins: [], renderer: rendererFromManaged(managed(key)) });
const environmentApp = (appId: string, key: string) => ({ appId, appRoot: `/repo/${appId}`, plugins: [], renderer: testRenderer({ key }) });

type Apps = ReadonlyArray<ReturnType<typeof managedApp> | ReturnType<typeof environmentApp>>;

const compose = async (apps: Apps, onRefreshContainment?: (info: RefreshContainment) => void) =>
  assembleDevPluginChain({ apps, projectRoot: '/repo', onRefreshContainment });

const containmentIn = (plugins: Plugin[]): Plugin | undefined => plugins.find((p) => p.name === REFRESH_CONTAINMENT_PLUGIN);

type ConfigHook = (conf: unknown, env: { command: string; mode: string }) => unknown;
const configHookOf = (plugin: Plugin): ConfigHook => plugin.config as unknown as ConfigHook;

describe('assembleDevPluginChain - the containment plugin is installed only for the React compiler sharing the dev server with the Vue renderer', () => {
  it('installs it for a managed React app beside a non-managed Vue app', async () => {
    const { plugins } = await compose([managedApp('web', 'react'), environmentApp('shop', 'vue')]);
    expect(containmentIn(plugins)).toBeDefined();
  });

  it('installs it regardless of declaration order (Vue app declared first)', async () => {
    const { plugins } = await compose([environmentApp('shop', 'vue'), managedApp('web', 'react')]);
    expect(containmentIn(plugins)).toBeDefined();
  });

  it('does NOT install it for two MANAGED compilers (React + Solid)', async () => {
    const { plugins } = await compose([managedApp('web', 'react'), managedApp('admin', 'solid')]);
    expect(containmentIn(plugins)).toBeUndefined();
  });

  it('does NOT install it for managed React beside an UNRELATED non-managed renderer (no Vue): React keeps its refresh, nothing blames plugin-vue', async () => {
    const onRefreshContainment = vi.fn();
    const { plugins } = await compose([managedApp('web', 'react'), environmentApp('store', 'other')], onRefreshContainment);
    expect(containmentIn(plugins)).toBeUndefined();
    expect(onRefreshContainment).not.toHaveBeenCalled();
  });

  it('does NOT install it for managed Solid beside Vue (only React turns oxc JSX refresh on)', async () => {
    const { plugins } = await compose([managedApp('admin', 'solid'), environmentApp('shop', 'vue')]);
    expect(containmentIn(plugins)).toBeUndefined();
  });

  it('reports the triggering pair only for React + Solid + Vue (Solid is not degraded and is not named)', async () => {
    const onRefreshContainment = vi.fn();
    const { plugins } = await compose([managedApp('web', 'react'), managedApp('admin', 'solid'), environmentApp('shop', 'vue')], onRefreshContainment);
    configHookOf(containmentIn(plugins)!)({ oxc: { jsx: { refresh: true } } }, { command: 'serve', mode: 'development' });
    expect(onRefreshContainment).toHaveBeenCalledWith({ managedKeys: ['react'], environmentRendererKeys: ['vue'] });
  });

  it('does NOT install it for a non-managed renderer alone (Vue only)', async () => {
    const { plugins } = await compose([environmentApp('shop', 'vue')]);
    expect(containmentIn(plugins)).toBeUndefined();
  });

  it('does NOT install it when no app declares a managed contribution (two non-managed renderers)', async () => {
    const { plugins, ownership } = await compose([environmentApp('shop', 'vue'), environmentApp('store', 'other')]);
    expect(ownership.active).toBe(false);
    expect(plugins).toEqual([]); // no host sources at all: such a config composes exactly as before
  });
});

describe('the containment plugin config hook - it overrides oxc JSX refresh only when a serve config actually has it on', () => {
  const serve = { command: 'serve', mode: 'development' };

  const hookFor = async (): Promise<{ hook: ConfigHook; onRefreshContainment: ReturnType<typeof vi.fn> }> => {
    const onRefreshContainment = vi.fn();
    const { plugins } = await compose([managedApp('web', 'react'), environmentApp('shop', 'vue')], onRefreshContainment);
    return { hook: configHookOf(containmentIn(plugins)!), onRefreshContainment };
  };

  it('is a serve-only, post-enforced plugin (so it sees the accumulated config plugin-react contributed)', async () => {
    const { plugins } = await compose([managedApp('web', 'react'), environmentApp('shop', 'vue')]);
    const plugin = containmentIn(plugins)!;
    expect(plugin.apply).toBe('serve');
    expect(plugin.enforce).toBe('post');
  });

  it('returns { oxc: { jsx: { refresh: false } } } and reports the managed/non-managed keys when refresh is on', async () => {
    const { hook, onRefreshContainment } = await hookFor();

    const result = hook({ oxc: { jsx: { refresh: true } } }, serve);

    expect(result).toEqual({ oxc: { jsx: { refresh: false } } });
    expect(onRefreshContainment).toHaveBeenCalledTimes(1);
    expect(onRefreshContainment).toHaveBeenCalledWith({ managedKeys: ['react'], environmentRendererKeys: ['vue'] });
  });

  it('returns undefined and reports nothing when refresh is already false', async () => {
    const { hook, onRefreshContainment } = await hookFor();

    expect(hook({ oxc: { jsx: { refresh: false } } }, serve)).toBeUndefined();
    expect(onRefreshContainment).not.toHaveBeenCalled();
  });

  it('returns undefined and reports nothing when there is no oxc config at all (non-Rolldown Vite: no version sniffing)', async () => {
    const { hook, onRefreshContainment } = await hookFor();

    expect(hook({}, serve)).toBeUndefined();
    expect(hook({ oxc: {} }, serve)).toBeUndefined();
    expect(onRefreshContainment).not.toHaveBeenCalled();
  });

  it('returns undefined and reports nothing for command "build" even with refresh on', async () => {
    const { hook, onRefreshContainment } = await hookFor();

    expect(hook({ oxc: { jsx: { refresh: true } } }, { command: 'build', mode: 'production' })).toBeUndefined();
    expect(onRefreshContainment).not.toHaveBeenCalled();
  });
});

describe('refreshContainmentMessage', () => {
  it('states the degradation, the upstream issue and PR, and the removal trigger, verbatim', () => {
    expect(refreshContainmentMessage({ managedKeys: ['react'], environmentRendererKeys: ['vue'] })).toBe(
      "Development containment: oxc JSX fast refresh is disabled on this shared development server because managed compiler(s) react share it with non-managed renderer(s) vue. react edits fall back to a full reload; rendering is unaffected. Cause: @vitejs/plugin-vue applies the shared oxc config to its own SFC transpile (https://github.com/vitejs/vite-plugin-vue/issues/798; fix pending in https://github.com/vitejs/vite-plugin-vue/pull/814). Remove this containment once @taujs/vue's @vitejs/plugin-vue floor carries that fix.",
    );
  });
});
