import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scopedPluginSolid } from '@taujs/solid/plugin';
import { createFilter } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ManagedContributionShape } from '@taujs/server/config';

/**
 * ESC-1 classifier KILL TESTS (RFC 0006 checkpoint section 9; maintainer directive decisions.md
 * 2026-07-18). These exercise the vitefu-ONLY classifier against harder node_modules layouts to REVEAL
 * its honest support envelope. They are NOT licence to add resolver / module-graph / walker / cache /
 * package-manager-specific machinery - a layout vitefu cannot give exact provenance for is recorded as
 * a documented limitation (supported = exact vitefu provenance; the first case that would need bespoke
 * machinery fires the REVISE tripwire). The assertions below encode the OBSERVED envelope.
 */

const asShape = (contribution: unknown) => contribution as unknown as ManagedContributionShape;

const SOLID_EXPORTS = { '.': { solid: './src/index.jsx', default: './src/index.jsx' } };

let root: string;

const writePkg = (dir: string, name: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', ...extra }));
  writeFileSync(path.join(dir, 'src', 'index.jsx'), 'export default () => <div>x</div>;\n');
};

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'esc1-classifier-'));
  writeFileSync(path.join(root, 'tsconfig.solid.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'solid-js' }, include: ['src/**/*'] }));

  // root dependencies: a direct solid lib, a plain mid pkg (deps a hoisted solid lib), and a host pkg
  // (deps a nested-only solid lib).
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'classifier-root', private: true, dependencies: { 'direct-solid': '*', 'mid-pkg': '*', 'host-pkg': '*' } }),
  );
  const nm = path.join(root, 'node_modules');

  // (a) direct solid dependency, root-visible
  writePkg(path.join(nm, 'direct-solid'), 'direct-solid', { exports: SOLID_EXPORTS });

  // (b) transitive solid dependency HOISTED to the root (npm/pnpm-hoist style): mid-pkg depends on it,
  //     hoisted-solid sits at the root node_modules.
  writePkg(path.join(nm, 'mid-pkg'), 'mid-pkg', { dependencies: { 'hoisted-solid': '*' } });
  writePkg(path.join(nm, 'hoisted-solid'), 'hoisted-solid', { exports: SOLID_EXPORTS });

  // (c) NESTED-ONLY solid dependency (not hoisted): host-pkg carries it under its OWN node_modules,
  //     with no root-visible copy. This is the layout most likely to expose the root-resolution limit.
  writePkg(path.join(nm, 'host-pkg'), 'host-pkg', { dependencies: { 'nested-solid': '*' } });
  writePkg(path.join(nm, 'host-pkg', 'node_modules', 'nested-solid'), 'nested-solid', { exports: SOLID_EXPORTS });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function claims(): Promise<(id: string) => boolean> {
  const contribution = asShape(scopedPluginSolid({ project: 'tsconfig.solid.json' }));
  const plan = await contribution.impl.prepare([{ contribution, appId: 'app', appRoot: root }], { projectRoot: root, lifecycle: 'build' });
  return createFilter(plan.claims, plan.exclude);
}

describe('ESC-1 classifier support envelope (vitefu-only kill tests)', () => {
  const libFile = (pkg: string, ...nested: string[]) => path.join(root, 'node_modules', ...nested, pkg, 'src', 'index.jsx');

  it('SUPPORTED - a direct, root-visible solid dependency is claimed', async () => {
    const owns = await claims();
    expect(owns(libFile('direct-solid'))).toBe(true);
  });

  it('records the envelope - transitive-hoisted and nested-only are NOT claimed (documented limitation, not force-fixed)', async () => {
    const owns = await claims();

    // OBSERVED envelope with the vitefu-only primitives (crawlFrameworkPkgs + findDepPkgJsonPath). Only
    // DIRECT dependencies declaring a `solid` condition are classified; a transitive dependency (even
    // hoisted to the root) and a nested-only instance are NOT claimed. This is the honest support
    // boundary, recorded - NOT a defect to close with a resolver / module-graph / walker. If a required
    // layout lands here, it is a REVISE / supported-scope ruling, never bespoke provenance machinery.
    // If a future vitefu naturally widens this (false -> true), re-record the envelope; the test failing
    // is the signal to re-examine, not to hand-implement resolution.
    expect(owns(libFile('hoisted-solid'))).toBe(false); // transitive (hoisted) - UNSUPPORTED by the primitives
    expect(owns(libFile('nested-solid', 'host-pkg', 'node_modules'))).toBe(false); // nested-only - the root-resolution limit
  });
});
