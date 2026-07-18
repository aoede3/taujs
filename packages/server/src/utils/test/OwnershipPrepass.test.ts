// @vitest-environment node
// (OwnershipPrepass imports Vite's `createFilter`, which loads esbuild; esbuild's TextEncoder
// invariant breaks under the package-default jsdom environment - mirrors SSRServer.test.ts.)
import { describe, expect, it, vi } from 'vitest';

import { MANAGED_CONTRIBUTION_BRAND, UNSCOPED_COMPILER_TAG } from '../ManagedPlugins';
import { assembleManagedSources, createOwnershipDiagnostic, prepareOwnership } from '../OwnershipPrepass';

import type { CompilerImpl, ManagedContributionShape, PreparedPlan } from '../ManagedPlugins';
import type { PreparedOwnership } from '../OwnershipPrepass';

const makeImpl = (key: string, plan?: Partial<PreparedPlan>): CompilerImpl => ({
  key,
  prepare: vi.fn(async () => ({
    key,
    claims: plan?.claims ?? [],
    boundaries: plan?.boundaries ?? [],
    createPlugin: plan?.createPlugin ?? (() => ({ name: `${key}:compiler` })),
  })),
});

const contribution = (key: string, impl: CompilerImpl, project = `./tsconfig.${key}.json`): ManagedContributionShape => ({
  brand: MANAGED_CONTRIBUTION_BRAND,
  key,
  impl,
  project,
  options: {},
});

const app = (appId: string, plugins: unknown[] | undefined) => ({ appId, appRoot: `/repo/${appId}`, plugins });

const INPUT = { projectRoot: '/repo', lifecycle: 'dev' as const };

const taggedRawCompiler = (key: string, name: string) => {
  const plugin: Record<string | symbol, unknown> = { name };
  Object.defineProperty(plugin, Symbol.for(UNSCOPED_COMPILER_TAG), { value: key, enumerable: false });
  return plugin;
};

describe('prepareOwnership (phase 1)', () => {
  it('is a complete no-op when no app declares a managed contribution', async () => {
    const raw = [{ name: 'x' }];
    const prepared = await prepareOwnership([app('web', raw), app('admin', undefined)], INPUT);
    expect(prepared.active).toBe(false);
    expect(prepared.plans.size).toBe(0);
    expect(prepared.rawByApp.get('web')).toEqual(raw);
    expect(prepared.rawByApp.get('admin')).toEqual([]);
    expect(prepared.keysByApp.get('web')).toEqual([]);
  });

  it('extracts managed contributions, leaving only raw plugins per app', async () => {
    const solid = makeImpl('solid');
    const rawPlugin = { name: 'y' };
    const prepared = await prepareOwnership([app('admin', [rawPlugin, contribution('solid', solid)])], INPUT);
    expect(prepared.active).toBe(true);
    expect(prepared.rawByApp.get('admin')).toEqual([rawPlugin]);
    expect(prepared.keysByApp.get('admin')).toEqual(['solid']);
    expect(prepared.plans.has('solid')).toBe(true);
  });

  it('prepares each same-key group ONCE with the whole group (union across apps)', async () => {
    const solid = makeImpl('solid');
    await prepareOwnership([app('a', [contribution('solid', solid)]), app('b', [contribution('solid', solid)])], INPUT);
    expect(solid.prepare).toHaveBeenCalledTimes(1);
    const group = (solid.prepare as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(group).toHaveLength(2);
    expect(group.map((m: { appId: string }) => m.appId)).toEqual(['a', 'b']);
  });

  it('HARD errors on two distinct implementations claiming one key (safeguard 1)', async () => {
    await expect(prepareOwnership([app('a', [contribution('solid', makeImpl('solid'))]), app('b', [contribution('solid', makeImpl('solid'))])], INPUT)).rejects.toThrow(
      /claimed by 2 different renderer implementations/,
    );
  });

  it('HARD errors on a branded contribution nested inside a sub-array', async () => {
    await expect(prepareOwnership([app('a', [[contribution('solid', makeImpl('solid'))]])], INPUT)).rejects.toThrow(/must be a DIRECT entry/);
  });
});

const prepareSync = async (apps: Parameters<typeof prepareOwnership>[0]): Promise<PreparedOwnership> => prepareOwnership(apps, INPUT);

describe('assembleManagedSources (phase 2)', () => {
  it('returns no host sources when ownership is inactive', async () => {
    const prepared = await prepareSync([app('web', [{ name: 'x' }])]);
    const { hostSources } = assembleManagedSources({ prepared, keysToInstantiate: [], resolvedChain: [{ name: 'x' }], env: 'dev', warn: vi.fn() });
    expect(hostSources).toEqual([]);
  });

  it('prepends the diagnostic FIRST, then the managed compilers (constructed for keysToInstantiate only)', async () => {
    const prepared = await prepareSync([app('web', [contribution('react', makeImpl('react'))]), app('admin', [contribution('solid', makeImpl('solid'))])]);
    const { hostSources } = assembleManagedSources({ prepared, keysToInstantiate: ['react'], resolvedChain: [], env: 'build:web', warn: vi.fn() });
    expect(hostSources[0]!.source).toBe('taujs:ownership-diagnostic');
    expect(hostSources[1]!.source).toBe('taujs:managed-compilers');
    const diagnostic = (hostSources[0]!.plugins as { name: string }[])[0]!;
    expect(diagnostic.name).toBe('taujs:ownership-diagnostic');
    // build containment: only react instantiated even though solid is in the global plan
    expect(hostSources[1]!.plugins).toEqual([{ name: 'react:compiler' }]);
  });

  it('HARD errors on a tagged unscoped raw JSX compiler alongside managed ownership, directing to the scoped equivalent', async () => {
    const prepared = await prepareSync([app('admin', [contribution('solid', makeImpl('solid'))])]);
    expect(() =>
      assembleManagedSources({ prepared, keysToInstantiate: ['solid'], resolvedChain: [taggedRawCompiler('react', 'vite:react-babel')], env: 'dev', warn: vi.fn() }),
    ).toThrow(/scopedPluginReact\(\)/);
  });

  it('HARD errors on a raw plugin whose NAME collides with a managed compiler (secondary net)', async () => {
    const prepared = await prepareSync([app('web', [contribution('react', makeImpl('react', { createPlugin: () => ({ name: 'vite:react-babel' }) }))])]);
    expect(() =>
      assembleManagedSources({ prepared, keysToInstantiate: ['react'], resolvedChain: [{ name: 'vite:react-babel' }], env: 'dev', warn: vi.fn() }),
    ).toThrow(/collides with a managed compiler/);
  });
});

describe('createOwnershipDiagnostic (safeguard 2, fail-closed)', () => {
  const REACT = /\/react\/.*\.tsx$/;
  const SOLID = /\/solid\/.*\.tsx$/;
  const SHARED = /\/shared\/.*\.tsx$/;

  const plans = new Map<string, PreparedPlan>([
    ['react', { key: 'react', claims: [REACT], boundaries: [REACT], createPlugin: () => undefined }],
    ['solid', { key: 'solid', claims: [SOLID, SHARED], boundaries: [SOLID, SHARED], createPlugin: () => undefined }],
  ]);

  const drive = (plugin: ReturnType<typeof createOwnershipDiagnostic>, id: string, error = vi.fn()) => {
    const result = (plugin.transform as (this: unknown, code: string, id: string) => unknown).call({ error }, '', id);
    return { result, error };
  };

  it('hard-errors on a doubly-claimed file (excluded from both compilers)', () => {
    const bothPlans = new Map<string, PreparedPlan>([
      ['react', { key: 'react', claims: [SHARED], boundaries: [SHARED], createPlugin: () => undefined }],
      ['solid', { key: 'solid', claims: [SHARED], boundaries: [SHARED], createPlugin: () => undefined }],
    ]);
    const { error } = drive(createOwnershipDiagnostic(bothPlans, 'dev', vi.fn()), '/repo/shared/Widget.tsx');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatch(/claimed by more than one framework compiler/);
  });

  it('hard-errors on a zero-owner file inside a framework boundary', () => {
    // boundary includes it, but no claim does
    const gapPlans = new Map<string, PreparedPlan>([['solid', { key: 'solid', claims: [SOLID], boundaries: [SOLID, SHARED], createPlugin: () => undefined }]]);
    const { error } = drive(createOwnershipDiagnostic(gapPlans, 'dev', vi.fn()), '/repo/shared/Orphan.tsx');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatch(/compiled by NO compiler/);
  });

  it('subtracts the project exclude from ownership: a deliberately excluded file is neither owned nor flagged', () => {
    // solid claims all of /solid, but deliberately excludes /solid/legacy; the boundary covers /solid.
    const excludePlans = new Map<string, PreparedPlan>([
      ['solid', { key: 'solid', claims: [SOLID], boundaries: [SOLID], exclude: [/\/solid\/legacy\//], createPlugin: () => undefined }],
    ]);
    const diag = createOwnershipDiagnostic(excludePlans, 'dev', vi.fn());
    // an excluded file is OUTSIDE the boundary too -> ignored, not a zero-owner error
    expect(drive(diag, '/repo/solid/legacy/Old.tsx').error).not.toHaveBeenCalled();
    // a normal owned file is still fine
    expect(drive(diag, '/repo/solid/App.tsx').error).not.toHaveBeenCalled();
  });

  it('still flags a genuine gap (in the boundary, not excluded, unclaimed) after exclude subtraction', () => {
    const gapPlans = new Map<string, PreparedPlan>([
      // claims only /solid/src; boundary covers all of /solid; excludes /solid/legacy
      ['solid', { key: 'solid', claims: [/\/solid\/src\/.*\.tsx$/], boundaries: [SOLID], exclude: [/\/solid\/legacy\//], createPlugin: () => undefined }],
    ]);
    const diag = createOwnershipDiagnostic(gapPlans, 'dev', vi.fn());
    // deliberately excluded -> ignored
    expect(drive(diag, '/repo/solid/legacy/Old.tsx').error).not.toHaveBeenCalled();
    // in boundary, not excluded, unclaimed -> hard error
    const { error } = drive(diag, '/repo/solid/Orphan.tsx');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatch(/compiled by NO compiler/);
  });

  it('hard-errors on a cross-exclusion fallthrough - one project excludes a file another project claims (safeguard 2 completeness)', () => {
    // react claims all of /shared but EXCLUDES Widget.tsx; solid ALSO claims /shared. Widget is excluded
    // from react (own exclude) AND from solid (react's raw claim is solid's cross-key exclude), so NEITHER
    // compiler compiles it. Using only claims-minus-OWN-exclude, the raw owner (solid, 1) would falsely
    // read OK; the effective filter mirrors the real compilers and catches the fallthrough.
    const WIDGET = /\/shared\/Widget\.tsx$/;
    const crossPlans = new Map<string, PreparedPlan>([
      ['react', { key: 'react', claims: [SHARED], boundaries: [SHARED], exclude: [WIDGET], createPlugin: () => undefined }],
      ['solid', { key: 'solid', claims: [SHARED], boundaries: [SHARED], createPlugin: () => undefined }],
    ]);
    const { error } = drive(createOwnershipDiagnostic(crossPlans, 'dev', vi.fn()), '/repo/shared/Widget.tsx');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatch(/compiled by NO compiler/);
  });

  it('passes a singly-owned file and ignores files outside every boundary', () => {
    const diag = createOwnershipDiagnostic(plans, 'dev', vi.fn());
    expect(drive(diag, '/repo/react/App.tsx').error).not.toHaveBeenCalled();
    expect(drive(diag, '/repo/solid/App.tsx').error).not.toHaveBeenCalled();
    expect(drive(diag, '/repo/elsewhere/Thing.tsx').error).not.toHaveBeenCalled();
  });

  it('only inspects JSX/TSX ids and skips virtual/null-byte ids', () => {
    const diag = createOwnershipDiagnostic(plans, 'dev', vi.fn());
    expect(drive(diag, '/repo/shared/util.ts').error).not.toHaveBeenCalled();
    expect(drive(diag, '\0virtual:/repo/shared/Widget.tsx').error).not.toHaveBeenCalled();
  });

  it('strips a query suffix before matching', () => {
    const bothPlans = new Map<string, PreparedPlan>([
      ['react', { key: 'react', claims: [SHARED], boundaries: [SHARED], createPlugin: () => undefined }],
      ['solid', { key: 'solid', claims: [SHARED], boundaries: [SHARED], createPlugin: () => undefined }],
    ]);
    const { error } = drive(createOwnershipDiagnostic(bothPlans, 'dev', vi.fn()), '/repo/shared/Widget.tsx?v=123');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a repeated defect per environment (reports once)', () => {
    const bothPlans = new Map<string, PreparedPlan>([
      ['react', { key: 'react', claims: [SHARED], boundaries: [SHARED], createPlugin: () => undefined }],
      ['solid', { key: 'solid', claims: [SHARED], boundaries: [SHARED], createPlugin: () => undefined }],
    ]);
    const diag = createOwnershipDiagnostic(bothPlans, 'dev', vi.fn());
    const error = vi.fn();
    drive(diag, '/repo/shared/Widget.tsx', error);
    drive(diag, '/repo/shared/Widget.tsx', error);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
