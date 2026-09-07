import { describe, expect, it } from 'vitest';

import { htmlRenderer } from '../renderer';
import { createRenderer } from '../SSRRender';
// Test-only relative import of the server's own source, the same way the shared conformance vector
// is imported (packages/renderer-conformance/README.md) - the runtime `dist` stays server-free
// (see Isolation.test.ts).
import { assertRenderContract, declaredContractOf, isRendererContribution } from '../../../server/src/utils/RendererContract';

import type { RendererContributionShape } from '../../../server/src/utils/RendererContract';

describe('htmlRenderer()', () => {
  it('produces a structurally valid v2 contribution keyed "html", contract version "v1", unmanaged', () => {
    const contribution = htmlRenderer();

    expect(isRendererContribution(contribution)).toBe(true);

    const shape = contribution as unknown as { brand: string; key: string; contractVersion: string; managedCompilation: boolean };
    expect(shape.brand).toBe('taujs.renderer-contribution/v2');
    expect(shape.key).toBe('html');
    expect(shape.contractVersion).toBe('v1');
    expect(shape.managedCompilation).toBe(false);
  });

  it('supplies a FRESH empty plugin array on every loadEnvironmentPlugins call', async () => {
    const contribution = htmlRenderer() as unknown as { loadEnvironmentPlugins: (lifecycle: 'dev' | 'build') => Promise<unknown[]> };

    const a = await contribution.loadEnvironmentPlugins('dev');
    const b = await contribution.loadEnvironmentPlugins('build');

    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(a).not.toBe(b);
  });

  it('takes no parameters: an argument passed at runtime is ignored, not thrown on', () => {
    const withArg = (htmlRenderer as unknown as (opts?: unknown) => unknown)({ ignored: true });
    expect(isRendererContribution(withArg)).toBe(true);
  });
});

describe('createRenderer() render module identity', () => {
  it('brands renderSSR/renderStream so assertRenderContract accepts the module against the htmlRenderer() declaration', () => {
    const { renderSSR, renderStream } = createRenderer();
    const declared = declaredContractOf(htmlRenderer() as unknown as RendererContributionShape);

    expect(() =>
      assertRenderContract({ renderSSR, renderStream }, declared, { phase: 'prod-boot', appId: 'playground-html', clientRoot: '/fake/client-root' }),
    ).not.toThrow();
  });

  it('the brand survives the entry-server destructure + re-export idiom', () => {
    const created = createRenderer();
    const { renderSSR, renderStream } = created;
    const declared = declaredContractOf(htmlRenderer() as unknown as RendererContributionShape);

    expect(() =>
      assertRenderContract({ renderSSR, renderStream }, declared, { phase: 'dev', appId: 'playground-html', clientRoot: '/fake/client-root' }),
    ).not.toThrow();
  });
});
