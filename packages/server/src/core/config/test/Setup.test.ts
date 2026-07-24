import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../constants', () => ({
  CONTENT: { TAG: '[τjs]' },
}));

import { extractBuildConfigs, extractRoutes, extractSecurity } from '../Setup';

import type { CoreTaujsConfig, Route } from '../../config/types';

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
  it('preserves declaration order and attaches app identity', () => {
    const tau: CoreTaujsConfig = {
      apps: [
        { appId: 'app1', entryPoint: '/e1', routes: [{ path: '/users/:id' }, { path: '/about/team' }] },
        { appId: 'app2', entryPoint: '/e2', routes: [{ path: '/products/:sku/spec' }] },
      ],
    };

    const { routes, apps, totalRoutes, warnings, durationMs } = extractRoutes(tau);

    expect(routes.map((route) => [route.path, route.appId])).toEqual([
      ['/users/:id', 'app1'],
      ['/about/team', 'app1'],
      ['/products/:sku/spec', 'app2'],
    ]);
    expect(apps).toEqual([
      { appId: 'app1', routeCount: 2 },
      { appId: 'app2', routeCount: 1 },
    ]);
    expect(totalRoutes).toBe(3);
    expect(warnings).toEqual([]);
    expect(typeof durationMs).toBe('number');
  });

  it('rejects an exact duplicate path before Fastify registration', () => {
    const tau: CoreTaujsConfig = {
      apps: [
        { appId: 'app1', entryPoint: '/e1', routes: [{ path: '/about' }] },
        { appId: 'app2', entryPoint: '/e2', routes: [{ path: '/about' }] },
      ],
    };

    expect(() => extractRoutes(tau)).toThrow('Route path "/about" is declared more than once by: app1, app2');
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

describe('extractRoutes attr.head validation (RFC 0004 H1)', () => {
  const withHead = (head: unknown) => ({ apps: [{ appId: 'shop', entryPoint: '', routes: [{ path: '/product/:id', attr: { render: 'ssr', head } }] }] }) as any;

  it('accepts a valid head declaration (and routes without head are untouched)', () => {
    expect(() => extractRoutes(withHead({ data: async () => ({}), timeoutMs: 3000, optional: true }))).not.toThrow();
    expect(() => extractRoutes(withHead(undefined))).not.toThrow();
  });

  it('rejects a non-function data', () => {
    expect(() => extractRoutes(withHead({ data: 42 }))).toThrow(/attr\.head\.data must be a function/);
  });

  it.each([[0], [-1], [Number.NaN], [Infinity], ['5000']])('rejects timeoutMs %s (positive finite only - RFC 0004 ruling 3)', (v) => {
    expect(() => extractRoutes(withHead({ data: async () => ({}), timeoutMs: v }))).toThrow(/attr\.head\.timeoutMs must be a positive finite number/);
  });

  it('rejects a non-boolean optional', () => {
    expect(() => extractRoutes(withHead({ data: async () => ({}), optional: 'yes' }))).toThrow(/attr\.head\.optional must be a boolean/);
  });

  it('names the offending route and app', () => {
    expect(() => extractRoutes(withHead({ data: 42 }))).toThrow(/Route "\/product\/:id" \(app "shop"\)/);
  });
});
