// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  collectStyle,
  getStaticModulePreloadLinks,
  getCssLinks,
  overrideCSSHMRConsoleError,
  ensureNonNull,
  requireTemplate,
  cleanTemplateWhitespace,
  processTemplate,
  rebuildTemplate,
  addNonceToInlineScripts,
  injectCssLink,
  injectBootstrapModule,
  escapeHtmlAttribute,
  extractHeadInner,
  stripDevClient,
} from '../Templates';
import { SSRTAG } from '../../constants';
import { AppError } from '../../core/errors/AppError';

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

describe('getStaticModulePreloadLinks', () => {
  // The manifest shape mirrors Vite's .vite/manifest.json: keys are source module ids,
  // `imports` holds the STATIC-import edges (module ids), `dynamicImports` holds dynamic ones.
  const manifest = {
    'entry.tsx': { file: 'assets/entry.js', imports: ['a.ts', 'shared.ts'], dynamicImports: ['lazy.ts'] },
    'a.ts': { file: 'assets/a.js', imports: ['shared.ts'] },
    'shared.ts': { file: 'assets/shared.js' },
    'lazy.ts': { file: 'assets/lazy.js' },
  } as any;

  it('walks the recursive static-import closure, dedupes, and excludes the entry file itself', () => {
    const out = getStaticModulePreloadLinks(manifest, 'entry.tsx');

    expect(out).toContain(`<link rel="modulepreload" href="/assets/a.js">`);
    expect(out).toContain(`<link rel="modulepreload" href="/assets/shared.js">`);
    // shared.ts is reachable via both entry and a.ts - must appear once
    expect(out.match(/assets\/shared\.js/g)?.length).toBe(1);
    // the entry's own file ships as the bootstrap <script>, never as a preload
    expect(out).not.toContain('entry.js');
  });

  it('does not follow dynamicImports', () => {
    const out = getStaticModulePreloadLinks(manifest, 'entry.tsx');
    expect(out).not.toContain('lazy.js');
  });

  it('prepends basePath to every href', () => {
    const out = getStaticModulePreloadLinks(manifest, 'entry.tsx', '/app');
    expect(out).toContain(`<link rel="modulepreload" href="/app/assets/a.js">`);
    expect(out).toContain(`<link rel="modulepreload" href="/app/assets/shared.js">`);
  });

  it('returns an empty string when entryKey is not in the manifest', () => {
    expect(getStaticModulePreloadLinks(manifest, 'missing.tsx')).toBe('');
  });

  it('returns an empty string when the entry has no static imports', () => {
    expect(getStaticModulePreloadLinks(manifest, 'shared.ts')).toBe('');
  });
});

describe('getCssLinks', () => {
  it('returns deduped stylesheet links and honors basePath', () => {
    const manifest = {
      'entry.tsx': { css: ['x.css', 'y.css'] },
      'other.ts': { css: ['y.css', 'z.css'] },
      'no-css.ts': {},
    } as any;

    const tags = getCssLinks(manifest, '/base');
    // RULED 2026-08-26: a plain `stylesheet` relation - see Templates.ts getCssLinks doc comment
    // for why the old `rel="preload stylesheet" as="style"` form was redundant, not "preloaded".
    expect(tags).toContain(`<link rel="stylesheet" href="/base/x.css">`);
    expect(tags).toContain(`<link rel="stylesheet" href="/base/y.css">`);
    expect(tags).toContain(`<link rel="stylesheet" href="/base/z.css">`);
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

describe('requireTemplate', () => {
  it('returns the stored template when present', () => {
    const templates = new Map([['/app', '<html>ok</html>']]);

    expect(requireTemplate(templates, undefined, '/app')).toBe('<html>ok</html>');
  });

  it('throws an AppError with an undefined cause when nothing was retained', () => {
    const templates = new Map<string, string>();

    let caught: unknown;
    try {
      requireTemplate(templates, undefined, '/app');
    } catch (err) {
      caught = err;
    }

    expect(AppError.isAppError(caught)).toBe(true);
    expect((caught as Error).message).toBe('Template not found for clientRoot: /app');
    expect((caught as Error).cause).toBeUndefined();
  });

  it('throws an AppError with an undefined cause when a failures map is given but has no entry for this clientRoot', () => {
    const templates = new Map<string, string>();
    const failures = new Map<string, unknown>([['/other', new Error('unrelated')]]);

    let caught: unknown;
    try {
      requireTemplate(templates, failures, '/app');
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).cause).toBeUndefined();
  });

  it('carries the exact retained failure as .cause, not a flattened message', () => {
    const templates = new Map<string, string>();
    const retained = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: '/root/dist/client/appA/index.html' });
    const failures = new Map<string, unknown>([['/app', retained]]);

    let caught: unknown;
    try {
      requireTemplate(templates, failures, '/app');
    } catch (err) {
      caught = err;
    }

    expect(AppError.isAppError(caught)).toBe(true);
    expect((caught as Error).message).toBe('Template not found for clientRoot: /app');
    expect((caught as Error).cause).toBe(retained);
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

describe('extractHeadInner', () => {
  it('returns inner HTML of <head> trimmed', () => {
    const html = `<html>
      <head>
        <meta charset="utf-8">
        <title>  X  </title>
      </head>
      <body>Y</body>
    </html>`;

    const out = extractHeadInner(html);

    expect(out).toContain(`<meta charset="utf-8">`);
    expect(out).toContain(`<title>  X  </title>`);
    // should be trimmed overall
    expect(out.startsWith(' ')).toBe(false);
    expect(out.endsWith(' ')).toBe(false);
  });

  it('returns empty string when no <head> exists', () => {
    const html = `<html><body>No head</body></html>`;
    expect(extractHeadInner(html)).toBe('');
  });

  it('handles <head ...attrs> forms (case-insensitive)', () => {
    const html = `<HTML><HeAd data-x="1">\n  <title>A</title>\n</hEaD><body/></HTML>`;
    expect(extractHeadInner(html)).toBe(`<title>A</title>`);
  });
});

describe('collectStyle - handles missing transform results for css modules', () => {
  it('keeps header but drops undefined code when transformRequest returns null/undefined', async () => {
    type Mod = { url: string; importedModules: Set<Mod> };

    const onlyCss: Mod = { url: '/styles/a.css', importedModules: new Set() };
    const entry: Mod = { url: '/src/entry.tsx', importedModules: new Set([onlyCss]) };

    const resolveUrl = vi.fn(async (url: string) => [url, url]);
    const getModuleById = vi.fn((id: string) => {
      if (id === entry.url) return entry;
      if (id === onlyCss.url) return onlyCss;
      return undefined;
    });

    const transformRequest = vi.fn(async (id: string) => {
      if (id === '/src/entry.tsx') return { code: '/* warmup */' };
      if (id === '/styles/a.css?direct') return null as any; // simulate failure / no result
      return { code: '??' };
    });

    const server = {
      transformRequest,
      moduleGraph: { resolveUrl, getModuleById },
    } as any;

    const out = await collectStyle(server, ['/src/entry.tsx']);

    // header should exist
    expect(out).toContain('/* [collectStyle] /styles/a.css */');

    // but "code for ..." line should NOT exist since res?.code is undefined and filtered out
    expect(out).not.toContain('code for /styles/a.css');

    // still called as expected
    expect(transformRequest).toHaveBeenCalledWith('/src/entry.tsx');
    expect(transformRequest).toHaveBeenCalledWith('/styles/a.css?direct');
  });
});

describe('getStaticModulePreloadLinks - empty / no-op paths', () => {
  it('returns empty string for an empty manifest', () => {
    expect(getStaticModulePreloadLinks({} as any, 'entry.tsx')).toBe('');
  });
});

describe('getCssLinks - empty / no-op paths', () => {
  it('returns empty string when no entries have css', () => {
    const manifest = {
      'a.ts': {},
      'b.ts': { css: undefined },
      'c.ts': { css: null },
    } as any;

    expect(getCssLinks(manifest, '/base')).toBe('');
  });
});

describe('processTemplate - trims around body sections on success path', () => {
  it('trims trailing whitespace before body content and leading whitespace after', () => {
    // Put whitespace around the ssrHtml split area to hit the replace() trimming.
    const tpl = `<html><head>${SSRTAG.ssrHead}</head>` + `<body>   \n${SSRTAG.ssrHtml}\n   </body></html>`;

    const parts = processTemplate(tpl);

    // beforeBody is everything between ssrHead marker split and ssrHtml marker,
    // with trailing whitespace removed via .replace(/\s*$/, '')
    expect(parts.beforeBody.endsWith(' ')).toBe(false);
    expect(parts.beforeBody.endsWith('\n')).toBe(false);

    // afterBody starts after ssrHtml marker,
    // with leading whitespace removed via .replace(/^\s*/, '')
    expect(parts.afterBody.startsWith(' ')).toBe(false);
    expect(parts.afterBody.startsWith('\n')).toBe(false);

    // rebuilding should still work
    const rebuilt = rebuildTemplate(parts, '<meta name="x">', '<div>Y</div>');
    expect(rebuilt).toContain('<meta name="x">');
    expect(rebuilt).toContain('<div>Y</div>');
  });
});

describe('addNonceToInlineScripts - attribute-order edge cases', () => {
  it('does not add nonce if a nonce attribute exists later in the tag', () => {
    // nonce appears after another attribute: should NOT be modified
    const html = `<script type="module" nonce="keep">x</script>`;
    const out = addNonceToInlineScripts(html, 'abc123');
    expect(out).toBe(html);
  });

  it('adds nonce even when other attributes exist, preserving them', () => {
    const html = `<script data-x="1" type="module">x</script>`;
    const out = addNonceToInlineScripts(html, 'abc123');
    expect(out).toBe(`<script nonce="abc123" data-x="1" type="module">x</script>`);
  });
});

describe('stripDevClient', () => {
  it('removes the /@vite/client script tag', () => {
    const html = '<html><head><script type="module" src="/@vite/client"></script></head><body></body></html>';
    expect(stripDevClient(html)).toBe('<html><head></head><body></body></html>');
  });

  it('leaves an author style tag untouched', () => {
    const html = '<html><head><style type="text/css">.author{}</style></head><body></body></html>';
    expect(stripDevClient(html)).toBe(html);
  });
});

describe('injectCssLink', () => {
  it('returns original template when cssLink is missing', () => {
    const tpl = '<html><head></head><body></body></html>';
    expect(injectCssLink(tpl, undefined)).toBe(tpl);
  });

  it('injects cssLink before closing head tag', () => {
    const tpl = '<html><head></head><body></body></html>';
    const cssLink = '<link rel="stylesheet" href="/app.css">';
    expect(injectCssLink(tpl, cssLink)).toBe('<html><head><link rel="stylesheet" href="/app.css"></head><body></body></html>');
  });
});

describe('escapeHtmlAttribute (SEC2, R2-02)', () => {
  it('escapes the five HTML-sensitive characters (attribute-safe, both quote styles)', () => {
    expect(escapeHtmlAttribute('&')).toBe('&amp;');
    expect(escapeHtmlAttribute('<')).toBe('&lt;');
    expect(escapeHtmlAttribute('>')).toBe('&gt;');
    expect(escapeHtmlAttribute('"')).toBe('&quot;');
    expect(escapeHtmlAttribute("'")).toBe('&#39;');
  });

  it('escapes & first and coerces non-strings', () => {
    expect(escapeHtmlAttribute('a&b')).toBe('a&amp;b');
    expect(escapeHtmlAttribute(42 as unknown as string)).toBe('42');
  });

  it('leaves a clean module URL unchanged', () => {
    expect(escapeHtmlAttribute('/assets/entry-client.js')).toBe('/assets/entry-client.js');
  });
});

describe('injectBootstrapModule attribute escaping (SEC2, R2-02)', () => {
  it('leaves a clean module URL unchanged (no behaviour change for normal config)', () => {
    const tpl = '<html><body></body></html>';
    expect(injectBootstrapModule(tpl, '/assets/entry.js')).toBe('<html><body><script type="module" src="/assets/entry.js" defer></script></body></html>');
  });

  it('escapes an attribute-breakout module value (defence-in-depth)', () => {
    const tpl = '<html><body></body></html>';
    const out = injectBootstrapModule(tpl, '/x.js" onerror="alert(1)');
    expect(out).toContain('src="/x.js&quot; onerror=&quot;alert(1)"');
    expect(out).not.toContain('onerror="alert(1)"');
  });

  it('returns the template unchanged when no bootstrapModule is given', () => {
    const tpl = '<html><body></body></html>';
    expect(injectBootstrapModule(tpl, undefined)).toBe(tpl);
  });
});
