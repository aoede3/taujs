import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildSolidContribution } from '../compiler/solidCompiler.js';
import { pluginSolid } from '../plugin.js';
import { solidRenderer } from '../renderer.js';

import type { ManagedContributionShape, ManagedGroupMember, RendererContributionShape } from '@taujs/server/renderer';

// The brand LITERALS (asserted by value, not imported at runtime): @taujs/solid must not runtime-depend
// on @taujs/server. Compile-time equality with the host is enforced by the type-only brand imports; the
// cross-package literal match is checked in fixtures/esc1-composition.
const MANAGED_CONTRIBUTION_BRAND = 'taujs.managed-plugin-contribution/v1';
const RENDERER_CONTRIBUTION_BRAND = 'taujs.renderer-contribution/v1';

const fixturesDir = path.dirname(fileURLToPath(new URL('../compiler/test/fixtures/tsconfig.owned.json', import.meta.url)));
const UNSCOPED = Symbol.for('taujs.unscoped-compiler');
const toFwd = (p: string) => p.replace(/\\/g, '/');
const asShape = (contribution: unknown) => contribution as unknown as ManagedContributionShape;

describe('buildSolidContribution (the managed compiler contribution solidRenderer carries)', () => {
  it('returns a branded managed contribution with the solid key, project pointer, and impl reference', () => {
    const contribution = buildSolidContribution({ project: './tsconfig.solid.json', ssr: true });
    expect(contribution.brand).toBe(MANAGED_CONTRIBUTION_BRAND);
    expect(contribution.key).toBe('solid');
    expect(contribution.project).toBe('./tsconfig.solid.json');
    expect(contribution.impl.key).toBe('solid');
    expect(contribution.options).toEqual({ ssr: true });
  });

  it('shares ONE impl reference across contributions (safeguard 1: reference identity)', () => {
    expect(buildSolidContribution({ project: './a.json' }).impl).toBe(buildSolidContribution({ project: './b.json' }).impl);
  });

  it('rejects a missing project and the reserved include/exclude options', () => {
    expect(() => buildSolidContribution({ project: '' })).toThrow(/requires a `project`/);
    // @ts-expect-error include is reserved
    expect(() => buildSolidContribution({ project: './t.json', include: ['x'] })).toThrow(/does not accept `include`/);
    // @ts-expect-error exclude is reserved
    expect(() => buildSolidContribution({ project: './t.json', exclude: ['x'] })).toThrow(/does not accept/);
  });
});

describe('solidRenderer (the public renderer contribution - COMPILER ONLY, no render module in v1)', () => {
  it('wraps the Solid managed compiler contribution with managedCompilation', () => {
    const contribution = solidRenderer({ project: './tsconfig.solid.json', ssr: true }) as unknown as RendererContributionShape;
    expect(contribution.brand).toBe(RENDERER_CONTRIBUTION_BRAND);
    expect(contribution.key).toBe('solid');
    expect(contribution.contractVersion).toBe('v1');
    expect(contribution.managedCompilation).toBe(true);
    expect(contribution.compiler?.brand).toBe(MANAGED_CONTRIBUTION_BRAND);
    expect(contribution.compiler?.key).toBe('solid');
  });
});

describe('pluginSolid (raw, tagged)', () => {
  it('tags the plugin object with the unscoped-compiler key "solid", non-enumerably', () => {
    const result = pluginSolid() as unknown;
    const plugin = Array.isArray(result) ? result[0] : result;
    expect((plugin as Record<symbol, unknown>)[UNSCOPED]).toBe('solid');
    expect(Object.getOwnPropertyDescriptor(plugin, UNSCOPED)?.enumerable).toBe(false);
  });
});

describe('solidCompilerImpl.prepare (end-to-end ownership)', () => {
  it('derives claims/boundaries/exclude from the tsconfig project and builds a fresh, untagged plugin', async () => {
    const contribution = buildSolidContribution({ project: 'tsconfig.owned.json' });
    const member: ManagedGroupMember = { contribution: asShape(contribution), appId: 'admin', appRoot: fixturesDir };

    const plan = await contribution.impl.prepare([member], { projectRoot: fixturesDir, lifecycle: 'build' });
    expect(plan.key).toBe('solid');
    expect(plan.claims).toContain(toFwd(path.join(fixturesDir, 'app/**/*.tsx')));
    expect(plan.exclude).toContain(toFwd(path.join(fixturesDir, 'app/legacy/**/*')));
    expect(plan.boundaries).toContain(toFwd(path.join(fixturesDir, 'app/**/*')));

    const built = plan.createPlugin({ include: plan.claims, exclude: [] }) as unknown;
    expect((built as { name?: string })?.name).toBe('solid');
    expect((built as Record<symbol, unknown>)?.[UNSCOPED]).toBeUndefined();
  });
});

describe('ESC-1 matrix coverage (Solid)', () => {
  const member = (name: string): ManagedGroupMember => ({ contribution: asShape(buildSolidContribution({ project: name })), appId: name, appRoot: fixturesDir });

  it('case 1 - two same-key Solid apps at different roots union their claims', async () => {
    const group = [member('tsconfig.owned.json'), member('tsconfig.owned2.json')];
    const plan = await group[0]!.contribution.impl.prepare(group, { projectRoot: fixturesDir, lifecycle: 'build' });
    expect(plan.claims).toContain(toFwd(path.join(fixturesDir, 'app/**/*.tsx')));
    expect(plan.claims).toContain(toFwd(path.join(fixturesDir, 'app2/**/*.tsx')));
  });

  it('case §8 - the REAL scoped Solid plugin transforms a query-suffixed id (HMR ?t / dep ?v), not only the bare path', async () => {
    const contribution = buildSolidContribution({ project: 'tsconfig.owned.json' });
    const plan = await contribution.impl.prepare([{ contribution: asShape(contribution), appId: 'admin', appRoot: fixturesDir }], { projectRoot: fixturesDir, lifecycle: 'dev' });
    const plugin = plan.createPlugin({ include: plan.claims, exclude: [] }) as {
      transform?: ((this: unknown, code: string, id: string, opts?: unknown) => unknown) | { handler: (this: unknown, code: string, id: string, opts?: unknown) => unknown };
    };
    const t = plugin.transform;
    const handler = typeof t === 'function' ? t : t?.handler;
    expect(typeof handler).toBe('function');

    const source = 'export default function C() {\n  return <div>hi</div>;\n}\n';
    const ctx = {
      error(e: unknown) {
        throw e instanceof Error ? e : new Error(String(e));
      },
    };
    const ownedId = toFwd(path.join(fixturesDir, 'app', 'Q.tsx'));
    const run = async (id: string) => {
      const out = await handler!.call(ctx, source, id, { ssr: false });
      return typeof out === 'string' ? out : ((out as { code?: string } | null | undefined)?.code ?? null);
    };

    const bare = await run(ownedId); // control - bare path compiles
    const withTimestamp = await run(`${ownedId}?t=123`); // HMR
    const withVersion = await run(`${ownedId}?v=abc`); // dep hash
    const skipped = await run(toFwd(path.join(fixturesDir, 'other', 'Nope.tsx'))); // not owned -> skipped

    expect(bare).toBeTruthy();
    expect(withTimestamp).toBeTruthy(); // the fix: query-suffixed ids are still compiled
    expect(withVersion).toBeTruthy();
    expect(skipped).toBeNull();
    // and the query variant produced real Solid output, not passthrough
    expect(withTimestamp).toMatch(/solid-js\/web|_tmpl\$|createComponent/);
  });

  it('case 18 - the built plugin bundle carries NO runtime @taujs/server import (raw pluginSolid stays portable)', async () => {
    const { readFile } = await import('node:fs/promises');
    const dist = fileURLToPath(new URL('../../dist/plugin.js', import.meta.url));
    const code = await readFile(dist, 'utf8').catch(() => {
      throw new Error(`dist/plugin.js missing at ${dist} - run \`pnpm build\` first (CI builds before tests)`);
    });
    expect(code).not.toMatch(/from ['"]@taujs\/server/);
    expect(code).not.toMatch(/require\(['"]@taujs\/server/);
    expect(code).toMatch(/vite-plugin-solid/); // the raw wrapper's real, portable dependency
  });
});
