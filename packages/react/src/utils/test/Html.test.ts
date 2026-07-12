import { describe, it, expect } from 'vitest';

import { escapeHtml } from '../Html';

describe('escapeHtml', () => {
  it('escapes all five HTML-sensitive characters (text- AND attribute-safe, both quote styles)', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes & FIRST so freshly produced entities are not corrupted', () => {
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
    // an existing entity has its `&` escaped — double-escaping is the caller's concern (below)
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('escapes a mixed attribute-breakout payload', () => {
    const raw = `" onload='alert(1)' <img src=x>`;
    expect(escapeHtml(raw)).toBe('&quot; onload=&#39;alert(1)&#39; &lt;img src=x&gt;');
  });

  it('coerces non-string input via String() (public signature accepts unknown)', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
    expect(escapeHtml({ toString: () => '<x>' })).toBe('&lt;x&gt;');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
    expect(escapeHtml('')).toBe('');
  });

  it('is NOT idempotent — the caller must not double-escape (documented)', () => {
    expect(escapeHtml(escapeHtml('<'))).toBe('&amp;lt;');
  });
});
