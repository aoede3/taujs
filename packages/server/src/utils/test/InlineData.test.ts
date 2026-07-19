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

  // ESC-3: a `__proto__` key used to set the emitted literal's PROTOTYPE (Annex B.3.1) rather than
  // round-tripping as an own property — semantic drift between the server and client values. Ruled
  // a FIX by ESC-0. These evaluate the SAME expression the page emits
  // (`window.__INITIAL_DATA__ = <js>`), never `JSON.parse` directly, so the assertion is about what
  // a browser actually gets.
  describe('__proto__ round-trips as an own data property (ESC-3)', () => {
    const evaluate = (js: string) => new Function(`return (${js});`)() as Record<string, unknown>;

    it('top-level: own property, prototype untouched, global unpolluted', () => {
      const payload = { ['__proto__']: { polluted: true }, ok: 1 };
      const r = serializeInlineData(payload);

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.js.startsWith('JSON.parse(')).toBe(true); // a __proto__ KEY selects the fallback form

      const evaluated = evaluate(r.js);

      expect(Object.prototype.hasOwnProperty.call(evaluated, '__proto__')).toBe(true); // OWN property now
      expect(evaluated['__proto__']).toEqual({ polluted: true }); // the DATA round-trips
      expect(Object.getPrototypeOf(evaluated)).toBe(Object.prototype); // prototype untouched
      expect(Object.keys(evaluated)).toEqual(['__proto__', 'ok']); // key order preserved
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined(); // global never polluted
    });

    it('NESTED occurrences round-trip identically at every depth', () => {
      const payload = { a: { b: { ['__proto__']: { deep: 1 } } }, list: [{ ['__proto__']: { inArray: true } }] };
      const r = serializeInlineData(payload);

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const evaluated = evaluate(r.js) as unknown as { a: { b: Record<string, unknown> }; list: Array<Record<string, unknown>> };

      expect(Object.prototype.hasOwnProperty.call(evaluated.a.b, '__proto__')).toBe(true);
      expect(evaluated.a.b['__proto__']).toEqual({ deep: 1 });
      expect(Object.getPrototypeOf(evaluated.a.b)).toBe(Object.prototype);

      const first = evaluated.list[0];
      expect(first).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(first, '__proto__')).toBe(true);
      expect(first!['__proto__']).toEqual({ inArray: true });
      expect(Object.getPrototypeOf(first)).toBe(Object.prototype);

      expect(({} as { deep?: unknown }).deep).toBeUndefined();
    });

    it('the emitted value is deep-equal to the server value (no shape drift)', () => {
      const payload = { ['__proto__']: { a: 1 }, keep: 'x', nested: { ['__proto__']: { b: 2 } } };
      const r = serializeInlineData(payload);

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // JSON.parse of the server's own JSON is the reference client value.
      expect(evaluate(r.js)).toEqual(JSON.parse(JSON.stringify(payload)));
    });

    it('breakout stays impossible in the JSON.parse form', () => {
      const payload = { ['__proto__']: { x: '</script><script>alert(1)</script>' }, s: '<!--' };
      const r = serializeInlineData(payload);

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.js).not.toContain('</script'); // every `<` escaped
      expect(r.js).not.toContain('<script');
      expect(r.js).not.toContain('<!--');
      // and the value still survives the escape intact
      expect((evaluate(r.js)['__proto__'] as { x: string }).x).toBe('</script><script>alert(1)</script>');
    });

    // The trigger is a substring test for the QUOTED token `"__proto__"`, so its only false
    // positive is a string value EXACTLY equal to `__proto__`. These two tests pin both sides of
    // that boundary, and each asserts WHICH form was selected — without that assertion a test can
    // pass down the wrong branch and prove nothing.
    it('a string value exactly "__proto__" selects the JSON.parse form (harmless false positive)', () => {
      const payload = { note: '__proto__' };
      const r = serializeInlineData(payload);

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.js.startsWith('JSON.parse(')).toBe(true); // the fallback really was selected
      expect(evaluate(r.js)).toEqual(payload); // and it is semantically identical, which is the point
    });

    it('a string that merely MENTIONS __proto__ does NOT trigger the fallback, and stays byte-identical', () => {
      const payload = { note: 'the __proto__ key is special' };
      const r = serializeInlineData(payload);

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.js.startsWith('JSON.parse(')).toBe(false); // no quote adjacent to the token
      expect(r.js).toBe(legacy(payload)); // ordinary payload: unchanged output
      expect(evaluate(r.js)).toEqual(payload);
    });
  });

  it('nested undefined/function/symbol follow standard JSON semantics (omitted / null), not rejection (crash-safety, not contract enforcement)', () => {
    const obj = serializeInlineData({ a: 1, skip: undefined, fn() {}, sym: Symbol('s') });
    expect(obj.ok).toBe(true);
    if (obj.ok) expect(obj.js).toBe('{"a":1}'); // nested undefined/function/symbol omitted

    const arr = serializeInlineData([1, undefined, () => {}, Symbol('s')]);
    expect(arr.ok).toBe(true);
    if (arr.ok) expect(arr.js).toBe('[1,null,null,null]'); // nulled in arrays
  });

  it('nested BigInt / circular still fail deterministically (JSON.stringify throws anywhere in the tree)', () => {
    expect(serializeInlineData({ nested: { deep: 1n } }).ok).toBe(false);

    const circular: Record<string, unknown> = {};
    circular.child = { back: circular };
    expect(serializeInlineData(circular).ok).toBe(false);
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
