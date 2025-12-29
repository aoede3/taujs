/**
 * τjs Client Data Bridge
 *
 * Provides framework-agnostic primitives for accessing route data:
 * - SSR hydration (window.__INITIAL_DATA__)
 * - Client-side fetch (/__taujs/route endpoint)
 *
 * This is a transport layer only. For data orchestration (caching, refetch, etc.),
 * use TanStack Query or similar.
 */

export type RouteData = Record<string, unknown>;

/**
 * Error thrown when fetchRouteData receives a non-2xx response.
 * Contains structured error information from the server.
 */
export class RouteDataError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code?: string;
  readonly body?: unknown;

  constructor(
    message: string,
    opts: {
      status: number;
      statusText: string;
      code?: string;
      body?: unknown;
    },
  ) {
    super(message);
    this.name = 'RouteDataError';
    this.status = opts.status;
    this.statusText = opts.statusText;
    this.code = opts.code;
    this.body = opts.body;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, RouteDataError.prototype);
  }
}

const INITIAL_DATA_KEY = '__INITIAL_DATA__';

/**
 * Read SSR boot data from window.__INITIAL_DATA__ exactly once.
 * Subsequent calls return null (forces client-side fetch).
 *
 * Returns null on server (typeof window === 'undefined').
 */
export function readInitialDataOnce<T extends RouteData = RouteData>(): T | null {
  if (typeof window === 'undefined') return null;

  const w = window as any;
  const data = w[INITIAL_DATA_KEY] as T | undefined;

  if (!data) return null;

  // Delete so subsequent reads force a network fetch
  delete w[INITIAL_DATA_KEY];

  return data;
}

/**
 * Fetch route data from the τjs data endpoint.
 *
 * Calls: GET /__taujs/route?url=<pathname>
 * Returns: { data: T }
 *
 * Throws RouteDataError on non-2xx responses with structured error info.
 *
 * @example
 * const data = await fetchRouteData('/app/dashboard');
 *
 * @example
 * try {
 *   const data = await fetchRouteData('/app/dashboard');
 * } catch (err) {
 *   if (err instanceof RouteDataError && err.status === 404) {
 *     // Handle not found
 *   }
 * }
 */
export async function fetchRouteData<T extends RouteData = RouteData>(pathname: string, init?: RequestInit): Promise<T> {
  if (!pathname) {
    throw new Error('fetchRouteData: pathname is required');
  }

  const url = `/__taujs/route?url=${encodeURIComponent(pathname)}`;

  const res = await fetch(url, {
    credentials: 'include',
    ...init,
  });

  if (!res.ok) {
    let body: unknown;

    try {
      body = await res.json();
    } catch {
      // Fallback for non-JSON error responses
      const text = await res.text().catch(() => '');
      body = { error: text };
    }

    const json = body as { error?: string; statusText?: string; code?: string };
    throw new RouteDataError(json.error ?? `Request failed: ${res.status}`, {
      status: res.status,
      statusText: json.statusText ?? res.statusText,
      code: json.code,
      body,
    });
  }

  const body = (await res.json()) as { data: unknown };
  return (body.data ?? {}) as T;
}

/**
 * Get the current browser path (pathname + search).
 * Does not include hash.
 *
 * Returns null on server (typeof window === 'undefined').
 *
 * @example
 * const path = getCurrentPath(); // "/app/dashboard?tab=overview"
 */
export function getCurrentPath(): string | null {
  if (typeof window === 'undefined') return null;

  const { pathname, search } = window.location;
  return `${pathname}${search}`;
}
