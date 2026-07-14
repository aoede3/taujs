// RFC 0005 (VS2) - HARD GATE 2. The editor must tell the truth about the declared Vite surface:
// the `serve` context arm rejects `appId`, a build-arm-only callback is not a valid override,
// `TaujsViteConfig` refuses the protected invariants, and `TaujsOptimizeDeps` admits only the
// day-one subset. Type-level test in the repo's `.test-d.ts` idiom (see
// `core/config/test/HeadDataOf.test-d.ts`): enforced by `pnpm --filter @taujs/server typecheck`
// (tsc); the `.test-d.ts` suffix is outside vitest's spec glob so it never runs as a test.
// Invariant-`Equal` (not mere assignability) is used where width-subtyping could fake a pass.
import { defineConfig } from '../Config';

import type { TaujsOptimizeDeps, TaujsViteConfig, TaujsViteContext, TaujsViteOverride } from '../ViteConfig';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type ServeCtx = Extract<TaujsViteContext, { command: 'serve' }>;
type BuildCtx = Extract<TaujsViteContext, { command: 'build' }>;

// ── §1: serve arm rejects `appId` (and `entryPoint`) at compile time ─────────────────────────────
// On the serve arm both are declared `never`; as OPTIONAL properties the indexed access collapses
// `never | undefined` to `undefined` (RFC gate wording: "narrows to undefined/never"). Either way
// nothing string-bearing can be read from them.
type _ServeAppIdNever = Expect<Equal<ServeCtx['appId'], undefined>>;
type _ServeEntryNever = Expect<Equal<ServeCtx['entryPoint'], undefined>>;

declare const serveCtx: ServeCtx;
// @ts-expect-error - serve arm exposes no usable `appId` (typed `never`); read it only after narrowing to `command === 'build'`.
const _serveAppId: string = serveCtx.appId;
void _serveAppId;

// Narrowing a raw context to the serve arm removes `appId` as a string-bearing field.
declare const ctx: TaujsViteContext;
if (ctx.command === 'serve') {
  // @ts-expect-error - `appId` is `never` under the `serve` arm.
  const _narrowedAppId: string = ctx.appId;
  void _narrowedAppId;
}

// The build arm, by contrast, DOES carry a usable `appId`/`entryPoint`.
type _BuildAppId = Expect<Equal<BuildCtx['appId'], string>>;
type _BuildEntry = Expect<Equal<BuildCtx['entryPoint'], string>>;

// ── §4: a build-arm-only callback is NOT a valid `TaujsViteOverride` ──────────────────────────────
// The function form must accept the WHOLE union; a callback that only accepts the build arm could
// not honestly run for the shared dev server, so strictFunctionTypes rejects the assignment.
const buildOnlyCallback = (c: BuildCtx): TaujsViteConfig => ({ define: { __APP__: c.appId } });
// @ts-expect-error - a build-arm-only callback cannot satisfy `TaujsViteOverride` (must also accept the `serve` arm).
const _buildOnlyOverride: TaujsViteOverride = buildOnlyCallback;
void _buildOnlyOverride;

// A callback accepting the full union is fine.
const fullCallback: TaujsViteOverride = (c) => ({ logLevel: c.command === 'build' ? 'info' : 'warn' });
void fullCallback;

// ── §4: `TaujsViteConfig` rejects the protected invariants ───────────────────────────────────────
// @ts-expect-error - `root` is framework-controlled; not part of the surface.
const _root: TaujsViteConfig = { root: '/nope' };
// @ts-expect-error - `server.*` is dev-owned and protected.
const _server: TaujsViteConfig = { server: { port: 5173 } };
// @ts-expect-error - `configFile` is pinned to `false` by the framework.
const _configFile: TaujsViteConfig = { configFile: false };
// @ts-expect-error - `base` is framework-controlled.
const _base: TaujsViteConfig = { base: '/x/' };
// @ts-expect-error - `publicDir` is framework-controlled.
const _publicDir: TaujsViteConfig = { publicDir: 'assets' };
// @ts-expect-error - `appType` is framework-controlled.
const _appType: TaujsViteConfig = { appType: 'custom' };
// @ts-expect-error - `resolve.alias` has its own declarative home (top-level `alias`).
const _resolveAlias: TaujsViteConfig = { resolve: { alias: { '@x': '/x' } } };
// @ts-expect-error - `build.outDir` is framework-managed (dist/client vs dist/ssr).
const _outDir: TaujsViteConfig = { build: { outDir: 'out' } };
// @ts-expect-error - `build.rollupOptions.input` is framework-managed (entry points).
const _input: TaujsViteConfig = { build: { rollupOptions: { input: { main: 'x' } } } };
void [_root, _server, _configFile, _base, _publicDir, _appType, _resolveAlias, _outDir, _input];

// Admitted fields DO type-check.
const _ok: TaujsViteConfig = {
  plugins: [],
  define: { __VERSION__: '1' },
  css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
  optimizeDeps: { include: ['pkg'], exclude: ['other'] },
  esbuild: { jsx: 'automatic' },
  logLevel: 'warn',
  resolve: { dedupe: ['react'] },
  build: {
    sourcemap: 'inline',
    minify: 'esbuild',
    rollupOptions: { external: ['node:fs'], output: { manualChunks: { vendor: ['react'] } } },
  },
};
void _ok;

// ── §6: `TaujsOptimizeDeps` admits only include/exclude/esbuildOptions ────────────────────────────
type _OptimizeShape = Expect<Equal<keyof TaujsOptimizeDeps, 'include' | 'exclude' | 'esbuildOptions'>>;

// @ts-expect-error - `entries` is deliberately unadmitted (τjs owns shared-dev entry discovery).
const _entries: TaujsOptimizeDeps = { entries: ['x'] };
// @ts-expect-error - `noDiscovery` is deliberately unadmitted.
const _noDiscovery: TaujsOptimizeDeps = { noDiscovery: true };
// @ts-expect-error - `force` is an operational cache-bust, not durable config.
const _force: TaujsOptimizeDeps = { force: true };
// @ts-expect-error - `disabled` is deprecated in Vite and unadmitted.
const _disabled: TaujsOptimizeDeps = { disabled: true };
void [_entries, _noDiscovery, _force, _disabled];

// ── `defineConfig({ vite })` accepts BOTH static and function forms ───────────────────────────────
const _staticForm = defineConfig({
  apps: [{ appId: 'main', entryPoint: '', routes: [] }],
  vite: { plugins: [], define: { __APP__: '1' } },
});

const _functionForm = defineConfig({
  apps: [{ appId: 'main', entryPoint: '', routes: [] }],
  vite: (c) => ({ logLevel: c.command === 'build' && c.isSSRBuild ? 'silent' : 'info' }),
});

// And the declarative top-level `alias` is accepted.
const _aliasForm = defineConfig({
  apps: [{ appId: 'main', entryPoint: '', routes: [] }],
  alias: { '@components': './src/client/shared/components' },
});

void [_staticForm, _functionForm, _aliasForm];

// Keep tsc's noUnusedLocals honest.
export type _Proof = [_ServeAppIdNever, _ServeEntryNever, _BuildAppId, _BuildEntry, _OptimizeShape];
