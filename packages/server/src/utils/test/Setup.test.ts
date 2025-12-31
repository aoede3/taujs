import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../constants', () => ({
  CONTENT: { TAG: '[τjs]' },
}));

import { printConfigSummary, printSecuritySummary, printContractReport, printVitePluginSummary } from '../../Setup';
import { createLogger } from '../../logging/Logger';

import type { CoreTaujsConfig, CoreSecurityConfig } from '../../core/config/types';
import type { DebugConfig, LogLevel } from '../../logging/Logger';
import type { Route } from '../../core/config/types';

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
    const security: CoreSecurityConfig = {
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
      const security: CoreSecurityConfig = { csp: undefined };

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

describe('printVitePluginSummary', () => {
  const mem = makeMemoryLogger();
  const { logger, take, reset } = mem;

  beforeEach(() => reset());

  it('prints "no app plugins" and merged=[none] when arrays are effectively empty', () => {
    // merged includes junk that should be filtered out
    const merged = [
      {}, // no name
      { name: '' }, // empty string -> filtered out
      { name: undefined }, // filtered out
      { name: 123 }, // non-string -> filtered out
    ] as any;

    printVitePluginSummary(logger as any, [], merged);

    const infoCalls = take('info');
    expect(infoCalls).toHaveLength(1);

    const [msg] = infoCalls[0] as any[];
    expect(msg).toContain('[τjs] [vite] Plugins no app plugins merged=[none]');
  });

  it('prints per-app plugin lists and merged plugin names (filters invalid names)', () => {
    const appPlugins = [
      { appId: 'main', plugins: ['vite:vue', 'inspect'] },
      { appId: 'admin', plugins: [] }, // join => '' -> "none"
    ];

    const merged = [
      { name: 'vite:vue' },
      { name: '' }, // filtered
      { name: undefined }, // filtered
      {} as any, // filtered
      { name: 'inspect' },
    ] as any;

    printVitePluginSummary(logger as any, appPlugins, merged);

    const infoCalls = take('info');
    expect(infoCalls).toHaveLength(1);

    const [msg] = infoCalls[0] as any[];

    expect(msg).toContain('[τjs] [vite] Plugins');
    expect(msg).toContain('main=[vite:vue, inspect]');
    expect(msg).toContain('admin=[none]');
    expect(msg).toContain('merged=[vite:vue, inspect]');
  });
});
