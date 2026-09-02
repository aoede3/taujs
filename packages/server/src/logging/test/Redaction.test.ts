// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { DEFAULT_DENY_KEYS, isDeniedKey, redactDeniedKeys } from '../Redaction';
import { DEFAULT_DENY_KEYS as DEV_DEFAULT_DENY_KEYS } from '../../core/introspection/DevIntrospection';
import { createLogger } from '../Logger';
import { createDevIntrospection } from '../../core/introspection/DevIntrospection';

describe('Redaction', () => {
  it('isDeniedKey matches case-insensitive substrings against the supplied denylist', () => {
    expect(isDeniedKey('AuthToken', DEFAULT_DENY_KEYS)).toBe(true);
    expect(isDeniedKey('userId', DEFAULT_DENY_KEYS)).toBe(false);
  });

  it('redactDeniedKeys drops a denied subtree, keeps siblings, and never caps VALUES', () => {
    const deep = { a: { b: { c: { d: { keep: 'x'.repeat(1000) } } } } };
    const out = redactDeniedKeys(deep) as any;
    expect(out.a.b.c.d.keep).toHaveLength(1000);

    const mixed = { secret: 'v', label: 'kept' };
    expect(redactDeniedKeys(mixed)).toEqual({ label: 'kept' });
  });

  it('replaces a subtree past the depth budget with [depth], never raw', () => {
    let deep: any = { leaf: true };
    for (let i = 0; i < 40; i += 1) deep = { down: deep };
    const out = redactDeniedKeys(deep);
    expect(JSON.stringify(out)).toContain('"[depth]"');
    expect(JSON.stringify(out)).not.toContain('leaf');
  });

  it('the node budget is a WORK bound: past it, no further property is read and one [truncated] marker stands in', () => {
    let reads = 0;
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 12_000; i += 1) {
      Object.defineProperty(wide, `k${i}`, {
        enumerable: true,
        get() {
          reads += 1;
          return `v${i}`;
        },
      });
    }
    const out = redactDeniedKeys(wide) as Record<string, unknown>;
    expect(reads).toBeLessThanOrEqual(10_000);
    expect(out['[truncated]']).toBe(true);
    expect(Object.keys(out).length).toBeLessThanOrEqual(10_001);
    expect(JSON.stringify(out)).not.toContain('v11999');
  });

  it('a revoked proxy is replaced with [unredactable]; siblings survive', () => {
    const { proxy, revoke } = Proxy.revocable({ leak: 'raw-secret-value' }, {});
    revoke();
    const out = redactDeniedKeys({ dead: proxy, keep: 1 }) as Record<string, unknown>;
    expect(out.dead).toBe('[unredactable]');
    expect(out.keep).toBe(1);
    expect(JSON.stringify(out)).not.toContain('raw-secret-value');
  });

  it('caps arrays at the array budget with a trailing [truncated] marker', () => {
    const arr = Array.from({ length: 1_001 }, (_, i) => i);
    const out = redactDeniedKeys(arr) as unknown[];
    expect(out).toHaveLength(1_001);
    expect(out[999]).toBe(999);
    expect(out[1_000]).toBe('[truncated]');
  });

  it('rejects a denied key BEFORE reading it - a denied throwing getter never executes', () => {
    let executed = false;
    const obj = {
      keep: 1,
      get password(): string {
        executed = true;
        throw new Error('must never run');
      },
    };
    expect(redactDeniedKeys(obj)).toEqual({ keep: 1 });
    expect(executed).toBe(false);
  });

  it('a PERMITTED throwing getter yields [unreadable] instead of throwing', () => {
    const obj = {
      keep: 1,
      get details(): string {
        throw new Error('boom');
      },
    };
    expect(redactDeniedKeys(obj)).toEqual({ keep: 1, details: '[unreadable]' });
  });

  it('an object whose keys cannot be enumerated yields [unredactable], never the raw object', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys for you');
        },
      },
    );
    expect(redactDeniedKeys({ hostile, keep: 1 })).toEqual({ hostile: '[unredactable]', keep: 1 });
  });

  it('projects a class instance through the walk - its denied enumerable props never pass by identity', () => {
    class Creds {
      label = 'kept';
      apiToken = 'raw-secret-value';
    }
    const out = redactDeniedKeys({ creds: new Creds() }) as any;
    expect(out.creds).toEqual({ label: 'kept' });

    const m = new Map([['password', 'raw-secret-value']]);
    const withMap = redactDeniedKeys({ m }) as any;
    expect(withMap.m).toEqual({});
    expect(JSON.stringify(withMap)).not.toContain('raw-secret-value');
  });

  it('redactDeniedKeys is array-aware and cycle-safe', () => {
    const arr = [{ token: 't' }, { name: 'ok' }];
    expect(redactDeniedKeys(arr)).toEqual([{}, { name: 'ok' }]);

    const circular: any = { keep: 1 };
    circular.self = circular;
    const out = redactDeniedKeys(circular) as any;
    expect(out.keep).toBe(1);
    expect(out.self).toBe('[circular]');
  });
});

describe('shared denylist policy', () => {
  it("DevIntrospection's re-exported DEFAULT_DENY_KEYS is reference-identical to Redaction's", () => {
    expect(DEV_DEFAULT_DENY_KEYS).toBe(DEFAULT_DENY_KEYS);
  });

  it('the logger and the dev introspection annex deny the same novel-cased key', () => {
    const custom = { info: (meta: unknown) => (loggerMeta = meta as Record<string, unknown>) };
    let loggerMeta: Record<string, unknown> | undefined;
    const logger = createLogger({ custom, includeContext: false });
    logger.info({ AuthToken: 'raw-secret-value', keep: 1 }, 'novel-cased key');
    expect(loggerMeta!.AuthToken).toBeUndefined();
    expect(loggerMeta!.keep).toBe(1);

    const dev = createDevIntrospection();
    const base = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      isDebugEnabled: () => false,
      child(): any {
        return this;
      },
    };
    const wrapped = dev.wrapRequestLogger(base as any, 'req-1');
    wrapped.info({ AuthToken: 'raw-secret-value', keep: 1 }, 'novel-cased key');
    const devMeta = dev.getLogs('req-1')[0]!.meta as Record<string, unknown>;
    expect(devMeta.AuthToken).toBeUndefined();
    expect(devMeta.keep).toBe('1');
  });
});
