import { RENDERTYPE } from '../constants';
import { now } from '../telemetry/Telemetry';

import type { RouteParams, Route, CoreAppConfig, CoreSecurityConfig, CoreTaujsConfig } from './types';

/** RFC 0007 (R1 rule 1): route-local identifiers - configuration, never user data. */
const DEFERRED_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

const isPlainRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export type ExtractSecurityResult<S extends CoreSecurityConfig = CoreSecurityConfig> = {
  security: S;
  durationMs: number;
  hasExplicitCSP: boolean;
  summary: {
    mode: 'explicit' | 'dev-defaults';
    defaultMode: 'merge' | 'replace';
    hasReporting: boolean;
    reportOnly: boolean;
  };
};

export type ExtractRoutesResult = {
  routes: Route<RouteParams>[];
  apps: { appId: string; routeCount: number }[];
  totalRoutes: number;
  durationMs: number;
};

export const extractBuildConfigs = <A extends CoreAppConfig = CoreAppConfig>(config: { apps: readonly A[] }): A[] => {
  // Renderer v1: `renderer` is picked alongside {appId, entryPoint, plugins} so the app's contribution
  // survives into the build carriage (it is dropped if omitted from this projection).
  return config.apps.map(({ appId, entryPoint, plugins, renderer }) => ({ appId, entryPoint, plugins, renderer })) as A[];
};

/**
 * RFC 0012: the canonical form for the two installation-level path coordinates. Either `''`
 * (root) or slash-led segments of unreserved characters with no trailing slash. Deliberately
 * conservative: no percent-encoding, no sub-delimiters, no dot segments - widen only on a
 * demonstrated topology. The charset also keeps the value inert inside the single-quoted
 * beacon script string and double-quoted HTML attributes, so composition sites need no
 * per-site escaping argument.
 */
const CANONICAL_PATH_COORDINATE = /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/;

export type PathCoordinates = {
  mountPrefix: string;
  publicBasePath: string;
};

const assertCanonicalCoordinate = (field: 'mountPrefix' | 'publicBasePath', value: string): void => {
  if (value === '') return;
  if (value === '/') throw new Error(`server.${field}: '/' is not a value - the root form is spelled '' (or omit the field)`);
  if (DOT_SEGMENT.test(value) || !CANONICAL_PATH_COORDINATE.test(value)) {
    throw new Error(
      `server.${field}: '${value}' is not canonical. Expected '' or '/segment(/segment)*' - leading '/', no trailing '/', ` +
        `segments of [A-Za-z0-9._~-] only, no '.' or '..' segments, no query, fragment, scheme or host. Values are rejected, never normalised.`,
    );
  }
};

/**
 * RFC 0013: validate and resolve the development HMR transport.
 *
 * In DEVELOPMENT, `'attached'` requires τjs to own the Fastify host: on a caller-supplied host it
 * is REJECTED here, at configuration time, before Vite installs an upgrade listener or τjs
 * touches the caller's root - silently ignoring an explicit transport request would be less
 * honest than refusing an unsupported combination.
 *
 * In PRODUCTION the combination is accepted and inert, because no HMR facility is installed
 * there; a Mode-B production deployment sharing one configuration file must still boot.
 *
 * Unknown values are rejected in EVERY mode rather than falling back, so a typo cannot silently
 * keep the fixed-port transport.
 */
export const resolveHmrTransport = (config: Pick<CoreTaujsConfig, 'server'>, callerOwnedHost: boolean, development: boolean): 'fixed-port' | 'attached' => {
  const declared = config.server?.hmrTransport;
  if (declared === undefined) return 'fixed-port';

  if (declared !== 'fixed-port' && declared !== 'attached') {
    throw new Error(`server.hmrTransport: '${String(declared)}' is not a valid transport. Expected 'fixed-port' (default) or 'attached'.`);
  }

  // Development-only. The transport configures a development facility that production never
  // installs, so a Mode-B PRODUCTION deployment sharing one configuration must still boot -
  // rejecting it there would contradict the inert-in-production contract. Unknown values are
  // still rejected above, in every mode, because a typo is a mistake anywhere.
  if (declared === 'attached' && callerOwnedHost && development) {
    throw new Error(
      `server.hmrTransport: 'attached' requires a τjs-created Fastify host, but one was supplied to createServer. ` +
        `The attached transport rides the application's own server, and τjs does not attach to or reorder listeners on a host it does not own. ` +
        `Omit the 'fastify' option to let τjs create the host, or use the default 'fixed-port' transport.`,
    );
  }

  return declared;
};

/**
 * RFC 0012: validate and resolve the installation-level addressing coordinates. `mountPrefix`
 * is where Fastify receives the installation; `publicBasePath` is what τjs emits and what the
 * Vite `base` derives from. `publicBasePath` defaults to `mountPrefix`; the inverse corner
 * (explicit `''` with a non-empty mount) is rejected as unsupported pending a real topology
 * (RFC 0012 §2 rule 1). Called by BOTH `createServer` and `taujsBuild`, so dev and build
 * cannot disagree about validity.
 */
export const extractPathCoordinates = (config: Pick<CoreTaujsConfig, 'server'>): PathCoordinates => {
  const declaredMount = config.server?.mountPrefix;
  const declaredPublic = config.server?.publicBasePath;

  if (declaredMount !== undefined && typeof declaredMount !== 'string') throw new Error('server.mountPrefix must be a string');
  if (declaredPublic !== undefined && typeof declaredPublic !== 'string') throw new Error('server.publicBasePath must be a string');

  const mountPrefix = declaredMount ?? '';
  assertCanonicalCoordinate('mountPrefix', mountPrefix);

  if (declaredPublic === '' && mountPrefix !== '') {
    throw new Error(
      `server.publicBasePath: '' alongside mountPrefix '${mountPrefix}' (emit root-absolute while mounted) is unsupported pending a real topology (RFC 0012). ` +
        `Omit publicBasePath to inherit the mountPrefix.`,
    );
  }

  const publicBasePath = declaredPublic ?? mountPrefix;
  assertCanonicalCoordinate('publicBasePath', publicBasePath);

  return { mountPrefix, publicBasePath };
};

/**
 * RFC 0012 (verdict-round ruling): the per-app Vite `base`, composing the canonical
 * `publicBasePath` AROUND the existing `entryPoint` spelling. With `publicBasePath: ''` this
 * reproduces the pre-RFC formula byte-for-byte (`entryPoint ? '/entryPoint/' : '/'`), so
 * root-mounted output is unchanged by construction. `entryPoint` is deliberately NOT
 * normalised here - existing non-canonical spellings are preserved for compatibility, without
 * endorsement (RFC 0012 §2 intent statement).
 */
export const viteBaseFor = (publicBasePath: string, entryPoint: string): string => (entryPoint ? `${publicBasePath}/${entryPoint}/` : `${publicBasePath}/`);

// This is deliberately a migration lint, not a second route parser. Fastify remains the only
// authority for valid route syntax. These are stale path-to-regexp forms that Fastify may accept
// as literals (or with materially different semantics), allowing a formerly live route to die
// silently after the native-route migration.
const assertNoLegacyRouteSyntax = (path: string, appId: string): void => {
  // Fastify regexp constraints may legitimately contain quantifiers such as `(^\\d{4})`.
  // Only braces outside a regexp constraint are path-to-regexp optional-group syntax.
  let regexpDepth = 0;
  let hasOptionalGroup = false;
  for (let i = 0; i < path.length; i += 1) {
    const char = path[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '(') {
      regexpDepth += 1;
      continue;
    }
    if (char === ')') {
      regexpDepth = Math.max(0, regexpDepth - 1);
      continue;
    }
    if (regexpDepth === 0 && (char === '{' || char === '}')) {
      hasOptionalGroup = true;
      break;
    }
  }

  const hasNamedWildcard = /(^|\/)\*[A-Za-z0-9_]/.test(path);
  const hasLegacyParameterModifier = /:[A-Za-z0-9_]+[+*](?=\/|$)/.test(path);
  const hasNonTerminalOptionalParameter = /:[A-Za-z0-9_]+\?(?=\/)/.test(path);

  if (hasOptionalGroup || hasNamedWildcard || hasLegacyParameterModifier || hasNonTerminalOptionalParameter) {
    throw new Error(
      `Route "${path}" (app "${appId}") uses legacy path-to-regexp syntax. ` +
        'Route paths now use Fastify syntax; use a terminal "/*" wildcard, a terminal optional parameter, or declare explicit routes.',
    );
  }
};

export const extractRoutes = (taujsConfig: CoreTaujsConfig): ExtractRoutesResult => {
  const t0 = now();
  const allRoutes: Route<RouteParams>[] = [];
  const apps: { appId: string; routeCount: number }[] = [];
  const pathTracker = new Map<string, string[]>();

  for (const app of taujsConfig.apps) {
    const appRoutes = (app.routes ?? []).map((route) => {
      assertNoLegacyRouteSyntax(route.path, app.appId);

      // RFC 0004 (H1): validate `attr.head` at BOOT - misconfiguration fails fast, before any
      // request depends on it. `timeoutMs` must be POSITIVE FINITE (ruling 3: the head blocks
      // the shell, so there is deliberately no 0/Infinity wait-forever sentinel).
      const head = (route.attr as { head?: { data?: unknown; timeoutMs?: unknown; optional?: unknown } } | undefined)?.head;
      if (head !== undefined) {
        const at = `Route "${route.path}" (app "${app.appId}")`;
        if (typeof head.data !== 'function') throw new Error(`${at}: attr.head.data must be a function (a data handler or serviceData(...) sugar)`);
        if (head.timeoutMs !== undefined && !(typeof head.timeoutMs === 'number' && Number.isFinite(head.timeoutMs) && head.timeoutMs > 0)) {
          throw new Error(`${at}: attr.head.timeoutMs must be a positive finite number of milliseconds (received ${String(head.timeoutMs)})`);
        }
        if (head.optional !== undefined && typeof head.optional !== 'boolean') {
          throw new Error(`${at}: attr.head.optional must be a boolean (received ${String(head.optional)})`);
        }
      }

      // RFC 0007 (R1, authoring-contract rules 3 + 4): validate `attr.deferred` at BOOT, beside the
      // head checks. Malformed input is a hard error, never a warning - a declaration the host
      // cannot start is a configuration defect, and every rule here is decidable statically.
      const attr = route.attr as { render?: unknown; deferred?: unknown } | undefined;
      if (attr?.deferred !== undefined) {
        const at = `Route "${route.path}" (app "${app.appId}")`;
        if (attr.render !== RENDERTYPE.streaming) {
          throw new Error(`${at}: attr.deferred is only valid on a "${RENDERTYPE.streaming}" route; data a non-streamed response needs belongs in attr.data`);
        }
        if (!isPlainRecord(attr.deferred)) throw new Error(`${at}: attr.deferred must be a plain object of named data handlers`);
        // OWN enumerable keys only - an inherited property is never trusted (rule 1). The
        // plain-object check above already rejects a foreign prototype.
        for (const key of Object.keys(attr.deferred)) {
          if (!DEFERRED_KEY_PATTERN.test(key)) {
            throw new Error(`${at}: attr.deferred key "${key}" must match ${DEFERRED_KEY_PATTERN.source}`);
          }
          if (typeof (attr.deferred as Record<string, unknown>)[key] !== 'function') {
            throw new Error(`${at}: attr.deferred."${key}" must be a function (a data handler or serviceData(...) sugar)`);
          }
        }
      }

      const fullRoute: Route<RouteParams> = { ...route, appId: app.appId };

      if (!pathTracker.has(route.path)) pathTracker.set(route.path, []);
      pathTracker.get(route.path)!.push(app.appId);

      return fullRoute;
    });

    apps.push({ appId: app.appId, routeCount: appRoutes.length });
    allRoutes.push(...appRoutes);
  }

  for (const [path, appIds] of pathTracker.entries()) {
    if (appIds.length > 1) {
      throw new Error(`Route path "${path}" is declared more than once by: ${appIds.join(', ')}`);
    }
  }
  const durationMs = now() - t0;

  return {
    routes: allRoutes,
    apps,
    totalRoutes: allRoutes.length,
    durationMs,
  };
};

export const extractSecurity = <S extends CoreSecurityConfig = CoreSecurityConfig>(
  taujsConfig: CoreTaujsConfig & { security?: S },
): ExtractSecurityResult<S> => {
  const t0 = now();
  const user = (taujsConfig.security ?? {}) as S;
  const userCsp = user.csp;

  const hasExplicitCSP = !!userCsp;

  const normalisedCsp = userCsp
    ? {
        defaultMode: userCsp.defaultMode ?? 'merge',
        directives: userCsp.directives,
        generateCSP: userCsp.generateCSP,
        reporting: userCsp.reporting
          ? {
              endpoint: userCsp.reporting.endpoint,
              onViolation: userCsp.reporting.onViolation,
              reportOnly: userCsp.reporting.reportOnly ?? false,
            }
          : undefined,
      }
    : undefined;

  const security = { csp: normalisedCsp } as S;

  const summary = {
    mode: hasExplicitCSP ? ('explicit' as const) : ('dev-defaults' as const),
    defaultMode: normalisedCsp?.defaultMode ?? 'merge',
    hasReporting: !!normalisedCsp?.reporting?.endpoint,
    reportOnly: !!normalisedCsp?.reporting?.reportOnly,
  };

  const durationMs = now() - t0;

  return {
    security,
    durationMs,
    hasExplicitCSP,
    summary,
  };
};
