import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANAGED_CONTRIBUTION_BRAND } from '@taujs/server/config';
import { describe, expect, it } from 'vitest';

import { pluginSolid, scopedPluginSolid } from '../plugin.js';

import type { ManagedContributionShape, ManagedGroupMember } from '@taujs/server/config';

const fixturesDir = path.dirname(fileURLToPath(new URL('../compiler/test/fixtures/tsconfig.owned.json', import.meta.url)));
const UNSCOPED = Symbol.for('taujs.unscoped-compiler');
const toFwd = (p: string) => p.replace(/\\/g, '/');
const asShape = (contribution: unknown) => contribution as unknown as ManagedContributionShape;

describe('scopedPluginSolid', () => {
  it('returns a branded managed contribution with the solid key, project pointer, and impl reference', () => {
    const contribution = asShape(scopedPluginSolid({ project: './tsconfig.solid.json', ssr: true }));
    expect(contribution.brand).toBe(MANAGED_CONTRIBUTION_BRAND);
    expect(contribution.key).toBe('solid');
    expect(contribution.project).toBe('./tsconfig.solid.json');
    expect(contribution.impl.key).toBe('solid');
    expect(contribution.options).toEqual({ ssr: true });
  });

  it('shares ONE impl reference across contributions (safeguard 1: reference identity)', () => {
    expect(asShape(scopedPluginSolid({ project: './a.json' })).impl).toBe(asShape(scopedPluginSolid({ project: './b.json' })).impl);
  });

  it('rejects a missing project and the reserved include/exclude options', () => {
    expect(() => scopedPluginSolid({ project: '' })).toThrow(/requires a `project`/);
    // @ts-expect-error include is reserved
    expect(() => scopedPluginSolid({ project: './t.json', include: ['x'] })).toThrow(/does not accept `include`/);
    // @ts-expect-error exclude is reserved
    expect(() => scopedPluginSolid({ project: './t.json', exclude: ['x'] })).toThrow(/does not accept/);
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
    const contribution = asShape(scopedPluginSolid({ project: 'tsconfig.owned.json' }));
    const member: ManagedGroupMember = { contribution, appId: 'admin', appRoot: fixturesDir };

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
