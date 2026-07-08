import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plugin } from 'vite';

vi.mock('@vitejs/plugin-react', () => ({
  default: vi.fn(),
}));

/**
 * NOTE:
 * `@vitejs/plugin-react` is a **peer dependency only**.
 *
 * It is intentionally NOT installed as a dependency to avoid
 * coupling τjs to a specific Vite toolchain or React refresh implementation.
 *
 * Consumers using `@taujs/react/plugin` must install `@vitejs/plugin-react`
 * in their own project.
 */
import react from '@vitejs/plugin-react';
import { pluginReact } from '../plugin';

type ReactMock = ReturnType<typeof vi.fn>;

function getFixPlugin(result: unknown): Plugin {
  expect(Array.isArray(result)).toBe(true);

  const arr = result as unknown[];
  const fix = arr.find((p) => typeof p === 'object' && p != null && (p as any).name === 'taujs:react-refresh-preamble-fix');

  expect(fix).toBeTruthy();
  return fix as Plugin;
}

/**
 * Vite types: transformIndexHtml can be:
 *  - a function hook
 *  - { order, handler } object
 * This helper returns the callable handler in either case.
 */
function getTransformHandler(p: Plugin): (html: string, ctx?: any) => unknown {
  const hook = p.transformIndexHtml;
  expect(hook).toBeTruthy();

  if (typeof hook === 'function') return hook;

  expect(typeof hook).toBe('object');
  const handler = (hook as { handler?: unknown }).handler;
  expect(typeof handler).toBe('function');

  return handler as (html: string) => string | Promise<string>;
}

describe('pluginReact', () => {
  beforeEach(() => {
    (react as unknown as ReactMock).mockReset();
  });

  it('calls @vitejs/plugin-react with undefined when no options are passed, and returns both plugins', () => {
    const mockReactPlugin = { name: 'mock-react-plugin' };
    (react as unknown as ReactMock).mockReturnValue(mockReactPlugin);

    const result = pluginReact();

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith(undefined);

    expect(Array.isArray(result)).toBe(true);
    const arr = result as unknown[];
    expect(arr[0]).toBe(mockReactPlugin);

    const fix = getFixPlugin(result);
    expect(fix.apply).toBe('serve');
    expect(fix.enforce).toBe('post');
    expect(typeof fix.transformIndexHtml).toBeTruthy();
  });

  it('calls @vitejs/plugin-react with the given options, and returns both plugins', () => {
    const mockReactPlugin = { name: 'mock-react-plugin-with-options' };
    const opts: { jsxRuntime: 'automatic' | 'classic' } = { jsxRuntime: 'automatic' };
    (react as unknown as ReactMock).mockReturnValue(mockReactPlugin);

    const result = pluginReact(opts);

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith(opts);

    expect(Array.isArray(result)).toBe(true);
    const arr = result as unknown[];
    expect(arr[0]).toBe(mockReactPlugin);

    getFixPlugin(result);
  });
});

describe('taujs:react-refresh-preamble-fix (via pluginReact return)', () => {
  beforeEach(() => {
    (react as unknown as ReactMock).mockReset();
    (react as unknown as ReactMock).mockReturnValue({ name: 'mock-react-plugin' });
  });

  it('returns html unchanged if preamble is already installed', () => {
    const result = pluginReact();
    const fix = getFixPlugin(result);
    const transform = getTransformHandler(fix);

    const html = '<html><head><script>window.__vite_plugin_react_preamble_installed__=true;</script></head><body></body></html>';

    const out = transform(html);

    expect(out).toBe(html);
  });

  it('returns html unchanged if /@react-refresh is not present', () => {
    const result = pluginReact();
    const fix = getFixPlugin(result);
    const transform = getTransformHandler(fix);

    const html = '<html><head><script type="module" src="/@vite/client"></script></head><body></body></html>';

    const out = transform(html);

    expect(out).toBe(html);
  });

  it('injects the preamble stub after <head ...> when /@react-refresh is present (case-insensitive, preserves attributes)', () => {
    const result = pluginReact();
    const fix = getFixPlugin(result);
    const transform = getTransformHandler(fix);

    const html = '<html><HEAD data-test="1"><script type="module" src="/@react-refresh"></script></HEAD><body></body></html>';

    const out = transform(html);

    expect(typeof out === 'string').toBe(true);
    const outHtml = out as string;

    expect(outHtml).not.toBe(html);

    expect(outHtml).toContain('<head data-test="1">');

    expect(outHtml).toContain('window.__vite_plugin_react_preamble_installed__=true');
    expect(outHtml).toContain('window.$RefreshReg$=()=>{};');
    expect(outHtml).toContain('window.$RefreshSig$=()=>(t)=>t;');

    expect(
      outHtml.startsWith(
        '<html><head data-test="1"><script>window.__vite_plugin_react_preamble_installed__=true;window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(t)=>t;</script>',
      ),
    ).toBe(true);
  });
});
