import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../constants', () => ({
  CONTENT: { TAG: '[τjs]' },
}));

import { extractBuildConfigs, extractRoutes, extractSecurity } from '../Setup';
import { createLogger } from '../../../logging/Logger';

import type { CoreTaujsConfig, CoreSecurityConfig } from '../../config/types';
import type { DebugConfig, LogLevel } from '../../logging/types';
import type { Route } from '../../config/types';

function makeMemoryLogger(debug?: DebugConfig) {
  const records: Array<{ level: LogLevel; args: any[] }> = [];

  const push = (level: LogLevel) => (meta?: unknown, message?: string) => {
    const args = [] as any[];
    if (message != null) args.push(message);
    if (meta && typeof meta === 'object' && Object.keys(meta as object).length > 0) args.push(meta);
    records.push({ level, args });
  };

  const logger = createLogger({
    debug,
    minLevel: 'debug',
    custom: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
    includeContext: false,
  });

  const reset = () => (records.length = 0);
  const take = (level: LogLevel) => records.filter((r) => r.level === level).map((r) => r.args);
  const all = () => records;

  return { logger, reset, take, all };
}

describe('extractBuildConfigs', () => {
  it('maps minimal fields from apps', () => {
    const cfg = {
      apps: [
        { appId: 'a', entryPoint: '/a/entry.tsx', plugins: [{ name: 'x' }] as any },
        { appId: 'b', entryPoint: '/b/entry.tsx' },
      ],
    };
    const out = extractBuildConfigs(cfg);
    expect(out).toEqual([
      { appId: 'a', entryPoint: '/a/entry.tsx', plugins: [{ name: 'x' }] },
      { appId: 'b', entryPoint: '/b/entry.tsx', plugins: undefined },
    ]);
  });
});

describe('extractRoutes', () => {
  it('aggregates, warns on duplicate paths, and sorts by specificity', () => {
    const tau: CoreTaujsConfig = {
      apps: [
        {
          appId: 'app1',
          entryPoint: '/e1',
          routes: [{ path: '/users/:id' }, { path: '/about/team' }],
        },
        {
          appId: 'app2',
          entryPoint: '/e2',
          routes: [{ path: '/about/team' }, { path: '/products/:sku/spec' }],
        },
      ],
    };

    const { routes, apps, totalRoutes, warnings, durationMs } = extractRoutes(tau);

    const hasAppId = (r: Route): r is Route & { appId: string } => typeof (r as any).appId === 'string';
    expect(routes.every(hasAppId)).toBe(true);

    expect((routes[0] as any).path).toBe('/products/:sku/spec');

    expect(apps).toEqual([
      { appId: 'app1', routeCount: 2 },
      { appId: 'app2', routeCount: 2 },
    ]);
    expect(totalRoutes).toBe(4);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Route path "/about/team" is declared in multiple apps: app1, app2');

    expect(typeof durationMs).toBe('number');
  });

  it('handles apps with no routes property (routes ?? [])', () => {
    const tau: CoreTaujsConfig = {
      apps: [
        { appId: 'a', entryPoint: '/e1' },
        { appId: 'b', entryPoint: '/e2', routes: undefined as any },
        { appId: 'c', entryPoint: '/e3', routes: [{ path: '/only' }] },
      ],
    };

    const { routes, apps, totalRoutes, warnings } = extractRoutes(tau);

    expect(totalRoutes).toBe(1);
    expect(routes.map((r) => r.path)).toEqual(['/only']);
    expect(apps).toEqual([
      { appId: 'a', routeCount: 0 },
      { appId: 'b', routeCount: 0 },
      { appId: 'c', routeCount: 1 },
    ]);
    expect(warnings).toEqual([]);
  });
});

describe('extractSecurity', () => {
  it('returns defaults when no explicit security provided', () => {
    const tau: CoreTaujsConfig = {
      apps: [{ appId: 'app', entryPoint: '/e' }],
    };

    const out = extractSecurity(tau);
    expect(out.hasExplicitCSP).toBe(false);
    expect(out.security.csp).toBeUndefined();
    expect(out.summary.defaultMode).toBe('merge');
    expect(out.summary.hasReporting).toBe(false);
    expect(out.summary.reportOnly).toBe(false);
    expect(typeof out.durationMs).toBe('number');
  });

  it('normalises explicit CSP with reporting and custom callbacks', () => {
    const onViolation = vi.fn();
    const generateCSP = vi.fn().mockReturnValue("default-src 'self'");
    const tau: CoreTaujsConfig = {
      apps: [{ appId: 'app', entryPoint: '/e' }],
      security: {
        csp: {
          defaultMode: 'replace',
          directives: { 'default-src': ["'self'"] } as any,
          generateCSP,
          reporting: {
            endpoint: '/csp-report',
            onViolation,
            reportOnly: true,
          },
        },
      },
    };

    const out = extractSecurity(tau);
    expect(out.hasExplicitCSP).toBe(true);
    expect(out.security.csp?.defaultMode).toBe('replace');
    expect(out.security.csp?.reporting?.endpoint).toBe('/csp-report');
    expect(out.security.csp?.reporting?.onViolation).toBe(onViolation);
    expect(out.security.csp?.reporting?.reportOnly).toBe(true);
    expect(out.summary.defaultMode).toBe('replace');
    expect(out.summary.hasReporting).toBe(true);
    expect(out.summary.reportOnly).toBe(true);
  });

  it('defaults csp.defaultMode to "merge" and reporting.reportOnly to false when omitted', () => {
    const tau: CoreTaujsConfig = {
      apps: [{ appId: 'app', entryPoint: '/e' }],
      security: {
        csp: {
          directives: {} as any,
          reporting: {
            endpoint: '/csp-report',
          },
        },
      },
    };

    const out = extractSecurity(tau);

    expect(out.hasExplicitCSP).toBe(true);

    expect(out.security.csp?.defaultMode).toBe('merge');
    expect(out.security.csp?.reporting?.endpoint).toBe('/csp-report');
    expect(out.security.csp?.reporting?.reportOnly).toBe(false);

    expect(out.summary.defaultMode).toBe('merge');
    expect(out.summary.hasReporting).toBe(true);
    expect(out.summary.reportOnly).toBe(false);
  });

  it('normalises explicit CSP with no reporting (reporting becomes undefined)', () => {
    const tau: CoreTaujsConfig = {
      apps: [{ appId: 'app', entryPoint: '/e' }],
      security: {
        csp: {
          defaultMode: undefined,
          directives: { 'default-src': ["'self'"] } as any,
        },
      },
    };

    const out = extractSecurity(tau);

    expect(out.hasExplicitCSP).toBe(true);
    expect(out.security.csp).toBeDefined();
    expect(out.security.csp?.reporting).toBeUndefined();

    expect(out.security.csp?.defaultMode).toBe('merge');
    expect(out.summary.defaultMode).toBe('merge');

    expect(out.summary.hasReporting).toBe(false);
    expect(out.summary.reportOnly).toBe(false);
  });
});
