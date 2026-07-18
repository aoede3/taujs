import { describe, expect, it } from 'vitest';

import { assertOneImplPerKey, effectiveScopeFor, groupByKey, isManagedContribution, MANAGED_CONTRIBUTION_BRAND, partitionAppPlugins } from '../ManagedPlugins';

import type { CompilerImpl, ManagedContributionShape, ManagedGroupMember, PreparedPlan } from '../ManagedPlugins';

const makeImpl = (key: string): CompilerImpl => ({
  key,
  prepare: async () => ({ key, claims: [], boundaries: [], createPlugin: () => undefined }),
});

const makeContribution = (key: string, impl: CompilerImpl, project = `./tsconfig.${key}.json`): ManagedContributionShape => ({
  brand: MANAGED_CONTRIBUTION_BRAND,
  key,
  impl,
  project,
  options: {},
});

const member = (contribution: ManagedContributionShape, appId = 'app', appRoot = `/repo/${appId}`): ManagedGroupMember => ({
  contribution,
  appId,
  appRoot,
});

const plan = (key: string, claims: PreparedPlan['claims']): PreparedPlan => ({
  key,
  claims,
  boundaries: [],
  createPlugin: () => undefined,
});

describe('isManagedContribution', () => {
  it('accepts a well-formed contribution', () => {
    expect(isManagedContribution(makeContribution('solid', makeImpl('solid')))).toBe(true);
  });

  it('rejects non-contributions', () => {
    expect(isManagedContribution(null)).toBe(false);
    expect(isManagedContribution(undefined)).toBe(false);
    expect(isManagedContribution({ name: 'vite:plugin' })).toBe(false);
    expect(isManagedContribution({ brand: 'wrong', key: 'solid', project: '.', impl: makeImpl('solid') })).toBe(false);
    // brand present but no callable prepare -> not a contribution
    expect(isManagedContribution({ brand: MANAGED_CONTRIBUTION_BRAND, key: 'solid', project: '.', impl: { key: 'solid' } })).toBe(false);
  });
});

describe('partitionAppPlugins', () => {
  it('separates raw plugins from DIRECT managed contributions, preserving raw order', () => {
    const managed = makeContribution('solid', makeImpl('solid'));
    const rawA = { name: 'a' };
    const rawB = { name: 'b' };
    const result = partitionAppPlugins('web', [rawA, managed, rawB]);
    expect(result.managed).toEqual([managed]);
    expect(result.raw).toEqual([rawA, rawB]);
  });

  it('treats a nested array with no managed contribution as an ordinary raw entry (a plugin pack)', () => {
    const pack = [{ name: 'react' }, { name: 'react-preamble' }];
    const result = partitionAppPlugins('web', [pack]);
    expect(result.managed).toEqual([]);
    expect(result.raw).toEqual([pack]);
  });

  it('HARD errors when a framework contribution is nested inside a plugins sub-array (checkpoint §2 correction 6, matrix case 15)', () => {
    const managed = makeContribution('solid', makeImpl('solid'));
    // Renderer v1: contributions belong on `renderer:`; a nested one in `plugins` is directed there.
    expect(() => partitionAppPlugins('web', [[managed]])).toThrow(/Declare the framework on the app's `renderer:` field/);
    expect(() => partitionAppPlugins('web', [[{ name: 'x' }, [managed]]])).toThrow(/renderer:/);
  });

  it('tolerates an absent plugins array', () => {
    expect(partitionAppPlugins('web', undefined)).toEqual({ raw: [], managed: [] });
  });
});

describe('groupByKey', () => {
  it('merges duplicate keys into one group and keeps distinct keys apart', () => {
    const solidImpl = makeImpl('solid');
    const groups = groupByKey([
      member(makeContribution('solid', solidImpl), 'a'),
      member(makeContribution('react', makeImpl('react')), 'b'),
      member(makeContribution('solid', solidImpl), 'c'),
    ]);
    expect([...groups.keys()].sort()).toEqual(['react', 'solid']);
    expect(groups.get('solid')).toHaveLength(2);
    expect(groups.get('react')).toHaveLength(1);
  });
});

describe('assertOneImplPerKey (safeguard 1: reference identity)', () => {
  it('returns the shared impl for a single-implementation group', () => {
    const impl = makeImpl('solid');
    expect(assertOneImplPerKey('solid', [member(makeContribution('solid', impl)), member(makeContribution('solid', impl))])).toBe(impl);
  });

  it('HARD errors when two distinct impls claim the same key (two installed copies/versions)', () => {
    expect(() => assertOneImplPerKey('solid', [member(makeContribution('solid', makeImpl('solid'))), member(makeContribution('solid', makeImpl('solid')))])).toThrow(
      /claimed by 2 different renderer implementations/,
    );
  });

  it('HARD errors when the contribution key and its impl key disagree', () => {
    const impl = makeImpl('react');
    expect(() => assertOneImplPerKey('solid', [member(makeContribution('solid', impl))])).toThrow(/does not match its implementation key/);
  });
});

describe('effectiveScopeFor (set algebra)', () => {
  it('include = own claims; exclude = union of every OTHER key claims only', () => {
    const plans = new Map<string, PreparedPlan>([
      ['solid', plan('solid', ['**/*.solid.tsx', /solid-lib/])],
      ['react', plan('react', ['**/*.react.tsx'])],
    ]);
    expect(effectiveScopeFor('solid', plans)).toEqual({ include: ['**/*.solid.tsx', /solid-lib/], exclude: ['**/*.react.tsx'] });
    expect(effectiveScopeFor('react', plans)).toEqual({ include: ['**/*.react.tsx'], exclude: ['**/*.solid.tsx', /solid-lib/] });
  });

  it('a single compiler excludes nothing', () => {
    const plans = new Map<string, PreparedPlan>([['solid', plan('solid', ['**/*.tsx'])]]);
    expect(effectiveScopeFor('solid', plans)).toEqual({ include: ['**/*.tsx'], exclude: [] });
  });

  it('throws for an unknown key', () => {
    expect(() => effectiveScopeFor('vue', new Map())).toThrow(/no prepared plan/);
  });
});
