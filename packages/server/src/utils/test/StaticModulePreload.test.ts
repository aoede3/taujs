// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { getStaticModulePreloadLinks } from '../Templates';

import type { Manifest } from '../../types';

/**
 * The preload policy ruled 2026-08-26: the recursive STATIC-import closure of the client entry,
 * from the CLIENT manifest, excluding the entry itself and never following `dynamicImports`.
 *
 * These cells pin the policy against hand-built manifests. The companion real-Vite suite
 * (`test/PreloadPolicyRealVite.test.ts`) pins that a manifest Vite actually emits has the shape
 * assumed here - which is the half the previous implementation got wrong, because its only unit
 * test used hand-built data whose convention did not match Vite's.
 */
const manifest: Manifest = {
  'entry-client.tsx': {
    file: 'assets/entry-aaa.js',
    imports: ['_shared-bbb.js'],
    dynamicImports: ['src/LazyRoute.tsx'],
    css: ['assets/entry-aaa.css'],
  },
  '_shared-bbb.js': { file: 'assets/shared-bbb.js', imports: ['_deep-ccc.js'] },
  '_deep-ccc.js': { file: 'assets/deep-ccc.js' },
  'src/LazyRoute.tsx': { file: 'assets/LazyRoute-ddd.js', css: ['assets/LazyRoute-ddd.css'] },
};

describe('getStaticModulePreloadLinks', () => {
  it('preloads the recursive static-import closure of the entry', () => {
    const links = getStaticModulePreloadLinks(manifest, 'entry-client.tsx', '/app');

    expect(links).toContain('<link rel="modulepreload" href="/app/assets/shared-bbb.js">');
    // Transitive: reached through the shared chunk, not directly from the entry.
    expect(links).toContain('<link rel="modulepreload" href="/app/assets/deep-ccc.js">');
  });

  it('does NOT preload the entry itself - it ships as the bootstrap script', () => {
    expect(getStaticModulePreloadLinks(manifest, 'entry-client.tsx', '/app')).not.toContain('entry-aaa.js');
  });

  it('does NOT follow dynamicImports', () => {
    // taujs cannot identify WHICH dynamically imported modules took part in this render, so it
    // preloads none of them. Deferred to a renderer-contract RFC, not an oversight.
    expect(getStaticModulePreloadLinks(manifest, 'entry-client.tsx', '/app')).not.toContain('LazyRoute');
  });

  it('emits no stylesheets - CSS is the separate, deliberately unnarrowed policy', () => {
    expect(getStaticModulePreloadLinks(manifest, 'entry-client.tsx', '/app')).not.toContain('.css');
  });

  it('de-duplicates a chunk reached by two different paths', () => {
    const diamond: Manifest = {
      'entry.tsx': { file: 'assets/entry.js', imports: ['_left.js', '_right.js'] },
      '_left.js': { file: 'assets/left.js', imports: ['_shared.js'] },
      '_right.js': { file: 'assets/right.js', imports: ['_shared.js'] },
      '_shared.js': { file: 'assets/shared.js' },
    };

    const occurrences = getStaticModulePreloadLinks(diamond, 'entry.tsx', '').split('assets/shared.js').length - 1;
    expect(occurrences).toBe(1);
  });

  it('terminates on a cyclic import graph', () => {
    const cyclic: Manifest = {
      'entry.tsx': { file: 'assets/entry.js', imports: ['_a.js'] },
      '_a.js': { file: 'assets/a.js', imports: ['_b.js'] },
      '_b.js': { file: 'assets/b.js', imports: ['_a.js'] },
    };

    const links = getStaticModulePreloadLinks(cyclic, 'entry.tsx', '');
    expect(links).toContain('assets/a.js');
    expect(links).toContain('assets/b.js');
  });

  it('is ROOT-ABSOLUTE at the default coordinate, and prefixed at a mounted one', () => {
    // A bare `assets/x.js` would resolve against the DOCUMENT: fine on `/`, and
    // `/product/assets/x.js` on `/product/42` - the same 404 class this policy removes.
    expect(getStaticModulePreloadLinks(manifest, 'entry-client.tsx', '')).toContain('href="/assets/shared-bbb.js"');
    expect(getStaticModulePreloadLinks(manifest, 'entry-client.tsx', '/base/app')).toContain('href="/base/app/assets/shared-bbb.js"');
  });

  it('every emitted href is root-absolute, whatever the coordinate', () => {
    for (const basePath of ['', '/pub', '/pub/admin']) {
      const hrefs = [...getStaticModulePreloadLinks(manifest, 'entry-client.tsx', basePath).matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) expect(href.startsWith('/')).toBe(true);
    }
  });

  it('escapes the href', () => {
    const hostile: Manifest = {
      'entry.tsx': { file: 'assets/entry.js', imports: ['weird'] },
      weird: { file: 'assets/a"><script>x</script>.js' },
    };

    const links = getStaticModulePreloadLinks(hostile, 'entry.tsx', '');
    expect(links).not.toContain('<script>');
    expect(links).toContain('&quot;');
  });

  it('returns nothing for an entry key that is not in the manifest', () => {
    expect(getStaticModulePreloadLinks(manifest, 'not-an-entry.tsx', '/app')).toBe('');
  });

  it('returns nothing when the entry has no static imports', () => {
    expect(getStaticModulePreloadLinks({ 'entry.tsx': { file: 'assets/entry.js' } }, 'entry.tsx', '/app')).toBe('');
  });
});
