// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';

import { isAuthRequired, hasAuthenticate, verifyContracts, formatCspLoadedMsg } from '../VerifyMiddleware';

import type { ContractReport } from '../VerifyMiddleware';

// The runtime mode is snapshotted at module evaluation, so the CSP advisory follows the mode this
// module was imported under - not whatever NODE_ENV holds when `verifyContracts` is called. The
// statically imported module above runs under the suite's ambient `NODE_ENV=test`, which the single
// runtime-mode derivation treats as PRODUCTION; a development expectation selects the environment
// and then imports.
async function importVerifyMiddlewareWithEnv(nodeEnv: string) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;

  vi.resetModules();

  try {
    return await import('../VerifyMiddleware');
  } finally {
    process.env.NODE_ENV = previous;
  }
}

type Route = {
  path?: string;
  appId?: string;
  attr?: {
    middleware?: {
      auth?: unknown;
      csp?: unknown;
    };
  };
};

const ORIG_ENV = { ...process.env };

describe('VerifyMiddleware helpers', () => {
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it('isAuthRequired returns boolean based on route.attr.middleware.auth', () => {
    expect(isAuthRequired({} as any)).toBe(false);
    expect(isAuthRequired({ attr: {} } as any)).toBe(false);
    expect(isAuthRequired({ attr: { middleware: {} } } as any)).toBe(false);
    expect(isAuthRequired({ attr: { middleware: { auth: false } } } as any)).toBe(false);
    expect(isAuthRequired({ attr: { middleware: { auth: true } } } as any)).toBe(true);
    expect(isAuthRequired({ attr: { middleware: { auth: { role: 'user' } } } } as any)).toBe(true);
  });

  it('hasAuthenticate checks for app.authenticate function', () => {
    const app1 = {} as any;
    const app2 = { authenticate: 'not a function' } as any;
    const app3 = { authenticate: () => {} } as any;

    expect(hasAuthenticate(app1 as any)).toBe(false);
    expect(hasAuthenticate(app2 as any)).toBe(false);
    expect(hasAuthenticate(app3 as any)).toBe(true);
  });
});

describe('verifyContracts', () => {
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it('returns skipped when contract.required returns false', () => {
    const app = {} as any;
    const routes: Route[] = [{ path: '/a' }];

    const report = verifyContracts(
      app as any,
      routes as any,
      [
        {
          key: 'auth',
          errorMessage: 'missing auth',
          required: () => false,
          verify: () => false, // should not be called
        },
      ],
      undefined as any,
    ) as ContractReport;

    expect(report.items).toEqual([
      {
        key: 'auth',
        status: 'skipped',
        message: 'No routes require "auth"',
      },
    ]);
  });

  it('verifies a non-CSP contract (required=true, verify=true) and counts routes using per-route required()', () => {
    const app = {} as any;
    const routes: Route[] = [
      { path: '/a', attr: { middleware: { auth: true } } },
      { path: '/b', attr: { middleware: { auth: false } } },
      { path: '/c' }, // no middleware
    ];

    const report = verifyContracts(
      app as any,
      routes as any,
      [
        {
          key: 'auth',
          errorMessage: 'missing auth',
          required: (rts) => rts.some((r) => Boolean(r.attr?.middleware?.auth)),
          verify: () => true,
        },
      ],
      undefined as any,
    );

    // Only 1 route with auth: true -> "✓ 1 route(s)"
    expect(report.items).toEqual([
      {
        key: 'auth',
        status: 'verified',
        message: '✓ 1 route(s)',
      },
    ]);
  });

  it('throws and emits error item when verify() fails for required contract (non-CSP)', () => {
    const app = {} as any;
    const routes: Route[] = [{ path: '/a', attr: { middleware: { auth: true } } }];

    const call = () =>
      verifyContracts(
        app as any,
        routes as any,
        [
          {
            key: 'auth',
            errorMessage: 'Routes require auth but Fastify is missing .authenticate decorator.',
            required: (rts) => rts.some((r) => Boolean(r.attr?.middleware?.auth)),
            verify: () => false, // will fail
          },
        ],
        undefined as any,
      );

    // It throws with the prefixed message
    expect(call).toThrowError('[τjs] Routes require auth but Fastify is missing .authenticate decorator.');
  });

  it('CSP: has global config, no overrides -> verified with "Loaded global config" and verified count line', () => {
    const app = {} as any;
    const routes: Route[] = [
      { path: '/a', attr: { middleware: { csp: undefined } } },
      { path: '/b' }, // also undefined
    ];

    const security = { csp: { directives: { 'default-src': ["'self'"] } } } as any;

    const report = verifyContracts(
      app as any,
      routes as any,
      [
        {
          key: 'csp',
          errorMessage: 'CSP plugin failed',
          required: () => true,
          verify: () => true,
        },
      ],
      security,
    );

    expect(report.items).toEqual([
      {
        key: 'csp',
        status: 'verified',
        message: 'Loaded global config',
      },
      {
        key: 'csp',
        status: 'verified',
        message: '✓ Verified (2 enabled, 0 disabled, 2 total).',
      },
    ]);
  });

  it('CSP: no global, development; overrides present and disabled routes counted', async () => {
    // Development is the ONLY mode without the production advisory, and it must be requested
    // explicitly - hence the environment-selected import rather than a mid-test NODE_ENV write.
    const { verifyContracts } = await importVerifyMiddlewareWithEnv('development');

    const app = {} as any;
    const routes: Route[] = [
      { path: '/a', attr: { middleware: { csp: { mode: 'replace' } } } }, // custom override
      { path: '/b', attr: { middleware: { csp: false } } }, // disabled
      { path: '/c' }, // default/global (none)
    ];

    const report = verifyContracts(
      app as any,
      routes as any,
      [
        {
          key: 'csp',
          errorMessage: 'CSP plugin failed',
          required: () => true,
          verify: () => true,
        },
      ],
      undefined as any,
    );

    // custom = 1 (route a), disabled = 1, total=3, enabled=2
    expect(report.items).toEqual([
      {
        key: 'csp',
        status: 'verified',
        message: 'Loaded development defaults with 1 route override(s)',
      },
      {
        key: 'csp',
        status: 'verified',
        message: '✓ Verified (2 enabled, 1 disabled, 3 total).',
      },
    ]);
  });

  it('CSP: no global, PRODUCTION -> status warning with tail note on the summary line', () => {
    const app = {} as any;
    const routes: Route[] = [
      { path: '/a' }, // default
      { path: '/b', attr: { middleware: { csp: { directives: { 'img-src': ["'self'"] } } } } }, // override
    ];

    const report = verifyContracts(
      app as any,
      routes as any,
      [
        {
          key: 'csp',
          errorMessage: 'CSP plugin failed',
          required: () => true,
          verify: () => true,
        },
      ],
      undefined as any,
    );

    // hasGlobal=false, custom=1, total=2, disabled=0, enabled=2
    const tail = ' (no global CSP header is sent in production without security.csp)';
    expect(report.items).toEqual([
      {
        key: 'csp',
        status: 'warning',
        message: `No global CSP configured; 1 route override(s) only${tail}`,
      },
      {
        key: 'csp',
        status: 'warning',
        message: `✓ Verified (2 enabled, 0 disabled, 2 total).`,
      },
    ]);
  });

  it('Multiple contracts: mix CSP and other verified counts together', () => {
    // RECORDED DELTA: this ran under `NODE_ENV=test` and expected the development defaults
    // message with `verified` status. `test` is production mode now, so a missing global CSP is
    // the production advisory here exactly as it is under `NODE_ENV=production`.
    const app = { authenticate: () => {} } as any;
    const routes: Route[] = [
      { path: '/a', attr: { middleware: { auth: true } } },
      { path: '/b', attr: { middleware: { csp: false } } },
      { path: '/c', attr: { middleware: { csp: { directives: {} } } } },
      { path: '/d' },
    ];

    const report = verifyContracts(
      app as any,
      routes as any,
      [
        {
          key: 'auth',
          errorMessage: 'missing auth',
          required: (rts) => rts.some((r) => Boolean(r.attr?.middleware?.auth)),
          verify: (a) => typeof (a as any).authenticate === 'function',
        },
        {
          key: 'csp',
          errorMessage: 'CSP plugin failed',
          required: () => true,
          verify: () => true,
        },
      ],
      undefined as any,
    );

    // auth count: 1 route where required([r]) true -> ✓ 1 route(s)
    // csp: disabled=1 (b), custom=1 (c), total=4, enabled=3
    expect(report.items).toEqual([
      {
        key: 'auth',
        status: 'verified',
        message: '✓ 1 route(s)',
      },
      {
        key: 'csp',
        status: 'warning',
        message: 'No global CSP configured; 1 route override(s) only (no global CSP header is sent in production without security.csp)',
      },
      {
        key: 'csp',
        status: 'warning',
        message: '✓ Verified (3 enabled, 1 disabled, 4 total).',
      },
    ]);
  });

  it('CSP: has global config WITH overrides -> "Loaded global config with N route override(s)" (no tail)', () => {
    // A global config short-circuits the advisory, so this holds in every mode.
    const app = {} as any;
    const routes: Route[] = [
      { path: '/a', attr: { middleware: { csp: { mode: 'merge' } } } }, // override #1
      { path: '/b', attr: { middleware: { csp: { directives: { 'img-src': ["'self'"] } } } } }, // override #2
      { path: '/c' }, // default/global applies
    ];

    const security = { csp: { directives: { 'default-src': ["'self'"] } } } as any;

    const report = verifyContracts(
      app as any,
      routes as any,
      [
        {
          key: 'csp',
          errorMessage: 'CSP plugin failed',
          required: () => true,
          verify: () => true,
        },
      ],
      security,
    );

    // custom = 2 (a,b), disabled = 0, total=3, enabled=3, hasGlobal=true
    expect(report.items).toEqual([
      {
        key: 'csp',
        status: 'verified',
        message: 'Loaded global config with 2 route override(s)',
      },
      {
        key: 'csp',
        status: 'verified',
        message: '✓ Verified (3 enabled, 0 disabled, 3 total).',
      },
    ]);
  });

  it('CSP: has global config WITH overrides in PRODUCTION → still no warning tail', () => {
    const app = {} as any;
    const routes: Route[] = [
      { path: '/a', attr: { middleware: { csp: { mode: 'replace' } } } }, // override
      { path: '/b' }, // default/global
    ];

    const security = { csp: { directives: { 'default-src': ["'self'"] } } } as any;

    const report = verifyContracts(
      app as any,
      routes as any,
      [
        {
          key: 'csp',
          errorMessage: 'CSP plugin failed',
          required: () => true,
          verify: () => true,
        },
      ],
      security,
    );

    // hasGlobal=true prevents the production warning tail
    expect(report.items).toEqual([
      {
        key: 'csp',
        status: 'verified',
        message: 'Loaded global config with 1 route override(s)',
      },
      {
        key: 'csp',
        status: 'verified',
        message: '✓ Verified (2 enabled, 0 disabled, 2 total).',
      },
    ]);
  });
});

describe('formatCspLoadedMsg', () => {
  it('hasGlobal=false, custom=0', () => {
    expect(formatCspLoadedMsg(false, 0)).toBe('Loaded development defaults');
  });

  it('hasGlobal=false, custom=2', () => {
    expect(formatCspLoadedMsg(false, 2)).toBe('Loaded development defaults with 2 route override(s)');
  });

  it('hasGlobal=true, custom=0', () => {
    expect(formatCspLoadedMsg(true, 0)).toBe('Loaded global config');
  });

  it('hasGlobal=true, custom=3', () => {
    expect(formatCspLoadedMsg(true, 3)).toBe('Loaded global config with 3 route override(s)');
  });

  it('prodNoGlobal: states that no global CSP is configured', () => {
    expect(formatCspLoadedMsg(false, 0, true)).toBe('No global CSP configured');
    expect(formatCspLoadedMsg(false, 2, true)).toBe('No global CSP configured; 2 route override(s) only');
  });
});
