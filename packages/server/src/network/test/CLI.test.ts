// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveNet } from '../CLI';
import type { NetResolved } from '../CLI';

const ORIG_ENV = { ...process.env };
const ORIG_ARGV = [...process.argv];

function setEnv(env: Record<string, string | undefined>) {
  Object.keys(process.env).forEach((k) => delete (process.env as any)[k]);
  Object.assign(process.env, ORIG_ENV, env);
}

function setArgv(args: string[]) {
  process.argv.splice(0, process.argv.length, ...args);
}

beforeEach(() => {
  setEnv({});
  setArgv(['node', 'script.js']);
});

afterEach(() => {
  setEnv({});
  setArgv(ORIG_ARGV);
});

describe('resolveNet (full precedence & edge cases)', () => {
  it('defaults with no input/env/argv', () => {
    const r = resolveNet();
    const expected: NetResolved = { host: 'localhost', port: 5173, hmrPort: 5174 };
    expect(r).toEqual(expected);
  });

  it('applies input overrides when provided and finite', () => {
    let r = resolveNet({ host: '127.0.0.1', port: 3000, hmrPort: 3100 });
    expect(r).toEqual({ host: '127.0.0.1', port: 3000, hmrPort: 3100 });

    // invalid input (NaN / not finite) are ignored by Number.isFinite guard
    r = resolveNet({ host: undefined, port: Number.NaN, hmrPort: Number.POSITIVE_INFINITY });
    expect(r).toEqual({ host: 'localhost', port: 5173, hmrPort: 5174 });
  });

  it('environment overrides: HOST > FASTIFY_ADDRESS; PORT/FASTIFY_PORT; HMR_PORT; numeric coercion with fallback', () => {
    // FASTIFY_ADDRESS only
    setEnv({ FASTIFY_ADDRESS: '0.0.0.0', FASTIFY_PORT: '8080', HMR_PORT: '8081' });
    let r = resolveNet();
    expect(r).toEqual({ host: '0.0.0.0', port: 8080, hmrPort: 8081 });

    // HOST takes precedence over FASTIFY_ADDRESS
    setEnv({ HOST: 'myhost', FASTIFY_ADDRESS: 'ignored', PORT: '7000', HMR_PORT: '7001' });
    r = resolveNet();
    expect(r).toEqual({ host: 'myhost', port: 7000, hmrPort: 7001 });

    // invalid env numerics fall back to previous/default values (||)
    setEnv({ HOST: 'envhost', PORT: 'not-a-number', FASTIFY_PORT: '', HMR_PORT: 'NaN' as any });
    r = resolveNet();
    expect(r).toEqual({ host: 'envhost', port: 5173, hmrPort: 5174 });
  });

  it('CLI has highest precedence: separate & equals forms; "--" terminator stops parsing', () => {
    // Separate args
    setEnv({ HOST: 'envhost', PORT: '9000', HMR_PORT: '9001' });
    setArgv(['node', 'script.js', '--host', '1.2.3.4', '--port', '1234', '--hmr-port', '5678']);
    let r = resolveNet();
    expect(r).toEqual({ host: '1.2.3.4', port: 1234, hmrPort: 5678 });

    // Equals form
    setArgv(['node', 'script.js', '--host=5.6.7.8', '--port=2468', '--hmr-port=1357']);
    r = resolveNet();
    expect(r).toEqual({ host: '5.6.7.8', port: 2468, hmrPort: 1357 });

    // "--" terminator means subsequent flags are ignored; env still applies
    setArgv(['node', 'script.js', '--', '--host', '9.9.9.9', '--port', '8888', '--hmr-port', '9999']);
    r = resolveNet();
    expect(r).toEqual({ host: 'envhost', port: 9000, hmrPort: 9001 });
  });

  it('CLI host alternatives: --hostname and -H are supported; bare --host or no value maps to 0.0.0.0', () => {
    // --hostname
    setArgv(['node', 'script.js', '--hostname', '10.0.0.7']);
    let r = resolveNet();
    expect(r).toEqual({ host: '10.0.0.7', port: 5173, hmrPort: 5174 });

    // -H shorthand
    setArgv(['node', 'script.js', '-H', '10.0.0.8', '--port', '6001', '--hmr-port', '6002']);
    r = resolveNet();
    expect(r).toEqual({ host: '10.0.0.8', port: 6001, hmrPort: 6002 });

    // bare --host (no value) -> '0.0.0.0' (and -p is supported by resolveNet)
    setArgv(['node', 'script.js', '--host', '-p', '7777']);
    r = resolveNet();
    expect(r).toEqual({ host: '0.0.0.0', port: 7777, hmrPort: 5174 });

    // --host= (empty after equals) -> bareValue '0.0.0.0'
    setArgv(['node', 'script.js', '--host=']);
    r = resolveNet();
    expect(r).toEqual({ host: '0.0.0.0', port: 5173, hmrPort: 5174 });
  });

  it('maps host "true" to 0.0.0.0 (env case)', () => {
    setEnv({ HOST: 'true' });
    setArgv(['node', 'script.js']);
    const r = resolveNet();
    expect(r).toEqual({ host: '0.0.0.0', port: 5173, hmrPort: 5174 });
  });

  it('hmrPort respects precedence (input < env < CLI) and numeric fallback', () => {
    // base defaults
    let r = resolveNet();
    expect(r.hmrPort).toBe(5174);

    // input
    r = resolveNet({ hmrPort: 6000 });
    expect(r.hmrPort).toBe(6000);

    // env overrides input
    setEnv({ HMR_PORT: '6010' });
    setArgv(['node', 'script.js']);
    r = resolveNet({ hmrPort: 6000 });
    expect(r.hmrPort).toBe(6010);

    // CLI overrides env
    setArgv(['node', 'script.js', '--hmr-port', '7000']);
    r = resolveNet({ hmrPort: 6000 });
    expect(r.hmrPort).toBe(7000);

    // invalid CLI numeric -> fallback to env value
    setArgv(['node', 'script.js', '--hmr-port', 'oops']);
    r = resolveNet();
    expect(r.hmrPort).toBe(6010);

    // invalid env numeric -> fallback to default
    setEnv({ HMR_PORT: 'NaN' as any });
    setArgv(['node', 'script.js']);
    r = resolveNet();
    expect(r.hmrPort).toBe(5174);
  });

  it('env: FASTIFY_PORT present but invalid → falls back to previously resolved port via "|| port"', () => {
    // First set a valid PORT so "previously resolved port" is clear
    setEnv({ PORT: '6500', FASTIFY_PORT: 'NaN' as any }); // present but invalid
    setArgv(['node', 'script.js']); // no CLI override
    let r = resolveNet();
    expect(r.port).toBe(6500); // FASTIFY_PORT tried, fell back to prior port (6500)

    // Also cover FASTIFY_PORT = "0" (falsy) fallback
    setEnv({ PORT: '6501', FASTIFY_PORT: '0' });
    r = resolveNet();
    expect(r.port).toBe(6501); // 0 is falsy → fallback to 6501
  });

  it('CLI: --port present but invalid → falls back to previously resolved port via "|| port"', () => {
    setEnv({ PORT: '8123' });
    setArgv(['node', 'script.js', '--port', 'oops']); // invalid CLI value
    const r = resolveNet();
    expect(r.port).toBe(8123); // CLI parsed, Number('oops') falsy → fallback to env port
  });
});
