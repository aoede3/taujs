// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  collectStyle,
  renderPreloadLinks,
  renderPreloadLink,
  getCssLinks,
  overrideCSSHMRConsoleError,
  ensureNonNull,
  cleanTemplateWhitespace,
  processTemplate,
  rebuildTemplate,
  addNonceToInlineScripts,
} from '../Templates';
import { SSRTAG } from '../../constants';

type Mod = { url: string; importedModules: Set<Mod> };
type FakeServer = {
  transformRequest: ReturnType<typeof vi.fn>;
  moduleGraph: {
    resolveUrl: ReturnType<typeof vi.fn>;
    getModuleById: ReturnType<typeof vi.fn>;
  };
};

describe('collectStyle / Vite module graph traversal', () => {
  let server: FakeServer;

  beforeEach(() => {
    // Build a small module graph:
    // entry.tsx -> a.css, comp.ts
    // comp.ts -> nested.scss, image.png (should be ignored)
    const aCss: Mod = { url: '/styles/a.css', importedModules: new Set() };
    const nestedScss: Mod = { url: '/styles/nested.scss', importedModules: new Set() };
    const imagePng: Mod = { url: '/images/logo.png', importedModules: new Set() };
    const compTs: Mod = { url: '/src/comp.ts', importedModules: new Set([nestedScss, imagePng]) };
    const entry: Mod = { url: '/src/entry.tsx', importedModules: new Set([aCss, compTs]) };

    // Resolve: always return [url, id] with id===url for simplicity
    const resolveUrl = vi.fn(async (url: string) => [url, url]);

    // getModuleById: return our graph nodes by id
    const modules = new Map<string, Mod>([
      [entry.url, entry],
      [aCss.url, aCss],
      [compTs.url, compTs],
      [nestedScss.url, nestedScss],
      [imagePng.url, imagePng],
    ]);

    const getModuleById = vi.fn((id: string) => modules.get(id));

    // transformRequest:
    // - called once for each top-level entry (no '?direct')
    // - called for each collected CSS url with '?direct'
    const transformRequest = vi.fn(async (id: string) => {
      if (id.endsWith('?direct')) {
        // simulate css transform
        return { code: `/* code for ${id.replace('?direct', '')} */` };
      }
      // warm-up (entries)
      return { code: `/* warmup ${id} */` };
    });

    server = {
      transformRequest,
      moduleGraph: { resolveUrl, getModuleById },
    };
  });

  it('collects CSS/SCSS modules only and returns concatenated code with headers', async () => {
    const css = await collectStyle(server as any, ['/src/entry.tsx']);
    // Expect “header” comment + transformed css code for both css and scss
    expect(css).toContain('/* [collectStyle] /styles/a.css */');
    expect(css).toContain('/* code for /styles/a.css */');
    expect(css).toContain('/* [collectStyle] /styles/nested.scss */');
    expect(css).toContain('/* code for /styles/nested.scss */');
    // png is not a CSS lang => must not appear
    expect(css).not.toContain('logo.png');

    // transformRequest called for the entry warm-up AND for each css file with ?direct
    expect(server.transformRequest).toHaveBeenCalledWith('/src/entry.tsx');
    expect(server.transformRequest).toHaveBeenCalledWith('/styles/a.css?direct');
    expect(server.transformRequest).toHaveBeenCalledWith('/styles/nested.scss?direct');
  });

  it('handles empty results gracefully', async () => {
    // No modules at all => no css
    (server.moduleGraph.getModuleById as any).mockReturnValue(undefined);
    const out = await collectStyle(server as any, ['/nope.ts']);
    expect(out).toBe('');
  });

  it('handles cyclic imports via visited guard (no infinite recursion, no duplicate css)', async () => {
    // Build a cycle: A ↔ B; A also imports a.css
    type Mod = { url: string; importedModules: Set<Mod> };
    const aCss: Mod = { url: '/styles/a.css', importedModules: new Set() };
    const A: Mod = { url: '/src/A.ts', importedModules: new Set() };
    const B: Mod = { url: '/src/B.ts', importedModules: new Set() };
    A.importedModules.add(B);
    A.importedModules.add(aCss);
    B.importedModules.add(A); // cycle back to A

    const resolveUrl = vi.fn(async (url: string) => [url, url]);
    const modules = new Map<string, Mod>([
      [A.url, A],
      [B.url, B],
      [aCss.url, aCss],
    ]);
    const getModuleById = vi.fn((id: string) => modules.get(id));

    const transformRequest = vi.fn(async (id: string) => {
      if (id.endsWith('?direct')) return { code: `/* code for ${id.replace('?direct', '')} */` };
      return { code: `/* warmup ${id} */` };
    });

    const server = {
      transformRequest,
      moduleGraph: { resolveUrl, getModuleById },
    } as any;

    const css = await collectStyle(server, ['/src/A.ts']);

    // We should only see the css once; cycle should not duplicate or infinite loop
    expect(css).toContain('/* [collectStyle] /styles/a.css */');
    expect(css.match(/\/\* \[collectStyle] \/styles\/a\.css \*\//g)?.length).toBe(1);

    // Warm-up for entry
    expect(transformRequest).toHaveBeenCalledWith('/src/A.ts');
    // Direct transform for the single css file
    expect(transformRequest).toHaveBeenCalledWith('/styles/a.css?direct');

    // Prove we resolved the cyclic node B and then returned early when it re-hit A
    expect(resolveUrl).toHaveBeenCalledWith('/src/A.ts');
    expect(resolveUrl).toHaveBeenCalledWith('/src/B.ts');
    // getModuleById should never spin forever
    expect(getModuleById.mock.calls.length).toBeLessThan(10);
  });
});

describe('renderPreloadLink', () => {
  it.each([
    { file: '/x/app.js', exp: `<link rel="modulepreload" href="/x/app.js">` },
    { file: '/x/app.css', exp: `<link rel="stylesheet" href="/x/app.css">` },
    { file: '/x/font.woff', exp: `<link rel="preload" href="/x/font.woff" as="font" type="font/woff" crossorigin>` },
    { file: '/x/font.woff2', exp: `<link rel="preload" href="/x/font.woff2" as="font" type="font/woff2" crossorigin>` },
    { file: '/x/a.gif', exp: `<link rel="preload" href="/x/a.gif" as="image" type="image/gif">` },
    { file: '/x/a.jpeg', exp: `<link rel="preload" href="/x/a.jpeg" as="image" type="image/jpeg">` },
    { file: '/x/a.jpg', exp: `<link rel="preload" href="/x/a.jpg" as="image" type="image/jpg">` },
    { file: '/x/a.png', exp: `<link rel="preload" href="/x/a.png" as="image" type="image/png">` },
    { file: '/x/a.svg', exp: `<link rel="preload" href="/x/a.svg" as="image" type="image/svg+xml">` },
    { file: '/x/unknown.bin', exp: `` },
  ])('maps $file -> expected tag', ({ file, exp }) => {
    expect(renderPreloadLink(file)).toBe(exp);
  });
});

describe('renderPreloadLinks', () => {
  it('dedupes files and adds basePath when provided', () => {
    const ssrManifest = {
      'mod:A': ['a.js', 'a.css', 'a.css'], // dup css
      'mod:B': ['b.js', 'a.css'], // shared css
    } as any;

    const noBase = renderPreloadLinks(ssrManifest);
    expect(noBase).toContain(`<link rel="modulepreload" href="a.js">`);
    expect(noBase).toContain(`<link rel="stylesheet" href="a.css">`);
    expect(noBase).toContain(`<link rel="modulepreload" href="b.js">`);
    // a.css only once
    expect(noBase.match(/a\.css/g)?.length).toBe(1);

    const withBase = renderPreloadLinks(ssrManifest, '/app');
    expect(withBase).toContain(`<link rel="modulepreload" href="/app/a.js">`);
    expect(withBase).toContain(`<link rel="stylesheet" href="/app/a.css">`);
  });
});

describe('getCssLinks', () => {
  it('returns deduped preload stylesheet links and honors basePath', () => {
    const manifest = {
      'entry.tsx': { css: ['x.css', 'y.css'] },
      'other.ts': { css: ['y.css', 'z.css'] },
      'no-css.ts': {},
    } as any;

    const tags = getCssLinks(manifest, '/base');
    expect(tags).toContain(`<link rel="preload stylesheet" as="style" type="text/css" href="/base/x.css">`);
    expect(tags).toContain(`<link rel="preload stylesheet" as="style" type="text/css" href="/base/y.css">`);
    expect(tags).toContain(`<link rel="preload stylesheet" as="style" type="text/css" href="/base/z.css">`);
    // dedup y.css
    expect(tags.match(/y\.css/g)?.length).toBe(1);
  });
});

describe('overrideCSSHMRConsoleError', () => {
  const original = console.error;
  const spy = vi.fn();

  beforeEach(() => {
    (console as any).error = spy;
  });

  afterEach(() => {
    (console as any).error = original;
    vi.clearAllMocks();
  });

  it('suppresses Vite runtime CSS HMR error message', () => {
    overrideCSSHMRConsoleError();
    console.error('css hmr is not supported in runtime mode');
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes through other errors to the original console.error', () => {
    overrideCSSHMRConsoleError();
    console.error('some other error', { x: 1 });
    expect(spy).toHaveBeenCalledWith('some other error', { x: 1 });
  });
});

describe('ensureNonNull', () => {
  it('returns value when not nullish', () => {
    expect(ensureNonNull(0, 'err')).toBe(0);
    expect(ensureNonNull(false, 'err')).toBe(false);
    expect(ensureNonNull('', 'err')).toBe('');
  });
  it('throws when value is nullish', () => {
    expect(() => ensureNonNull(null, 'nope')).toThrow('nope');
    expect(() => ensureNonNull(undefined, 'nope')).toThrow('nope');
  });
});

describe('cleanTemplateWhitespace', () => {
  it('trims end/start spaces on each part', () => {
    const parts = {
      beforeHead: 'X   \n',
      afterHead: '\n   Y',
      beforeBody: 'Z  ',
      afterBody: '   W',
    };
    const out = cleanTemplateWhitespace(parts);
    expect(out.beforeHead.endsWith(' ')).toBe(false);
    expect(out.afterHead.startsWith(' ')).toBe(false);
    expect(out.beforeBody.endsWith(' ')).toBe(false);
    expect(out.afterBody.startsWith(' ')).toBe(false);
  });
});

describe('processTemplate / rebuildTemplate', () => {
  it('splits by ssr markers and rebuilds correctly', () => {
    const tpl = `<html><head>${SSRTAG.ssrHead}</head><body>${SSRTAG.ssrHtml}</body></html>`;
    const parts = processTemplate(tpl);
    expect(parts.beforeHead).toContain('<html><head>');
    expect(parts.afterHead).toBe('');
    expect(parts.beforeBody).toBe('</head><body>');
    expect(parts.afterBody).toBe('</body></html>');

    const html = rebuildTemplate(parts, '<title>X</title>', '<div>Y</div>');
    expect(html).toContain('<title>X</title>');
    expect(html).toContain('<div>Y</div>');
  });

  it('throws when ssrHead is missing', () => {
    const bad = `<html><head></head><body>${SSRTAG.ssrHtml}</body></html>`;
    expect(() => processTemplate(bad)).toThrow(`Template is missing ${SSRTAG.ssrHead} marker.`);
  });

  it('throws when ssrHtml is missing', () => {
    const bad = `<html><head>${SSRTAG.ssrHead}</head><body></body></html>`;
    expect(() => processTemplate(bad)).toThrow(`Template is missing ${SSRTAG.ssrHtml} marker.`);
  });
});

describe('addNonceToInlineScripts', () => {
  it('adds nonce to inline scripts that lack it, preserves existing nonce/attrs', () => {
    const html = [
      `<script>var a=1;</script>`,
      `<script type="module">var b=2;</script>`,
      `<script nonce="keep" data-x>var c=3;</script>`,
      `<div>no change</div>`,
    ].join('\n');

    const out = addNonceToInlineScripts(html, 'abc123');

    // new nonce added
    expect(out).toContain(`<script nonce="abc123">var a=1;</script>`);
    expect(out).toContain(`<script nonce="abc123" type="module">var b=2;</script>`);

    // existing nonce untouched
    expect(out).toContain(`<script nonce="keep" data-x>var c=3;</script>`);

    // unrelated untouched
    expect(out).toContain(`<div>no change</div>`);
  });

  it('returns original html when nonce is falsy', () => {
    const html = `<script>ok</script>`;
    expect(addNonceToInlineScripts(html, '')).toBe(html);
    expect(addNonceToInlineScripts(html, undefined)).toBe(html);
  });
});
