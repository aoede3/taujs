// @vitest-environment node
import React from 'react';
import { describe, expect, it } from 'vitest';

import { createRenderer } from '../SSRRender.js';
import { reactRenderer } from '../renderer.js';

import type { RendererContributionShape } from '@taujs/server/renderer';

// The runtime half of the paired contract: createRenderer stamps a render-contract brand on BOTH render
// functions, the host reads it via Symbol.for('taujs.render-contract/v1'), and validates it against the
// app's reactRenderer() declaration. This proves the two halves agree cross-package.
const RENDER_CONTRACT_TAG = Symbol.for('taujs.render-contract/v1');
const readBrand = (fn: unknown) => (fn as Record<symbol, unknown>)[RENDER_CONTRACT_TAG];

const makeModule = () => createRenderer({ appComponent: () => <div />, headContent: () => '' });

describe('render-contract branding (runtime half of the paired contract)', () => {
  it('brands renderSSR + renderStream with the react key and contract version', () => {
    const { renderSSR, renderStream } = makeModule();
    expect(readBrand(renderSSR)).toEqual({ key: 'react', contractVersion: 'v1' });
    expect(readBrand(renderStream)).toEqual({ key: 'react', contractVersion: 'v1' });
  });

  it('the brand survives the scaffold destructure + re-export (function-level, not on the container)', () => {
    const mod = makeModule();
    const { renderSSR } = mod; // `export const { renderSSR, renderStream } = createRenderer(...)`
    const reexported = renderSSR;
    expect(readBrand(reexported)).toEqual({ key: 'react', contractVersion: 'v1' });
  });

  it("matches reactRenderer()'s declared contract (host validates one against the other)", () => {
    const contribution = reactRenderer({ project: './tsconfig.json' }) as unknown as RendererContributionShape;
    const brand = readBrand(makeModule().renderSSR) as { key: string; contractVersion: string };
    expect(brand.key).toBe(contribution.key);
    expect(brand.contractVersion).toBe(contribution.contractVersion);
    expect(contribution.expectsModule).toBe(true); // React ships a render module the host validates
  });

  it('the brand is non-enumerable (invisible to spreads/serialisation)', () => {
    const { renderSSR } = makeModule();
    expect(Object.getOwnPropertyDescriptor(renderSSR, RENDER_CONTRACT_TAG)?.enumerable).toBe(false);
  });
});
