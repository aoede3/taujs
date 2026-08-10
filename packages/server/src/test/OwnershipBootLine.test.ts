// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CONTENT } from '../constants';
import { testRenderer } from './support/renderer';

import type { TaujsConfig } from '../Config';

// The ownership boot line reports two facts a reader cannot otherwise get from the logs: on a
// caller-owned host, whether the opt-in terminal `/*` page is declared (RFC 0010 Q5 installs no
// τjs not-found shell there); and on a created host, whether the shell is whole-server or
// confined to a mount (RFC 0012).
//
// Only the SSR plugin and the network seams are mocked, so route extraction and the addressing
// coordinates run for real - the message is built from the same values a real boot uses.
vi.mock('../SSRServer', () => ({ ssrServerPlugin: () => ({ __id: 'ssr-server-plugin' }) }));
vi.mock('../network/Network', () => ({ bannerPlugin: { __id: 'banner-plugin' } }));
vi.mock('../network/CLI', () => ({ resolveNet: vi.fn(() => ({ host: '127.0.0.1', port: 5173, hmrPort: 5174 })) }));
// The created-host arm makes τjs build the instance itself; a real Fastify would reject the
// mocked plugins above. Every instance it hands back is retained so the created host can be
// inspected the same way a supplied one is.
const hoisted = vi.hoisted(() => ({ created: [] as any[] }));
vi.mock('fastify', () => ({
  default: vi.fn(() => {
    const instance = { register: vi.fn(async () => undefined), addHook: vi.fn(), log: undefined };
    hoisted.created.push(instance);
    return instance;
  }),
}));

const lastCreatedHost = () => hoisted.created[hoisted.created.length - 1]!;

const ROOT_ROUTE = { path: '/', attr: { render: 'ssr' } } as const;
const WILDCARD_ROUTE = { path: '/*', attr: { render: 'ssr' } } as const;

const configWith = (routes: readonly unknown[], server?: Record<string, unknown>): TaujsConfig =>
  ({
    ...(server ? { server } : {}),
    apps: [{ appId: 'web', entryPoint: 'web', renderer: testRenderer(), routes }],
  }) as TaujsConfig;

const mkHost = () => ({ register: vi.fn(async () => undefined), addHook: vi.fn(), log: undefined }) as any;

const mkLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), isDebugEnabled: vi.fn(() => false) });

const originalNodeEnv = process.env.NODE_ENV;
const originalConsoleLog = console.log;

/** Boot and return the single ownership record: `[meta, message]`. */
const ownershipRecord = async (config: TaujsConfig, opts: { callerOwned: boolean }) => {
  vi.resetModules();
  const { createServer } = await import('../CreateServer');
  const logger = mkLogger();

  await createServer({ config, logger: logger as never, ...(opts.callerOwned ? { fastify: mkHost() } : {}) });

  const calls = logger.info.mock.calls.filter((call) => (call[0] as { component?: string })?.component === 'ownership');
  expect(calls).toHaveLength(1);

  return calls[0] as [Record<string, unknown>, string];
};

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  console.log = vi.fn();
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  console.log = originalConsoleLog;
});

describe('ownership boot line - caller-owned host states the terminal wildcard (RFC 0010 Q5 residue)', () => {
  it("without a declared /*, names the caller's not-found policy as the owner of unmatched GET paths", async () => {
    const [meta, message] = await ownershipRecord(configWith([ROOT_ROUTE]), { callerOwned: true });

    expect(message).toBe(
      `${CONTENT.TAG} [ownership] Fastify supplied by caller - τjs owns its declared routes in an encapsulated scope; host errors, not-found, CSP and request identity remain yours. No terminal '/*' τjs page declared: your routes and not-found policy own all remaining GET paths`,
    );
    expect(meta).toEqual({ component: 'ownership', callerOwnedHost: true, mounted: false, terminalWildcard: false });
  });

  it('with a declared /*, names it as the owner of remaining GET paths, including asset-like ones', async () => {
    const [meta, message] = await ownershipRecord(configWith([ROOT_ROUTE, WILDCARD_ROUTE]), { callerOwned: true });

    // The scope clause is load-bearing twice over. A declared `/*` really does own API-like GET
    // paths - `HostOwnership.test.ts` renders `/api/rfc0010` through it - so the line must not
    // imply otherwise; and the implicit created-host shell 404s asset-like misses while a
    // declared wildcard renders them, so the two must not read as equivalent.
    expect(message).toBe(
      `${CONTENT.TAG} [ownership] Fastify supplied by caller - τjs owns its declared routes in an encapsulated scope; host errors, not-found, CSP and request identity remain yours. Terminal '/*' τjs page declared: it owns GET paths not claimed by a more-specific route within the τjs scope, including API-like and asset-like paths`,
    );
    expect(meta).toEqual({ component: 'ownership', callerOwnedHost: true, mounted: false, terminalWildcard: true });
  });

  it('does NOT treat a narrower wildcard as the terminal one', async () => {
    // Negative control. Without it the whole matrix would still pass if the check degraded to
    // "any path containing a star": `/app/*` is a scoped wildcard that leaves plenty of GET
    // paths unclaimed, so it must not report the terminal state.
    const [meta, message] = await ownershipRecord(configWith([ROOT_ROUTE, { path: '/app/*', attr: { render: 'ssr' } }]), { callerOwned: true });

    expect(meta.terminalWildcard).toBe(false);
    expect(message).toContain("No terminal '/*' τjs page declared");
  });

  it('reports the wildcard on a MOUNTED caller-owned host too, where the scope is the mounted subtree', async () => {
    const mount = { mountPrefix: '/app' };

    const [withoutMeta, withoutMessage] = await ownershipRecord(configWith([ROOT_ROUTE], mount), { callerOwned: true });
    expect(withoutMessage).toContain("No terminal '/*' τjs page declared");
    expect(withoutMeta).toEqual({ component: 'ownership', callerOwnedHost: true, mounted: true, terminalWildcard: false });

    const [withMeta, withMessage] = await ownershipRecord(configWith([ROOT_ROUTE, WILDCARD_ROUTE], mount), { callerOwned: true });
    expect(withMessage).toContain("Terminal '/*' τjs page declared");
    expect(withMeta).toEqual({ component: 'ownership', callerOwnedHost: true, mounted: true, terminalWildcard: true });
  });
});

describe('ownership boot line - created host is mount-aware (RFC 0012)', () => {
  it('is unchanged when unmounted, whether or not a wildcard is declared', async () => {
    const expected = `${CONTENT.TAG} [ownership] Fastify created by τjs - whole-server SPA fallback, CSP and request identity`;

    const [plainMeta, plainMessage] = await ownershipRecord(configWith([ROOT_ROUTE]), { callerOwned: false });
    expect(plainMessage).toBe(expected);
    expect(plainMeta).toEqual({ component: 'ownership', callerOwnedHost: false, mounted: false, terminalWildcard: false });

    // A created host already has the implicit shell, so a declared `/*` changes nothing it needs
    // to announce - only the metadata records the fact.
    const [wildcardMeta, wildcardMessage] = await ownershipRecord(configWith([ROOT_ROUTE, WILDCARD_ROUTE]), { callerOwned: false });
    expect(wildcardMessage).toBe(expected);
    expect(wildcardMeta).toEqual({ component: 'ownership', callerOwnedHost: false, mounted: false, terminalWildcard: true });
  });

  it('states the confinement when mounted, rather than claiming a whole-server SPA fallback', async () => {
    // MountAddressing.test.ts proves the runtime behaviour this describes: inside the subtree the
    // shell serves, outside it the host answers an ordinary 404.
    const [meta, message] = await ownershipRecord(configWith([ROOT_ROUTE], { mountPrefix: '/app' }), { callerOwned: false });

    expect(message).toBe(
      `${CONTENT.TAG} [ownership] Fastify created by τjs - SPA fallback confined to the mounted subtree, an ordinary 404 outside it, CSP and request identity`,
    );
    expect(message).not.toContain('whole-server SPA fallback');
    expect(meta).toEqual({ component: 'ownership', callerOwnedHost: false, mounted: true, terminalWildcard: false });
  });
});

describe('ownership boot line - log output only', () => {
  /**
   * Top-level host assembly: which plugins are registered on the host, in order. The `routes`
   * option intentionally differs between the two configurations - the wildcard IS a declared
   * route - so only plugin identity and order are compared, never the options bag.
   */
  const hostAssembly = async (routes: readonly unknown[], opts: { callerOwned: boolean }): Promise<{ plugins: unknown[]; hooks: number }> => {
    vi.resetModules();
    const { createServer } = await import('../CreateServer');
    const supplied = opts.callerOwned ? mkHost() : undefined;

    await createServer({ config: configWith(routes), logger: mkLogger() as never, ...(supplied ? { fastify: supplied } : {}) });

    const host = supplied ?? lastCreatedHost();

    return { plugins: host.register.mock.calls.map((call: unknown[]) => call[0]), hooks: host.addHook.mock.calls.length };
  };

  it('declaring /* changes top-level host assembly on neither ownership mode', async () => {
    for (const callerOwned of [true, false]) {
      const without = await hostAssembly([ROOT_ROUTE], { callerOwned });
      const withWildcard = await hostAssembly([ROOT_ROUTE, WILDCARD_ROUTE], { callerOwned });

      // Identity and order, not merely a count: the wildcard is an ordinary declared route the
      // SSR plugin receives, never a change to how the host is put together.
      expect(withWildcard.plugins, `callerOwned=${callerOwned}`).toEqual(without.plugins);
      expect(withWildcard.plugins.length, `callerOwned=${callerOwned}`).toBeGreaterThan(0);
      expect(withWildcard.hooks, `callerOwned=${callerOwned}`).toBe(without.hooks);
    }
  });
});
