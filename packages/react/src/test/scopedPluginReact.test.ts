// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANAGED_CONTRIBUTION_BRAND } from '@taujs/server/config';
import { describe, expect, it } from 'vitest';

import { pluginReact, scopedPluginReact } from '../plugin.js';

import type { ManagedContributionShape, ManagedGroupMember } from '@taujs/server/config';

const fixturesDir = path.dirname(fileURLToPath(new URL('../compiler/test/fixtures/tsconfig.owned.json', import.meta.url)));
const UNSCOPED = Symbol.for('taujs.unscoped-compiler');
const toFwd = (p: string) => p.replace(/\\/g, '/');
const asShape = (contribution: unknown) => contribution as unknown as ManagedContributionShape;

describe('scopedPluginReact', () => {
  it('returns a branded managed contribution with the react key, project pointer, and impl reference', () => {
    const contribution = asShape(scopedPluginReact({ project: './tsconfig.react.json' }));
    expect(contribution.brand).toBe(MANAGED_CONTRIBUTION_BRAND);
    expect(contribution.key).toBe('react');
    expect(contribution.project).toBe('./tsconfig.react.json');
    expect(contribution.impl.key).toBe('react');
    expect(typeof contribution.impl.prepare).toBe('function');
  });

  it('shares ONE impl reference across contributions (safeguard 1: reference identity)', () => {
    expect(asShape(scopedPluginReact({ project: './a.json' })).impl).toBe(asShape(scopedPluginReact({ project: './b.json' })).impl);
  });

  it('rejects a missing project and the reserved include/exclude options', () => {
    expect(() => scopedPluginReact({ project: '' })).toThrow(/requires a `project`/);
    // @ts-expect-error include is reserved - ownership is computed from the project
    expect(() => scopedPluginReact({ project: './t.json', include: ['x'] })).toThrow(/does not accept `include`/);
    // @ts-expect-error exclude is reserved
    expect(() => scopedPluginReact({ project: './t.json', exclude: ['x'] })).toThrow(/does not accept/);
  });

  it('carries opaque React options through unchanged', () => {
    expect(asShape(scopedPluginReact({ project: './t.json', jsxRuntime: 'automatic' })).options).toEqual({ jsxRuntime: 'automatic' });
  });
});

describe('pluginReact (raw, tagged)', () => {
  it('tags every plugin object in the pack with the unscoped-compiler key "react"', () => {
    const tags: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        const tag = (node as Record<symbol, unknown>)[UNSCOPED];
        if (typeof tag === 'string') tags.push(tag);
      }
    };
    walk(pluginReact());
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag === 'react')).toBe(true);
  });

  it('makes the tag non-enumerable (invisible to spreads/serialisation)', () => {
    const pack = pluginReact() as unknown[];
    const first = Array.isArray(pack[0]) ? (pack[0] as unknown[])[0] : pack[0];
    expect(Object.getOwnPropertyDescriptor(first, UNSCOPED)?.enumerable).toBe(false);
  });
});

describe('reactCompilerImpl.prepare (end-to-end ownership)', () => {
  it('derives claims/boundaries/exclude from the tsconfig project and builds a fresh, untagged plugin', async () => {
    const contribution = asShape(scopedPluginReact({ project: 'tsconfig.owned.json' }));
    const member: ManagedGroupMember = { contribution, appId: 'web', appRoot: fixturesDir };

    const plan = await contribution.impl.prepare([member], { projectRoot: fixturesDir, lifecycle: 'build' });
    expect(plan.key).toBe('react');
    expect(plan.claims).toContain(toFwd(path.join(fixturesDir, 'app/**/*.tsx')));
    expect(plan.exclude).toContain(toFwd(path.join(fixturesDir, 'app/legacy/**/*')));
    expect(plan.boundaries).toContain(toFwd(path.join(fixturesDir, 'app/**/*')));

    const built = plan.createPlugin({ include: plan.claims, exclude: [] });
    const flat: unknown[] = [];
    const walk = (node: unknown): void => void (Array.isArray(node) ? node.forEach(walk) : flat.push(node));
    walk(built);
    // the managed compiler carries the preamble fix and is NOT tagged (only raw pluginReact is)
    expect(flat.some((plugin) => (plugin as { name?: string })?.name === 'taujs:react-refresh-preamble-fix')).toBe(true);
    expect(flat.every((plugin) => (plugin as Record<symbol, unknown>)?.[UNSCOPED] === undefined)).toBe(true);
  });
});
