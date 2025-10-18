import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../constants', () => ({
  CONTENT: { TAG: '[τjs]' },
}));

import { extractBuildConfigs, extractRoutes, extractSecurity, printConfigSummary, printSecuritySummary, printContractReport } from '../Setup';
import { createLogger } from '../logging/Logger';

import type { TaujsConfig, SecurityConfig } from '../Config';
import type { DebugConfig, LogLevel } from '../logging/Logger';
import type { Route } from '../types';

function makeMemoryLogger(debug?: DebugConfig) {
  const records: Array<{ level: LogLevel; args: any[] }> = [];

  const logger = createLogger({
    debug,
    minLevel: 'debug',
    custom: {
      debug: (message, meta) => records.push({ level: 'debug', args: meta ? [message, meta] : [message] }),
      info: (message, meta) => records.push({ level: 'info', args: meta ? [message, meta] : [message] }),
      warn: (message, meta) => records.push({ level: 'warn', args: meta ? [message, meta] : [message] }),
      error: (message, meta) => records.push({ level: 'error', args: meta ? [message, meta] : [message] }),
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
    const tau: TaujsConfig = {
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
    const tau: TaujsConfig = {
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
    const tau: TaujsConfig = {
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
    const tau: TaujsConfig = {
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
    const tau: TaujsConfig = {
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
    const tau: TaujsConfig = {
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

describe('printConfigSummary', () => {
  const mem = makeMemoryLogger(['routes']);
  const { logger, take, reset } = mem;

  beforeEach(() => reset());

  it('logs counts, per-app debug lines, and warnings', () => {
    printConfigSummary(
      logger as any,
      [
        { appId: 'a', routeCount: 2 },
        { appId: 'b', routeCount: 0 },
      ],
      2,
      2,
      12.34,
      ['dup path here'],
    );

    const infoLines = take('info').map((args) => args.join(' '));
    expect(infoLines.some((l) => l.includes('[τjs] [config] Loaded 2 app(s), 2 route(s) in 12.3'))).toBe(true);

    const debugCalls = take('debug');
    expect(debugCalls.length).toBe(2);
    expect(debugCalls[0]?.[0]).toContain('• a: 2 route(s)');
    expect(debugCalls[1]?.[0]).toContain('• b: 0 route(s)');

    const warnLines = take('warn').map((args) => args.join(' '));
    expect(warnLines[0]).toContain('[τjs] [warn] dup path here');
  });
});

describe('printSecuritySummary', () => {
  const mem = makeMemoryLogger();
  const { logger, take, reset } = mem;

  const routes: Route[] = [
    { path: '/ok', attr: { render: 'ssr' } as any },
    { path: '/no-csp', attr: { render: 'ssr', middleware: { csp: false } } as any },
    { path: '/custom', attr: { render: 'ssr', middleware: { csp: { foo: 'bar' } as any } } as any },
  ];

  beforeEach(() => reset());

  it('logs configured summary when explicit CSP is provided', () => {
    const security: SecurityConfig = {
      csp: {
        defaultMode: 'merge',
        directives: {} as any,
        reporting: { endpoint: '/rep', reportOnly: false },
      },
    };

    printSecuritySummary(logger as any, routes as any, security, true, 5.6);

    const info = take('info')
      .map((a) => a.join(' '))
      .join('\n');
    expect(info).toContain('[τjs] [security] CSP configured (2/3 routes) in 5.6ms');

    expect(take('warn').length).toBe(0);
  });

  it('warns in production when CSP is implicit (no explicit config)', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const security: SecurityConfig = { csp: undefined };

      printSecuritySummary(logger as any, routes as any, security, false, 9.9);

      const info = take('info')
        .map((a) => a.join(' '))
        .join('\n');
      expect(info).toContain('[τjs] [security] CSP configured (2/3 routes) in 9.9ms');

      const warns = take('warn')
        .map((a) => a.join(' '))
        .join('\n');
      expect(warns).toContain('(consider explicit config for production)');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('printContractReport', () => {
  const mem = makeMemoryLogger(['routes']);
  const { logger, take, reset } = mem;

  beforeEach(() => reset());

  it('routes messages by status (error, warning, skipped->debug, else->info)', () => {
    const report = {
      items: [
        { key: 'policy', status: 'error', message: 'bad policy' },
        { key: 'hints', status: 'warning', message: 'something odd' },
        { key: 'routes', status: 'skipped', message: 'skipped check' },
        { key: 'ok', status: 'ok', message: 'all good' },
      ],
    } as any;

    printContractReport(logger as any, report);

    const errors = take('error')
      .map((a) => a.join(' '))
      .join('\n');
    const warns = take('warn')
      .map((a) => a.join(' '))
      .join('\n');
    const debugs = take('debug')
      .map((a) => a.join(' '))
      .join('\n');
    const infos = take('info')
      .map((a) => a.join(' '))
      .join('\n');

    expect(errors).toContain('[τjs] [security][policy] bad policy');
    expect(warns).toContain('[τjs] [security][hints] something odd');
    expect(debugs).toContain('[τjs] [security][routes] skipped check');
    expect(infos).toContain('[τjs] [security][ok] all good');
  });
});
