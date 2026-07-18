// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANAGED_CONTRIBUTION_BRAND } from '@taujs/server/config';
import { createFilter } from 'vite';
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

// Framework-agnostic matrix cases proven at the prepare/filter level (integration cases 3/9/11/12 use
// a real Vite build). These exercise the React renderer but the mechanism is identical for Solid.
describe('ESC-1 matrix coverage (prepare/filter level)', () => {
  const project = (name: string) => asShape(scopedPluginReact({ project: name }));
  const member = (name: string): ManagedGroupMember => ({ contribution: project(name), appId: name, appRoot: fixturesDir });
  const prepareInput = { projectRoot: fixturesDir, lifecycle: 'build' as const };

  it('case 1 - two same-key apps at different roots union their claims in one plan', async () => {
    const group = [member('tsconfig.owned.json'), member('tsconfig.owned2.json')];
    const plan = await group[0]!.contribution.impl.prepare(group, prepareInput);
    expect(plan.claims).toContain(toFwd(path.join(fixturesDir, 'app/**/*.tsx')));
    expect(plan.claims).toContain(toFwd(path.join(fixturesDir, 'app2/**/*.tsx')));
  });

  it('case 5 - a file created after startup under an existing pattern is owned immediately (no re-derivation)', async () => {
    const plan = await member('tsconfig.owned.json').contribution.impl.prepare([member('tsconfig.owned.json')], prepareInput);
    const owns = createFilter(plan.claims, plan.exclude);
    // BrandNew.tsx does not exist on disk; pattern ownership does not depend on a file snapshot
    expect(owns(path.join(fixturesDir, 'app/BrandNew.tsx'))).toBe(true);
    expect(owns(path.join(fixturesDir, 'app/legacy/Old.tsx'))).toBe(false); // deliberate exclude still applies
  });

  it('case 8 - re-running prepare after a tsconfig edit re-derives scope (the post-restart behaviour)', async () => {
    const before = await member('tsconfig.owned.json').contribution.impl.prepare([member('tsconfig.owned.json')], prepareInput);
    const after = await member('tsconfig.owned2.json').contribution.impl.prepare([member('tsconfig.owned2.json')], prepareInput);
    // a different project (== an edited ownership topology, applied on the next process start) yields a different scope
    expect(before.claims).not.toEqual(after.claims);
    expect(after.claims).toContain(toFwd(path.join(fixturesDir, 'app2/**/*.tsx')));
  });

  it('case 14 - createPlugin yields a FRESH plugin object per invocation (no lifecycle-state leakage)', async () => {
    const plan = await member('tsconfig.owned.json').contribution.impl.prepare([member('tsconfig.owned.json')], prepareInput);
    const first = plan.createPlugin({ include: plan.claims, exclude: [] });
    const second = plan.createPlugin({ include: plan.claims, exclude: [] });
    expect(first).not.toBe(second);
  });

  it('case 18 - the built plugin bundle carries NO runtime @taujs/server import (raw wrappers stay portable)', async () => {
    const { readFile } = await import('node:fs/promises');
    const dist = fileURLToPath(new URL('../../dist/plugin.js', import.meta.url));
    const code = await readFile(dist, 'utf8').catch(() => {
      throw new Error(`dist/plugin.js missing at ${dist} - run \`pnpm build\` first (CI builds before tests)`);
    });
    expect(code).not.toMatch(/from ['"]@taujs\/server/);
    expect(code).not.toMatch(/require\(['"]@taujs\/server/);
    expect(code).toMatch(/@vitejs\/plugin-react/); // the raw wrapper's real, portable dependency
  });
});
