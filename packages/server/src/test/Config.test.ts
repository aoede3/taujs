// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import { resolveHmrTransport, resolveIntrospectionAllowedHosts } from '../core/config/Setup';

vi.mock('./core/services/DataServices', () => {
  return {
    callServiceMethod: vi.fn(async () => ({ ok: true })),
    defineService: vi.fn((x: any) => x),
    defineServiceRegistry: vi.fn((x: any) => x),
    withDeadline: vi.fn((signal?: AbortSignal, ms?: number) => signal),
  };
});

vi.mock('./core/errors/AppError', () => {
  class AppError extends Error {
    static internal(msg: string) {
      return new AppError(msg);
    }
  }
  return { AppError };
});

describe('Config', async () => {
  const mod = await import('../Config');

  it('re-exports DataServices symbols (smoke)', async () => {
    expect(typeof mod.callServiceMethod).toBe('function');
    expect(typeof mod.defineService).toBe('function');
    expect(typeof mod.defineServiceRegistry).toBe('function');
    expect(typeof mod.withDeadline).toBe('function');

    const registry = {
      svc: {
        m: vi.fn(async () => ({ ok: true })),
      },
    };

    const ctx = { logger: undefined, requestId: 't' } as any;

    await expect(mod.callServiceMethod(registry as any, 'svc', 'm', {}, ctx)).resolves.toEqual({ ok: true });

    const svc = mod.defineService({
      foo: async () => ({ ok: true }),
    } as any);

    expect(Object.isFrozen(svc)).toBe(true);
    expect(typeof (svc as any).foo).toBe('function');
    await expect((svc as any).foo({}, ctx)).resolves.toEqual({ ok: true });

    const reg = mod.defineServiceRegistry({
      svc: {
        m: async () => ({ ok: true }),
      },
    } as any);

    expect(Object.isFrozen(reg)).toBe(true);
    expect(Object.isFrozen((reg as any).svc)).toBe(true);

    expect(mod.withDeadline(undefined, undefined)).toBeUndefined();
  });

  it('re-exports AppError (smoke)', () => {
    expect(mod.AppError).toBeTruthy();
    const err = mod.AppError.internal('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('x');
  });

  describe('defineConfig', () => {
    it('throws if apps is missing', () => {
      // apps absent => throws (covers !config.apps branch)
      expect(() => mod.defineConfig({} as any)).toThrowError('At least one app must be configured');
    });

    it('throws if apps is an empty array', () => {
      // apps present but empty => throws (covers length === 0 branch)
      expect(() => mod.defineConfig({ apps: [] } as any)).toThrowError('At least one app must be configured');
    });

    it('returns the same object when apps is non-empty', () => {
      // happy path (covers return branch)
      const cfg = { apps: [{ appId: 'a', entryPoint: 'appA' }] } as any;
      const out = mod.defineConfig(cfg);
      expect(out).toBe(cfg);
      expect(out.apps.length).toBe(1);
    });
  });
});

// RFC 0013: the development HMR transport selector. Validation and the Mode-B rejection both
// happen at configuration time - before Vite installs an upgrade listener or τjs touches a
// caller's root - because silently ignoring an explicit transport request would be worse than
// refusing an unsupported combination.
describe('resolveHmrTransport (RFC 0013)', () => {
  const cfg = (hmrTransport?: unknown) => ({ server: hmrTransport === undefined ? {} : { hmrTransport } }) as any;
  const DEV = true;
  const PROD = false;

  it('defaults to fixed-port when undeclared, on either ownership mode', () => {
    expect(resolveHmrTransport(cfg(), false, DEV)).toBe('fixed-port');
    expect(resolveHmrTransport(cfg(), true, DEV)).toBe('fixed-port');
  });

  it('accepts an explicit fixed-port on either ownership mode', () => {
    expect(resolveHmrTransport(cfg('fixed-port'), false, DEV)).toBe('fixed-port');
    expect(resolveHmrTransport(cfg('fixed-port'), true, DEV)).toBe('fixed-port');
  });

  it('accepts attached when τjs owns the host', () => {
    expect(resolveHmrTransport(cfg('attached'), false, DEV)).toBe('attached');
  });

  it('REJECTS attached on a caller-supplied host IN DEVELOPMENT, naming the remedy', () => {
    expect(() => resolveHmrTransport(cfg('attached'), true, DEV)).toThrow(/requires a τjs-created Fastify host/);
    expect(() => resolveHmrTransport(cfg('attached'), true, DEV)).toThrow(/fixed-port/);
  });

  it('ACCEPTS attached on a caller-supplied host IN PRODUCTION - the option is inert there', () => {
    // A Mode-B production deployment sharing one configuration file must still boot; production
    // installs no HMR facility, so there is nothing to reject.
    expect(() => resolveHmrTransport(cfg('attached'), true, PROD)).not.toThrow();
    expect(resolveHmrTransport(cfg('attached'), true, PROD)).toBe('attached');
  });

  it('REJECTS an unknown value in EVERY mode rather than falling back to the default', () => {
    for (const mode of [DEV, PROD]) {
      expect(() => resolveHmrTransport(cfg('attatched'), false, mode)).toThrow(/is not a valid transport/);
      expect(() => resolveHmrTransport(cfg(true), true, mode)).toThrow(/is not a valid transport/);
    }
  });
});

// Post-freeze ruling 2026-08-08 (docs/introspection/decisions.md): exact DNS hostnames only,
// resolved once to a lowercase exact-match set. Validation is mode-independent by construction
// (the resolver never consults the runtime mode); the boot-time before-host-mutation half of
// that contract is proved in CreateServerEmission.test.ts against createServer itself.
describe('resolveIntrospectionAllowedHosts (post-freeze ruling 2026-08-08)', () => {
  const cfg = (allowedHosts?: unknown) => ({ introspection: allowedHosts === undefined ? {} : { allowedHosts } }) as any;

  it('resolves to an empty set when undeclared, when introspection is absent, and for an explicit empty list', () => {
    expect(resolveIntrospectionAllowedHosts({} as any).size).toBe(0);
    expect(resolveIntrospectionAllowedHosts(cfg()).size).toBe(0);
    expect(resolveIntrospectionAllowedHosts(cfg([])).size).toBe(0);
  });

  it('resolves entries to a lowercase exact-match set (case-insensitive comparison, DNS semantics)', () => {
    const resolved = resolveIntrospectionAllowedHosts(cfg(['Web.PLT.Local', 'intranet']));

    expect([...resolved].sort()).toEqual(['intranet', 'web.plt.local']);
  });

  it('REJECTS leading-dot and wildcard declarations - subdomain admission is never implied', () => {
    expect(() => resolveIntrospectionAllowedHosts(cfg(['.plt.local']))).toThrow(/not an exact DNS hostname/);
    expect(() => resolveIntrospectionAllowedHosts(cfg(['*.plt.local']))).toThrow(/not an exact DNS hostname/);
  });

  it('REJECTS scheme, path, port and whitespace-bearing declarations', () => {
    for (const entry of ['http://web.plt.local', 'web.plt.local/admin', 'web.plt.local:3042', 'web.plt local', ' web.plt.local', '']) {
      expect(() => resolveIntrospectionAllowedHosts(cfg([entry])), entry).toThrow(/not an exact DNS hostname/);
    }
  });

  it('REJECTS every IP-literal form with the intrinsic remedy - dotted-quad, bare and bracketed IPv6, and WHATWG IPv4 spellings', () => {
    // IP detection is decided against the URL host parser the guard compares with: shorthand,
    // decimal, octal and hex IPv4 spellings all canonicalise to dotted-quads on the request
    // side, so they are IP literals here too - remedy, never the grammar complaint.
    for (const entry of ['192.168.1.5', '::1', '[::1]', '127.1', '2130706433', '0177.0.0.1', '0x7f000001']) {
      expect(() => resolveIntrospectionAllowedHosts(cfg([entry])), entry).toThrow(/admitted intrinsically/);
    }
  });

  it('REJECTS a grammar-passing value the URL host parser cannot read back (out-of-range numeric label)', () => {
    expect(() => resolveIntrospectionAllowedHosts(cfg(['99999999999999999999']))).toThrow(/not a hostname the URL host parser accepts/);
  });

  it('REJECTS non-array declarations and non-string entries', () => {
    expect(() => resolveIntrospectionAllowedHosts(cfg(true))).toThrow(/must be an array/);
    expect(() => resolveIntrospectionAllowedHosts(cfg('web.plt.local'))).toThrow(/must be an array/);
    expect(() => resolveIntrospectionAllowedHosts(cfg([42]))).toThrow(/entries must be strings/);
  });
});
