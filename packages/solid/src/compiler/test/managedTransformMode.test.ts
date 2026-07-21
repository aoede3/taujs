// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import { buildSolidContribution } from '../solidCompiler.js';

/**
 * The regression that would have caught the `ssr: true` omission.
 *
 * The design and `solidRenderer()`'s own documentation both asserted that managed Solid always
 * constructs `vite-plugin-solid` with `ssr: true`. It never did - the option was simply absent
 * from the factory. Nothing caught it because no test drove a REAL transform through a managed
 * plugin instance; the ESC-1 suites asserted ownership shape (claims, boundaries, matchers), which
 * is orthogonal to transform MODE.
 *
 * What `ssr: true` actually does, per the pinned plugin, is make ONE plugin instance select output
 * PER TRANSFORM:
 *   - an SSR transform  -> Solid SSR output (`ssr`/`ssrHydrationKey`/`escape`)
 *   - a browser transform -> HYDRATABLE DOM output (`template` + hydration keys)
 * Without it, every transform emits non-hydratable DOM output - including the server graph, where
 * Solid's DOM runtime functions are `notSup` throw-stubs, so the first SSR render dies with
 * "Client-only API called on the server side".
 *
 * So this test asserts BOTH directions from the SAME instance, which is the only way to
 * distinguish "forced SSR everywhere" from "correctly hydratable per graph".
 */
const APP_TSX = `export function App() {
  return <div id="app">managed</div>;
}
`;

let server: ViteDevServer | undefined;
let scratch: string | undefined;

afterEach(async () => {
  // `close()` can hang on a middleware-mode server whose dep-optimizer/HMR handles are still
  // settling. Teardown must be deterministic, so it is BOUNDED: the scratch directory and the
  // reference are released either way, and a slow close can never fail an unrelated assertion.
  const closing = server?.close();
  server = undefined;
  await Promise.race([closing, new Promise((r) => setTimeout(r, 2_000))]);

  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
}, 20_000);

/** Build a managed Solid plugin the way the host does, and transform one file both ways. */
async function transformBothWays(overrides?: { dropSsr?: boolean }) {
  // Deliberately INSIDE the package rather than in the OS temp dir: Vite must be able to resolve
  // `solid-js` from the scratch project, which needs the node_modules walk-up. Removed in afterEach.
  scratch = mkdtempSync(path.join(fileURLToPath(new URL('../../../', import.meta.url)), '.tmp-solid-mode-'));
  const clientDir = path.join(scratch, 'src', 'client');
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(path.join(clientDir, 'App.tsx'), APP_TSX);
  writeFileSync(
    path.join(scratch, 'tsconfig.solid.json'),
    JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['src/client/**/*.tsx'] }),
  );

  const contribution = buildSolidContribution({ project: 'tsconfig.solid.json' });
  const plan = await contribution.impl.prepare(
    [{ appId: 'main', appRoot: clientDir, contribution: contribution as never }] as never,
    { projectRoot: scratch } as never,
  );

  const include = ['**/*.tsx'];
  const plugin = overrides?.dropSsr
    ? // The tamper: the same construction WITHOUT `ssr: true`, to prove the assertions below
      // actually depend on it rather than passing for some incidental reason.
      (await import('vite-plugin-solid')).default({ include, exclude: [] })
    : plan.createPlugin({ include, exclude: [] } as never);

  server = await createServer({
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    root: scratch,
    server: { middlewareMode: true, watch: null },
    // No dep scan: this suite only inspects transform OUTPUT, and the optimizer is what keeps
    // handles alive past `close()`.
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [plugin as never],
  });

  const ssrResult = await server.transformRequest('/src/client/App.tsx', { ssr: true });
  const clientResult = await server.transformRequest('/src/client/App.tsx', { ssr: false });

  return { ssr: ssrResult?.code ?? '', client: clientResult?.code ?? '' };
}

/*
 * Markers calibrated against the pinned plugin's ACTUAL output for `<div id="app">managed</div>`:
 *
 *   ssr:true  + SSR transform    -> ssr(_tmpl$, ssrHydrationKey())            [Solid SSR output]
 *   ssr:true  + browser transform-> _$template(...) + _$getNextElement(_tmpl$) [HYDRATABLE DOM]
 *   no ssr    + SSR transform    -> template(...) + _tmpl$()                   [DOM in the server graph]
 *   no ssr    + browser transform-> _$template(...) + _tmpl$()                 [NON-hydratable DOM]
 *
 * So `getNextElement` - adopting existing server markup rather than creating fresh nodes - is the
 * signal that separates hydratable from non-hydratable DOM. `template` is matched in both its
 * client (`_$template`) and SSR-graph (`.template)(`) forms; matching only `template(` silently
 * missed the SSR-graph case while this test was being written.
 */
const isSolidSsrOutput = (code: string) => /ssrHydrationKey/.test(code);
const isDomOutput = (code: string) => /_\$template|\.template\)|\btemplate\s*\(/.test(code);
const isHydratable = (code: string) => /getNextElement/.test(code);

describe('managed Solid compiler - transform MODE (the ssr:true regression)', () => {
  it('an SSR transform produces Solid SSR output, not DOM output', async () => {
    const { ssr } = await transformBothWays();

    expect(isSolidSsrOutput(ssr), `SSR transform did not produce SSR output:\n${ssr.slice(0, 400)}`).toBe(true);
    // The precise failure mode of the omission: DOM runtime calls in the SERVER graph, where they
    // are `notSup` throw-stubs.
    expect(isDomOutput(ssr), 'SSR transform emitted DOM output - this is the crash that produced "Client-only API called on the server side"').toBe(false);
  });

  it('a BROWSER transform from the SAME instance produces hydratable DOM output', async () => {
    const { client } = await transformBothWays();

    expect(isDomOutput(client), `browser transform did not produce DOM output:\n${client.slice(0, 400)}`).toBe(true);
    expect(isSolidSsrOutput(client), 'browser transform emitted SSR output').toBe(false);
    // `ssr: true` does not mean "SSR everywhere" - it means the DOM output is HYDRATABLE, so the
    // client can adopt the server markup instead of re-rendering it.
    expect(isHydratable(client), `browser output is not hydratable:\n${client.slice(0, 400)}`).toBe(true);
  });

  it('WITHOUT ssr:true the SSR transform emits DOM output - the defect, reproduced', async () => {
    const { ssr } = await transformBothWays({ dropSsr: true });

    // This is what shipped before the fix, and what booted a 500 on the first SSR render.
    expect(isDomOutput(ssr)).toBe(true);
    expect(isSolidSsrOutput(ssr)).toBe(false);
  });
});
