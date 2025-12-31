// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

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

    const ctx = { logger: undefined, traceId: 't' } as any;

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
