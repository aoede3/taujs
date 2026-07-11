import { describe, it, expect } from 'vitest';

import { serializeInlineData } from '../InlineData';

// The pre-R0-04 inline expression, kept as the byte-identity oracle: valid inputs MUST serialize
// identically to before so cached pages and existing tests never observe a diff.
const legacy = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

describe('serializeInlineData (R0-04)', () => {
  describe('valid inputs — byte-identical to the legacy inline expression', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['empty object', {}],
      ['nested', { a: 1, b: { c: [1, 2, 3], d: 'x' } }],
      ['null', null],
      ['array', [1, 'two', { three: 3 }]],
      ['string with quotes', { s: 'he said "hi"' }],
      ['unicode text', { s: 'café — naïve' }],
    ];

    for (const [name, v] of cases) {
      it(name, () => {
        const r = serializeInlineData(v);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.js).toBe(legacy(v));
      });
    }
  });

  it('escapes `<` so `</script>` and `<!--` cannot break out (byte-identical to legacy)', () => {
    const payload = { html: '</script><!-- <div>' };
    const r = serializeInlineData(payload);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.js).not.toContain('<'); // every '<' escaped
      expect(r.js).toContain('\\u003c');
      expect(r.js).toBe(legacy(payload));
      // reverses cleanly on the client (< is a valid JSON unicode escape for '<')
      expect(JSON.parse(r.js)).toEqual(payload);
    }
  });

  it('passes U+2028 / U+2029 through unescaped (legal in ES2019+ string literals)', () => {
    const payload = { s: 'a b c' };
    const r = serializeInlineData(payload);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.js).toContain(' ');
      expect(r.js).toContain(' ');
      expect(r.js).toBe(legacy(payload));
    }
  });

  it('preserves a "__proto__" key as an ordinary JSON key (SEC4 — no prototype pollution on re-parse)', () => {
    const payload = { ['__proto__']: { polluted: true }, ok: 1 };
    const r = serializeInlineData(payload);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.js).toContain('__proto__');
      const parsed = JSON.parse(r.js);
      // re-parses as an OWN property, not a prototype mutation
      expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    }
  });

  describe('non-serializable inputs — fail deterministically and NEVER throw', () => {
    it('circular reference', () => {
      const a: Record<string, unknown> = { name: 'a' };
      a.self = a;
      const r = serializeInlineData(a);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });

    it('BigInt', () => {
      expect(serializeInlineData({ big: 1n }).ok).toBe(false);
    });

    it('throwing toJSON', () => {
      const r = serializeInlineData({
        bad: {
          toJSON() {
            throw new Error('toJSON boom');
          },
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('toJSON boom');
    });

    it('undefined (JSON.stringify returns undefined)', () => {
      expect(serializeInlineData(undefined).ok).toBe(false);
    });

    it('a bare function', () => {
      expect(serializeInlineData(() => {}).ok).toBe(false);
    });

    it('a toJSON that throws a hostile non-Error (throwing string coercion) still does not throw', () => {
      const hostile = {
        toJSON() {
          throw {
            [Symbol.toPrimitive]() {
              throw new Error('coercion boom');
            },
            toString() {
              throw new Error('coercion boom');
            },
          };
        },
      };

      let result: ReturnType<typeof serializeInlineData> | undefined;
      expect(() => {
        result = serializeInlineData(hostile);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    });

    it('never throws for any non-serializable input', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const inputs: unknown[] = [circular, { big: 1n }, undefined, () => {}, Symbol('s')];
      for (const i of inputs) expect(() => serializeInlineData(i)).not.toThrow();
    });
  });
});
