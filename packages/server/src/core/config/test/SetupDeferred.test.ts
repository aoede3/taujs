// @vitest-environment node
// RFC 0007 (R1, authoring-contract rules 1/3/4): `attr.deferred` boot validation lives with the
// existing extract-routes checks. Malformed input is a HARD ERROR, never a warning.
import { describe, it, expect } from 'vitest';

import { extractRoutes } from '../Setup';

const withDeferred = (deferred: unknown, render: string = 'streaming') =>
  ({ apps: [{ appId: 'shop', entryPoint: '', routes: [{ path: '/product/:id', attr: { render, meta: {}, deferred } }] }] }) as any;

describe('extractRoutes attr.deferred validation (RFC 0007 R1)', () => {
  it('accepts a valid streaming declaration, and leaves routes without deferred untouched', () => {
    expect(() => extractRoutes(withDeferred({ reviews: async () => ({}), stock_2: async () => ({}) }))).not.toThrow();
    expect(() => extractRoutes(withDeferred(undefined))).not.toThrow();
    expect(() => extractRoutes({ apps: [{ appId: 'shop', entryPoint: '', routes: [{ path: '/x', attr: { render: 'ssr' } }] }] } as any)).not.toThrow();
  });

  it('rejects deferred on an ssr route (rule 3)', () => {
    expect(() => extractRoutes(withDeferred({ reviews: async () => ({}) }, 'ssr'))).toThrow(/attr\.deferred is only valid on a "streaming" route/);
  });

  it('rejects a non-plain-object record (rule 4), including a foreign prototype', () => {
    expect(() => extractRoutes(withDeferred([async () => ({})]))).toThrow(/attr\.deferred must be a plain object/);
    expect(() => extractRoutes(withDeferred('reviews'))).toThrow(/attr\.deferred must be a plain object/);
    expect(() => extractRoutes(withDeferred(Object.create({ reviews: async () => ({}) })))).toThrow(/attr\.deferred must be a plain object/);
  });

  it('rejects a non-function entry value (rule 4)', () => {
    expect(() => extractRoutes(withDeferred({ reviews: 42 }))).toThrow(/attr\.deferred\."reviews" must be a function/);
  });

  it('rejects keys failing the charset rule (rule 1)', () => {
    for (const key of ['9reviews', 'reviews-list', 'reviews.count', '', '__proto__', 'a b']) {
      expect(() => extractRoutes(withDeferred({ [key]: async () => ({}) }))).toThrow(/must match \^\[A-Za-z\]\[A-Za-z0-9_\]\*\$/);
    }
  });

  it('never trusts an inherited key: only OWN enumerable keys are validated', () => {
    // A polluted Object.prototype must not turn a valid record into a boot failure.
    (Object.prototype as unknown as Record<string, unknown>)['inheritedNonsense'] = 42;
    try {
      expect(() => extractRoutes(withDeferred({ reviews: async () => ({}) }))).not.toThrow();
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['inheritedNonsense'];
    }
  });
});
