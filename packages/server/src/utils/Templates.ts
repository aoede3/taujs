import { SSRTAG } from '../constants';

import type { ViteDevServer } from 'vite';
import type { Manifest } from '../types';

// https://github.com/vitejs/vite/issues/16515
// https://github.com/hi-ogawa/vite-plugins/blob/main/packages/ssr-css/src/collect.ts
// cf. https://github.com/vitejs/vite/blob/d6bde8b03d433778aaed62afc2be0630c8131908/packages/vite/src/node/constants.ts#L49C23-L50

// Other discussion
// https://github.com/vitejs/vite/issues/2282
// https://github.com/vitejs/vite/pull/16018#issuecomment-2006385354

const CSS_LANGS_RE = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

export const collectStyle = async (server: ViteDevServer, entries: string[]) => {
  const urls = await collectStyleUrls(server, entries);
  const codes = await Promise.all(
    urls.map(async (url) => {
      const res = await server.transformRequest(url + '?direct');

      return [`/* [collectStyle] ${url} */`, res?.code];
    }),
  );

  return codes.flat().filter(Boolean).join('\n\n');
};

async function collectStyleUrls(server: ViteDevServer, entries: string[]): Promise<string[]> {
  const visited = new Set<string>();

  async function traverse(url: string) {
    const [, id] = await server.moduleGraph.resolveUrl(url);

    if (visited.has(id)) return;

    visited.add(id);
    const mod = server.moduleGraph.getModuleById(id);

    if (!mod) return;

    await Promise.all([...mod.importedModules].map((childMod) => traverse(childMod.url)));
  }

  // ensure vite's import analysis is ready _only_ for top entries to not go too aggresive
  await Promise.all(entries.map((e) => server.transformRequest(e)));

  // traverse
  await Promise.all(entries.map((url) => traverse(url)));

  // filter
  return [...visited].filter((url) => url.match(CSS_LANGS_RE));
}

// Follows Vite's BACKEND-INTEGRATION manifest traversal (walk the client manifest from the entry),
// NOT the ssr-vue playground's `ctx.modules` filtering - that needs render-used module reporting,
// which no taujs renderer can do yet. See docs/followups/render-used-modules-contract.md.
// https://vite.dev/guide/backend-integration.html
/**
 * RULED 2026-08-26 (preload policy): `<link rel="modulepreload">` for the RECURSIVE STATIC-IMPORT
 * CLOSURE of the app's client entry, taken from the client build's own `.vite/manifest.json`.
 *
 * `dynamicImports` are deliberately NOT followed. A dynamically imported route or component may
 * well have taken part in the server render - taujs simply cannot identify WHICH of them did, so
 * preloading them all would be guessing at the browser's expense. Render-used lazy modules need
 * every renderer to report the modules a render touched, which is a cross-renderer contract change
 * deferred to its own RFC.
 *
 * The entry's own file is excluded: it ships as the bootstrap `<script type="module">`, so
 * preloading it as well would request the same URL twice.
 *
 * Values in `manifest.json` are NOT base-prefixed (unlike an ssr-manifest, where Vite bakes `base`
 * into every value), which is why `basePath` is prepended here exactly as `getCssLinks` and the
 * bootstrap module do - including producing a ROOT-ABSOLUTE href at the default coordinate. That
 * single convention is the point: the previous implementation applied this same prepend to a
 * manifest that had already been prefixed.
 */
export const getStaticModulePreloadLinks = (manifest: Manifest, entryKey: string, basePath = ''): string => {
  const entry = manifest[entryKey];
  if (!entry) return '';

  const visited = new Set<string>();
  const files = new Set<string>();

  const walk = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);

    const chunk = manifest[key];
    if (!chunk) return;

    for (const importedKey of chunk.imports ?? []) {
      const imported = manifest[importedKey];
      if (imported?.file) files.add(imported.file);
      walk(importedKey);
    }
  };

  walk(entryKey);
  files.delete(entry.file);

  // ALWAYS `${basePath}/${file}`, never a bare `file`. With the default (empty) coordinate that
  // yields `/assets/x.js` - ROOT-ABSOLUTE, like the bootstrap tag and the stylesheets. A relative
  // href would resolve against the DOCUMENT: correct on `/`, and `/product/assets/x.js` on
  // `/product/42` - recreating the very 404 class this policy exists to remove.
  return [...files].map((file) => `<link rel="modulepreload" href="${escapeHtmlAttribute(`${basePath}/${file}`)}">`).join('\n');
};

/**
 * Every stylesheet the client build emitted for this app.
 *
 * RULED 2026-08-26, and deliberately NOT narrowed to the entry's static closure in the same unit
 * that narrowed the JavaScript. An SSR-rendered lazy component's CSS is not in that closure, so
 * narrowing now would leave it unstyled until hydration fetched it - a visual regression introduced
 * while fixing a preload defect. The honest statement of the current policy:
 *
 *   Until render-used module reporting exists across all renderers, taujs applies every stylesheet
 *   emitted for the current app. This favours SSR styling correctness over route-level CSS
 *   selectivity.
 *
 * The relation is a plain `stylesheet`. taujs has no separate CSS-preload policy here: HTML
 * processes multiple `rel` keywords as SEPARATE link relationships (`as` belongs to the `preload`
 * one), so combining `preload` and `stylesheet` does not create a special mode, and a stylesheet in
 * the head already initiates its own fetch.
 */
export const getCssLinks = (manifest: Manifest, basePath = ''): string => {
  const seen = new Set<string>();
  const styles = [];

  for (const key in manifest) {
    const entry = manifest[key];
    if (entry && entry.css) {
      for (const cssFile of entry.css) {
        if (!seen.has(cssFile)) {
          seen.add(cssFile);
          styles.push(`<link rel="stylesheet" href="${escapeHtmlAttribute(`${basePath}/${cssFile}`)}">`);
        }
      }
    }
  }

  return styles.join('\n');
};

// https://github.com/vitejs/vite/blob/b947fdcc9d0db51ee6ac64d9712e8f04077280a7/packages/vite/src/runtime/hmrHandler.ts#L36
// we're using our own collectStyle as per above commentary!
export const overrideCSSHMRConsoleError = () => {
  const originalConsoleError = console.error;

  console.error = function (message?, ...optionalParams) {
    if (typeof message === 'string' && message.includes('css hmr is not supported in runtime mode')) return;

    originalConsoleError.apply(console, [message, ...optionalParams]);
  };
};

export const ensureNonNull = <T>(value: T | null | undefined, errorMessage: string): T => {
  if (value === undefined || value === null) throw new Error(errorMessage);

  return value;
};

export const cleanTemplateWhitespace = (templateParts: { beforeHead: string; afterHead: string; beforeBody: string; afterBody: string }) => {
  const { beforeHead, afterHead, beforeBody, afterBody } = templateParts;

  const cleanBeforeHead = beforeHead.replace(/\s*$/, '');
  const cleanAfterHead = afterHead.replace(/^\s*/, '');
  const cleanBeforeBody = beforeBody.replace(/\s*$/, '');
  const cleanAfterBody = afterBody.replace(/^\s*/, '');

  return {
    beforeHead: cleanBeforeHead,
    afterHead: cleanAfterHead,
    beforeBody: cleanBeforeBody,
    afterBody: cleanAfterBody,
  };
};

export const processTemplate = (template: string) => {
  const [headSplit, bodySplit] = template.split(SSRTAG.ssrHead);
  if (typeof bodySplit === 'undefined') throw new Error(`Template is missing ${SSRTAG.ssrHead} marker.`);

  const [beforeBody, afterBody] = bodySplit.split(SSRTAG.ssrHtml);
  if (typeof beforeBody === 'undefined' || typeof afterBody === 'undefined') throw new Error(`Template is missing ${SSRTAG.ssrHtml} marker.`);

  return {
    beforeHead: headSplit,
    afterHead: '',
    beforeBody: beforeBody.replace(/\s*$/, ''),
    afterBody: afterBody.replace(/^\s*/, ''),
  };
};

export const rebuildTemplate = (parts: ReturnType<typeof processTemplate>, headContent: string, bodyContent: string) => {
  return `${parts.beforeHead}${headContent}${parts.afterHead}${parts.beforeBody}${bodyContent}${parts.afterBody}`;
};

export const addNonceToInlineScripts = (html: string, nonce?: string) => {
  if (!nonce) return html;

  return html.replace(/<script(?![^>]*\bnonce=)([^>]*)>/g, `<script nonce="${nonce}"$1>`);
};

export const stripDevClientAndStyles = (template: string) => {
  return template.replace(/<script type="module" src="\/@vite\/client"><\/script>/g, '').replace(/<style type="text\/css">[\s\S]*?<\/style>/g, '');
};

export const applyViteTransform = async (template: string, url: string, viteDevServer: ViteDevServer): Promise<string> => {
  return viteDevServer.transformIndexHtml(url, template);
};

/**
 * Attribute-escape a value for interpolation into a double-quoted HTML attribute (SEC2, R2-02).
 * Defence-in-depth for the config-controlled bootstrap-module `src` — the server is renderer-agnostic
 * and does NOT import the renderers' `escapeHtml`, so this is the server-local equivalent (same five
 * characters). Escapes `&` first; not idempotent.
 */
export const escapeHtmlAttribute = (value: unknown): string =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const injectBootstrapModule = (template: string, bootstrapModule?: string, nonce?: string) => {
  if (!bootstrapModule) return template;

  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  return template.replace('</body>', `<script${nonceAttr} type="module" src="${escapeHtmlAttribute(bootstrapModule)}" defer></script></body>`);
};

export const injectCssLink = (template: string, cssLink?: string) => {
  if (!cssLink) return template;

  return template.replace('</head>', `${cssLink}</head>`);
};

export const extractHeadInner = (html: string): string => {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);

  return (m?.[1] ?? '').trim();
};

// Dev-only introspection stamp (spec 03 §7, P0B-04): requestId + per-boot token plus the
// devtools hook that hydrateApp emits into and the beacon POST. Injected ONLY when the
// structural dev gate holds (callers check for the introspection decoration) — the Gate 0B
// prod test asserts its absence. Values are JSON-encoded; requestId is SAFE_REQUEST_ID-validated
// upstream and the token is base64url, so neither can break out of the script context.
// RFC 0012: `basePath` is the installation's validated emission coordinate; its canonical
// charset ([A-Za-z0-9._~-] segments) cannot break out of the single-quoted URL string.
export const buildTaujsDevStamp = (requestId: string, token: string, nonce?: string, basePath = ''): string => {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const script =
    `window.__TAUJS_REQUEST_ID__=${JSON.stringify(requestId)};window.__TAUJS_DEV_TOKEN__=${JSON.stringify(token)};` +
    '(function(){var t=window.__TAUJS_REQUEST_ID__,k=window.__TAUJS_DEV_TOKEN__;if(!t||!k)return;var t0=null,sent=false;' +
    'function send(ok,err){if(sent)return;sent=true;var b={requestId:t,ok:ok};if(t0!=null)b.ms=Math.round(performance.now()-t0);' +
    'if(err)b.error=String(err).slice(0,500);' +
    `try{fetch('${basePath}/__taujs/beacon',{method:'POST',headers:{'content-type':'application/json','x-taujs-token':k},body:JSON.stringify(b),keepalive:true}).catch(function(){})}catch(e){}}` +
    "window.__TAUJS_DEVTOOLS_HOOK__={emit:function(ev,p){if(ev==='hydration:start')t0=performance.now();" +
    "else if(ev==='hydration:success')send(true);else if(ev==='hydration:error')send(false,(p&&p.message)||p)}};})();";

  return `<script${nonceAttr}>${script}</script>`;
};
