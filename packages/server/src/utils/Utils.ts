import { dirname, join } from 'node:path';
import path from 'node:path'; /* separated import due to Istanbul coverage bug */
import { fileURLToPath } from 'node:url';

import { match } from 'path-to-regexp';

import type { MatchFunction } from 'path-to-regexp';
import type { ViteDevServer } from 'vite';
import type { Manifest, Route, RouteAttributes, RouteParams, ServiceMethod, ServiceRegistry, SSRManifest } from '../SSRServer';

export const isDevelopment = process.env.NODE_ENV === 'development';
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = join(dirname(__filename), !isDevelopment ? './' : '..');

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

// Internal `Command Descriptor with Dynamic Dispatch over a Service Registry`
// Resolves a command descriptor by dispatching it against the service registry
// Supports dynamic data fetching based on route-level declarations
export const callServiceMethod = async <S extends keyof ServiceRegistry, M extends keyof ServiceRegistry[S]>(
  registry: ServiceRegistry,
  serviceName: S,
  methodName: M,
  params: Parameters<ServiceRegistry[S][M]>[0],
): Promise<Awaited<ReturnType<ServiceRegistry[S][M]>>> => {
  const service = registry[serviceName];
  if (!service) throw new Error(`Service ${String(serviceName)} does not exist in the registry`);

  const method = service[methodName];

  if (typeof method !== 'function') throw new Error(`Service method ${String(methodName)} does not exist on ${String(serviceName)}`);

  const data = await method(params);

  if (typeof data !== 'object' || data === null)
    throw new Error(`Expected object response from ${String(serviceName)}.${String(methodName)}, but got ${typeof data}`);

  return data;
};

type ServiceDescriptor = {
  serviceName: string;
  serviceMethod: string;
  args?: Record<string, unknown>;
};

export const isServiceDescriptor = (obj: unknown): obj is ServiceDescriptor => {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;

  const maybe = obj as Record<string, unknown>;

  return typeof maybe.serviceName === 'string' && typeof maybe.serviceMethod === 'string';
};

export const fetchInitialData = async (
  attr: RouteAttributes<RouteParams> | undefined,
  params: Partial<Record<string, string | string[]>>,
  serviceRegistry: ServiceRegistry,
  ctx: { headers: Record<string, string>; [key: string]: unknown } = { headers: {} },
  callServiceMethodImpl: typeof callServiceMethod = callServiceMethod,
): Promise<Record<string, unknown>> => {
  if (!attr?.data || typeof attr.data !== 'function') return {};

  const result = await attr.data(params, ctx);

  if (isServiceDescriptor(result)) {
    const { serviceName, serviceMethod, args } = result;

    if (serviceRegistry[serviceName]?.[serviceMethod]) {
      return await callServiceMethodImpl(serviceRegistry, serviceName, serviceMethod, args ?? {});
    }

    throw new Error(`Invalid service: serviceName=${String(serviceName)}, method=${String(serviceMethod)}`);
  }

  if (typeof result === 'object' && result !== null) {
    return result as Record<string, unknown>;
  }

  throw new Error('Invalid result from attr.data');
};

export const matchRoute = <Params extends Partial<Record<string, string | string[]>>>(url: string, renderRoutes: Route<RouteParams>[]) => {
  for (const route of renderRoutes) {
    const matcher: MatchFunction<Params> = match(route.path, {
      decode: decodeURIComponent,
    });
    const matched = matcher(url);

    if (matched) return { route, params: matched.params };
  }

  return null;
};

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
