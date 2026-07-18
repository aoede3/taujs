import { describe, expect, it } from 'vitest';

import { assertRenderContract, declaredContractOf, isRendererContribution, readRenderFnContract } from '../RendererContract';

import type { RendererContributionShape } from '../RendererContract';

// The render-fn brand tag the framework packages stamp BY VALUE (Symbol.for keeps host + renderers in
// sync without a runtime import). This test reproduces it to forge branded/unbranded render functions.
const RENDER_CONTRACT_TAG = Symbol.for('taujs.render-contract/v1');
const brandFn = <F extends (...args: never[]) => unknown>(fn: F, key: string, contractVersion = 'v1'): F => {
  Object.defineProperty(fn, RENDER_CONTRACT_TAG, { value: { key, contractVersion }, enumerable: false });
  return fn;
};

const renderSSR = () => Promise.resolve({ headContent: '', appHtml: '' });
const renderStream = () => ({ abort() {}, done: Promise.resolve() });

const ctx = { phase: 'prod-boot' as const, appId: 'web', clientRoot: '/app/web' };
const reactDeclared = { key: 'react', contractVersion: 'v1' };

const brandedReactModule = () => ({
  renderSSR: brandFn(() => renderSSR(), 'react'),
  renderStream: brandFn(() => renderStream(), 'react'),
});

describe('readRenderFnContract', () => {
  it('reads the {key, contractVersion} a render function is branded with', () => {
    expect(readRenderFnContract(brandFn(() => renderSSR(), 'react'))).toEqual({ key: 'react', contractVersion: 'v1' });
  });

  it('returns undefined for an unbranded function or a non-function', () => {
    expect(readRenderFnContract(() => renderSSR())).toBeUndefined();
    expect(readRenderFnContract({})).toBeUndefined();
    expect(readRenderFnContract(undefined)).toBeUndefined();
  });
});

describe('assertRenderContract (generic host identity validation)', () => {
  it('accepts a module whose renderSSR/renderStream are branded and match the declaration', () => {
    expect(() => assertRenderContract(brandedReactModule(), reactDeclared, ctx)).not.toThrow();
  });

  it('rejects a non-object module', () => {
    expect(() => assertRenderContract(undefined, reactDeclared, ctx)).toThrow(/did not export an object/);
  });

  it('rejects a module missing renderSSR or renderStream', () => {
    expect(() => assertRenderContract({ renderSSR: brandFn(() => renderSSR(), 'react') }, reactDeclared, ctx)).toThrow(/must export renderSSR and renderStream/);
  });

  it('rejects an UNBRANDED module (the paired contract\'s runtime half is missing)', () => {
    expect(() => assertRenderContract({ renderSSR: () => renderSSR(), renderStream: () => renderStream() }, reactDeclared, ctx)).toThrow(
      /is not branded by createRenderer/,
    );
  });

  it('rejects a module whose two render functions carry DISAGREEING brands', () => {
    const mod = { renderSSR: brandFn(() => renderSSR(), 'react'), renderStream: brandFn(() => renderStream(), 'vue') };
    expect(() => assertRenderContract(mod, reactDeclared, ctx)).toThrow(/mismatched renderSSR\/renderStream brands/);
  });

  it('rejects a framework mismatch against the declared renderer (key mismatch)', () => {
    const vueMod = { renderSSR: brandFn(() => renderSSR(), 'vue'), renderStream: brandFn(() => renderStream(), 'vue') };
    expect(() => assertRenderContract(vueMod, reactDeclared, ctx)).toThrow(/is a "vue" renderer but the app declares renderer: reactRenderer\(\)/);
  });

  it('rejects a contract-version mismatch', () => {
    const mod = { renderSSR: brandFn(() => renderSSR(), 'react', 'v2'), renderStream: brandFn(() => renderStream(), 'react', 'v2') };
    expect(() => assertRenderContract(mod, reactDeclared, ctx)).toThrow(/was built against render contract "v2" but @taujs\/server expects "v1"/);
  });
});

describe('isRendererContribution + declaredContractOf', () => {
  const valid: RendererContributionShape = {
    brand: 'taujs.renderer-contribution/v1',
    key: 'react',
    contractVersion: 'v1',
    managedCompilation: true,
    expectsModule: true,
  };

  it('recognises a structurally valid renderer contribution', () => {
    expect(isRendererContribution(valid)).toBe(true);
  });

  it('rejects junk / wrong brand / missing fields', () => {
    expect(isRendererContribution(null)).toBe(false);
    expect(isRendererContribution({ brand: 'nope', key: 'react' })).toBe(false);
    expect(isRendererContribution({ ...valid, brand: 'taujs.managed-plugin-contribution/v1' })).toBe(false);
    expect(isRendererContribution({ ...valid, managedCompilation: undefined })).toBe(false);
  });

  it('derives the declared render contract from a contribution', () => {
    expect(declaredContractOf(valid)).toEqual({ key: 'react', contractVersion: 'v1' });
  });
});
