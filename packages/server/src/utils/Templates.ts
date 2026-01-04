import { SSRTAG } from '../constants';

import type { ViteDevServer } from 'vite';
import type { Manifest, SSRManifest } from '../types';

// https://github.com/vitejs/vite/issues/16515
// https://github.com/hi-ogawa/vite-plugins/blob/main/packages/ssr-css/src/collect.ts
// cf. https://github.com/vitejs/vite/blob/d6bde8b03d433778aaed62afc2be0630c8131908/packages/vite/src/node/constants.ts#L49C23-L50

// Other discussion
// https://github.com/vitejs/vite/issues/2282
// https://github.com/vitejs/vite/pull/16018#issuecomment-2006385354

const CSS_LANGS_RE = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

export async function collectStyle(server: ViteDevServer, entries: string[]) {
  const urls = await collectStyleUrls(server, entries);
  const codes = await Promise.all(
    urls.map(async (url) => {
      const res = await server.transformRequest(url + '?direct');

      return [`/* [collectStyle] ${url} */`, res?.code];
    }),
  );

  return codes.flat().filter(Boolean).join('\n\n');
}

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

// https://github.com/vitejs/vite-plugin-vue/blob/main/playground/ssr-vue/src/entry-server.js
export function renderPreloadLinks(ssrManifest: SSRManifest, basePath = ''): string {
  const seen = new Set<string>();
  let links = '';

  for (const moduleId in ssrManifest) {
    const files = ssrManifest[moduleId];

    if (files) {
      files.forEach((file) => {
        if (!seen.has(file)) {
          seen.add(file);
          links += renderPreloadLink(basePath ? `${basePath}/${file}` : `${file}`);
        }
      });
    }
  }

  return links;
}

export function renderPreloadLink(file: string): string {
  const fileType = file.match(/\.(js|css|woff2?|gif|jpe?g|png|svg)$/)?.[1];

  switch (fileType) {
    case 'js':
      return `<link rel="modulepreload" href="${file}">`;
    case 'css':
      return `<link rel="stylesheet" href="${file}">`;
    case 'woff':
    case 'woff2':
      return `<link rel="preload" href="${file}" as="font" type="font/${fileType}" crossorigin>`;
    case 'gif':
    case 'jpeg':
    case 'jpg':
    case 'png':
      return `<link rel="preload" href="${file}" as="image" type="image/${fileType}">`;
    case 'svg':
      return `<link rel="preload" href="${file}" as="image" type="image/svg+xml">`;
    default:
      return '';
  }
}

export function getCssLinks(manifest: Manifest, basePath = ''): string {
  const seen = new Set<string>();
  const styles = [];

  for (const key in manifest) {
    const entry = manifest[key];
    if (entry && entry.css) {
      for (const cssFile of entry.css) {
        if (!seen.has(cssFile)) {
          seen.add(cssFile);
          styles.push(`<link rel="preload stylesheet" as="style" type="text/css" href="${basePath}/${cssFile}">`);
        }
      }
    }
  }

  return styles.join('\n');
}

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

export function processTemplate(template: string) {
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
}

export const rebuildTemplate = (parts: ReturnType<typeof processTemplate>, headContent: string, bodyContent: string) => {
  return `${parts.beforeHead}${headContent}${parts.afterHead}${parts.beforeBody}${bodyContent}${parts.afterBody}`;
};

export const addNonceToInlineScripts = (html: string, nonce?: string) => {
  if (!nonce) return html;
  return html.replace(/<script(?![^>]*\bnonce=)([^>]*)>/g, `<script nonce="${nonce}"$1>`);
};
