import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./Logger', () => {
  const DEBUG_CATEGORIES = ['routes', 'errors', 'vite', 'network', 'auth'] as const;
  return { DEBUG_CATEGORIES };
});

import { parseDebugInput } from './../Parser';

describe('parseDebugInput', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns undefined for undefined input', () => {
    expect(parseDebugInput(undefined)).toBeUndefined();
  });

  it('passes through boolean values', () => {
    expect(parseDebugInput(true)).toBe(true);
    expect(parseDebugInput(false)).toBe(false);
  });

  it('handles array: empty -> undefined', () => {
    expect(parseDebugInput([])).toBeUndefined();
  });

  it('handles array: all invalid tokens -> warns and returns undefined (no pos/neg)', () => {
    const res = parseDebugInput(['nope' as any, '!nope2' as any]);
    expect(res).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, expect.stringMatching(/Invalid debug category/));
  });

  it('handles array: negatives only -> { all: true, ...false }', () => {
    const res = parseDebugInput(['-routes', '-vite']);
    expect(res).toEqual({ all: true, routes: false, vite: false });
  });

  it('handles array: positives only -> { ...true }', () => {
    const res = parseDebugInput(['routes', 'vite']);
    expect(res).toEqual({ routes: true, vite: true });
  });

  it('handles array: mix pos/neg -> merged true/false', () => {
    const res = parseDebugInput(['routes', '-vite', 'network']);
    expect(res).toEqual({ routes: true, vite: false, network: true });
  });

  it('handles array: duplicates & conflict -> last assignment leaves false when off+on', () => {
    const res = parseDebugInput(['routes', 'routes', '-routes']);
    expect(res).toEqual({ routes: false });
  });

  it('handles string: blank/whitespace -> undefined', () => {
    expect(parseDebugInput('')).toBeUndefined();
    expect(parseDebugInput('   ')).toBeUndefined();
  });

  it('handles string: wildcard / truthy keywords -> true', () => {
    expect(parseDebugInput('*')).toBe(true);
    expect(parseDebugInput('true')).toBe(true);
    expect(parseDebugInput('TRUE')).toBe(true);
    expect(parseDebugInput('All')).toBe(true);
  });

  it('handles string: invalid tokens only -> warns and returns empty flags object', () => {
    const res = parseDebugInput('bogus, -nope');
    expect(res).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(1, expect.stringMatching(/Invalid debug category/));
  });

  it('handles string: negatives only -> { all: true, ...false }', () => {
    const res = parseDebugInput('-errors, !auth');
    expect(res).toEqual({ all: true, errors: false, auth: false });
  });

  it('handles string: mix of pos/neg + spaces -> merged true/false', () => {
    const res = parseDebugInput('routes, -vite,  network');
    expect(res).toEqual({ routes: true, vite: false, network: true });
  });

  it('handles string: duplicates & conflict -> off wins when both specified', () => {
    const res = parseDebugInput('routes, routes, -routes');
    expect(res).toEqual({ routes: false });
  });

  it('passes through object DebugConfig as-is (identity)', () => {
    const cfg = { all: true, routes: true, vite: false } as any;
    const out = parseDebugInput(cfg);
    expect(out).toBe(cfg);
    expect(out).toEqual(cfg);
  });
});
