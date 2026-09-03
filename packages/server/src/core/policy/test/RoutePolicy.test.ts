import { describe, expect, it } from 'vitest';

import { evaluateRoutePolicy, validateRoutePolicy } from '../RoutePolicy';

import type { GraphRoute, GraphRouteCSP } from '../../introspection/RequestGraph';
import type { RoutePolicy, RoutePolicyEvaluatorInput } from '../RoutePolicy';

// A fully-formed GraphRoute with sensible defaults - tests override only what they exercise.
const route = (overrides: Partial<GraphRoute> = {}): GraphRoute => ({
  id: 'web:/',
  appId: 'web',
  path: '/',
  render: { strategy: 'ssr', defaulted: false },
  hydrate: { enabled: true, defaulted: false },
  specificity: 0,
  middleware: { auth: { declared: false }, csp: { declared: false } },
  data: { kind: 'none' },
  ...overrides,
});

const installation = (overrides: Partial<RoutePolicyEvaluatorInput['installation']> = {}): RoutePolicyEvaluatorInput['installation'] => ({
  globalCspConfigured: false,
  ...overrides,
});

const bootFacts = (overrides: Partial<RoutePolicyEvaluatorInput['bootFacts']> = {}): RoutePolicyEvaluatorInput['bootFacts'] => ({
  authSeamVerified: false,
  ...overrides,
});

describe('validateRoutePolicy', () => {
  it('returns undefined when routePolicy is not declared (inert default)', () => {
    expect(validateRoutePolicy({})).toBeUndefined();
  });

  it('returns the validated policy unchanged for a well-formed declaration', () => {
    const policy: RoutePolicy = { rules: [{ id: 'public', match: {}, require: [] }] };

    expect(validateRoutePolicy({ routePolicy: policy })).toEqual(policy);
  });

  it('accepts a rule with no require field and preserves omission (not coerced to [])', () => {
    const result = validateRoutePolicy({ routePolicy: { rules: [{ id: 'x', match: {} }] } });

    expect(result?.rules[0]).toEqual({ id: 'x', match: {} });
    expect(result?.rules[0]).not.toHaveProperty('require');
  });

  // The complete fail-closed configuration-error matrix from RFC 0016, table-driven.
  it.each<[string, unknown]>([
    ['routePolicy is a string, not an object', 'oops'],
    ['routePolicy is an array', []],
    ['routePolicy is null', null],
    ['routePolicy has a foreign prototype (inherited rules must not smuggle past the grammar)', Object.assign(Object.create({ rules: [] }), {})],
    ['routePolicy carries an unknown root key', { rules: [], enforce: 'warn' }],
    ['a rule has a foreign prototype (inherited fields rejected outright)', { rules: [Object.assign(Object.create({ id: 'x', match: {} }), {})] }],
    [
      'a match has a foreign prototype (inherited selector fields rejected outright)',
      { rules: [{ id: 'a', match: Object.assign(Object.create({ appId: 'x' }), {}) }] },
    ],
    ['rules is missing', {}],
    ['rules is not an array', { rules: 'oops' }],
    ['rules is a plain object', { rules: {} }],
    ['a rule is not an object', { rules: ['oops'] }],
    ['a rule is an array', { rules: [[]] }],
    ['a rule has an unknown top-level key ("requires" typo)', { rules: [{ id: 'a', match: {}, requires: ['taujs.auth-wired'] }] }],
    ['a rule has an unknown top-level key ("matches" typo)', { rules: [{ id: 'a', matches: {} }] }],
    ['a rule id is missing', { rules: [{ match: {} }] }],
    ['a rule id is not a string', { rules: [{ id: 1, match: {} }] }],
    ['a rule id starts with a digit', { rules: [{ id: '1abc', match: {} }] }],
    ['a rule id starts with a capital', { rules: [{ id: 'Abc', match: {} }] }],
    ['a rule id contains an invalid character', { rules: [{ id: 'a_b', match: {} }] }],
    ['a rule id exceeds 64 characters', { rules: [{ id: `a${'b'.repeat(64)}`, match: {} }] }],
    [
      'duplicate rule ids',
      {
        rules: [
          { id: 'dup', match: {} },
          { id: 'dup', match: {} },
        ],
      },
    ],
    ['match is missing', { rules: [{ id: 'a' }] }],
    ['match is not an object', { rules: [{ id: 'a', match: 'oops' }] }],
    ['match is an array', { rules: [{ id: 'a', match: [] }] }],
    ['match has an unknown selector name', { rules: [{ id: 'a', match: { method: 'GET' } }] }],
    ['match.appId is not a string', { rules: [{ id: 'a', match: { appId: 1 } }] }],
    ['match.path is not a string', { rules: [{ id: 'a', match: { path: 1 } }] }],
    ['match.render is invalid', { rules: [{ id: 'a', match: { render: 'csr' } }] }],
    ['match.render is not a string', { rules: [{ id: 'a', match: { render: 1 } }] }],
    ['match.hydrate is not a boolean', { rules: [{ id: 'a', match: { hydrate: 'yes' } }] }],
    ['match.hasData is not a boolean', { rules: [{ id: 'a', match: { hasData: 1 } }] }],
    ['match.hasHead is not a boolean', { rules: [{ id: 'a', match: { hasHead: 1 } }] }],
    ['match.hasDeferred is not a boolean', { rules: [{ id: 'a', match: { hasDeferred: 1 } }] }],
    ['require is not an array', { rules: [{ id: 'a', match: {}, require: 'taujs.auth-wired' }] }],
    ['require contains an unknown evidence name', { rules: [{ id: 'a', match: {}, require: ['taujs.made-up'] }] }],
    ['require contains the removed request-budget evidence name', { rules: [{ id: 'a', match: {}, require: ['taujs.request-budget-configured'] }] }],
    ['require contains a non-string entry', { rules: [{ id: 'a', match: {}, require: [1] }] }],
  ])('rejects: %s', (_label, malformed) => {
    expect(() => validateRoutePolicy({ routePolicy: malformed as RoutePolicy })).toThrow();
  });

  it('accepts every declared evidence name and every selector field together', () => {
    const policy = {
      rules: [
        {
          id: 'full',
          match: { appId: 'web', path: '/a', render: 'streaming', hydrate: true, hasData: true, hasHead: true, hasDeferred: true },
          require: ['taujs.auth-wired', 'taujs.csp-configured'],
        },
      ],
    };

    expect(() => validateRoutePolicy({ routePolicy: policy as RoutePolicy })).not.toThrow();
  });
});

describe('evaluateRoutePolicy: rule ownership', () => {
  it('rule order / first-match ownership: the first matching rule wins, later matching rules are ignored', () => {
    const policy: RoutePolicy = {
      rules: [
        { id: 'first', match: { path: '/a' }, require: ['taujs.auth-wired'] },
        { id: 'second', match: { path: '/a' }, require: [] },
      ],
    };

    const result = evaluateRoutePolicy(policy, {
      graph: { routes: [route({ id: 'web:/a', path: '/a' })] },
      installation: installation(),
      bootFacts: bootFacts(),
    });

    // Owned by "first" (which requires unmet evidence), never "second" (which would be silent).
    expect(result.findings).toEqual([expect.objectContaining({ code: 'policy.evidence_missing', ruleId: 'first', evidence: 'taujs.auth-wired' })]);
  });

  it('{} is the explicit catch-all: it owns every route no earlier rule claims', () => {
    const policy: RoutePolicy = {
      rules: [
        { id: 'specific', match: { path: '/special' } },
        { id: 'catch-all', match: {} },
      ],
    };

    const result = evaluateRoutePolicy(policy, {
      graph: { routes: [route({ id: 'web:/anything', path: '/anything' })] },
      installation: installation(),
      bootFacts: bootFacts(),
    });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('fail-closed unmatched: a route no rule (not even a catch-all) matches is a policy.route_unmatched finding', () => {
    const policy: RoutePolicy = { rules: [{ id: 'only-a', match: { path: '/a' } }] };

    const result = evaluateRoutePolicy(policy, {
      graph: { routes: [route({ id: 'web:/b', path: '/b' })] },
      installation: installation(),
      bootFacts: bootFacts(),
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([expect.objectContaining({ code: 'policy.route_unmatched', routeId: 'web:/b' })]);
    // No ruleId/evidence on an unmatched finding - there is no owning rule.
    expect(result.findings[0]?.ruleId).toBeUndefined();
    expect(result.findings[0]?.evidence).toBeUndefined();
  });

  it('an empty routePolicy (no rules at all) leaves every route unmatched', () => {
    const result = evaluateRoutePolicy({ rules: [] }, { graph: { routes: [route()] }, installation: installation(), bootFacts: bootFacts() });

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.code).toBe('policy.route_unmatched');
  });

  it('empty/omitted require is valid and explicitly owns a public route (no finding)', () => {
    const result = evaluateRoutePolicy(
      { rules: [{ id: 'public', match: {}, require: [] }] },
      { graph: { routes: [route()] }, installation: installation(), bootFacts: bootFacts() },
    );

    expect(result.ok).toBe(true);
  });

  it('every missing evidence produces its own finding - not just the first', () => {
    const result = evaluateRoutePolicy(
      { rules: [{ id: 'strict', match: {}, require: ['taujs.auth-wired', 'taujs.csp-configured'] }] },
      { graph: { routes: [route()] }, installation: installation(), bootFacts: bootFacts() },
    );

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.evidence)).toEqual(['taujs.auth-wired', 'taujs.csp-configured']);
    expect(result.findings.every((f) => f.ruleId === 'strict' && f.code === 'policy.evidence_missing')).toBe(true);
  });

  it('ok derivation: true iff findings is empty', () => {
    const passing = evaluateRoutePolicy(
      { rules: [{ id: 'a', match: {} }] },
      { graph: { routes: [route(), route({ id: 'web:/b', path: '/b' })] }, installation: installation(), bootFacts: bootFacts() },
    );
    expect(passing.ok).toBe(true);

    const failing = evaluateRoutePolicy(
      { rules: [{ id: 'a', match: { path: '/only' } }] },
      { graph: { routes: [route()] }, installation: installation(), bootFacts: bootFacts() },
    );
    expect(failing.ok).toBe(false);
  });
});

describe('evaluateRoutePolicy: selectors against real graph fields', () => {
  const owns = (match: RoutePolicy['rules'][number]['match'], r: GraphRoute): boolean =>
    evaluateRoutePolicy({ rules: [{ id: 'probe', match }] }, { graph: { routes: [r] }, installation: installation(), bootFacts: bootFacts() }).ok;

  it('appId: exact match only', () => {
    const r = route({ appId: 'shop' });
    expect(owns({ appId: 'shop' }, r)).toBe(true);
    expect(owns({ appId: 'web' }, r)).toBe(false);
  });

  it('path: exact match only (no wildcard grammar)', () => {
    const r = route({ path: '/a/b' });
    expect(owns({ path: '/a/b' }, r)).toBe(true);
    expect(owns({ path: '/a' }, r)).toBe(false);
    expect(owns({ path: '/a/*' }, r)).toBe(false);
  });

  it('render: ssr vs streaming', () => {
    const streaming = route({ render: { strategy: 'streaming', defaulted: false } });
    expect(owns({ render: 'streaming' }, streaming)).toBe(true);
    expect(owns({ render: 'ssr' }, streaming)).toBe(false);
  });

  it('hydrate: enabled vs disabled', () => {
    const noHydrate = route({ hydrate: { enabled: false, defaulted: false } });
    expect(owns({ hydrate: false }, noHydrate)).toBe(true);
    expect(owns({ hydrate: true }, noHydrate)).toBe(false);
  });

  it('hasData: data.kind !== "none"', () => {
    const withData = route({ data: { kind: 'dynamic' } });
    const withoutData = route({ data: { kind: 'none' } });
    expect(owns({ hasData: true }, withData)).toBe(true);
    expect(owns({ hasData: false }, withData)).toBe(false);
    expect(owns({ hasData: false }, withoutData)).toBe(true);
  });

  it('hasHead: declared attr.head.data presence', () => {
    const withHead = route({ head: { data: { kind: 'dynamic' } } });
    const withoutHead = route({});
    expect(owns({ hasHead: true }, withHead)).toBe(true);
    expect(owns({ hasHead: false }, withoutHead)).toBe(true);
    expect(owns({ hasHead: true }, withoutHead)).toBe(false);
  });

  it('hasDeferred: at least one declared attr.deferred entry', () => {
    const withDeferred = route({ deferred: [{ key: 'a', data: { kind: 'dynamic' } }] });
    const withoutDeferred = route({});
    expect(owns({ hasDeferred: true }, withDeferred)).toBe(true);
    expect(owns({ hasDeferred: false }, withoutDeferred)).toBe(true);
    expect(owns({ hasDeferred: true }, withoutDeferred)).toBe(false);
  });

  it('conjunctive selectors: every declared field must agree, not just one', () => {
    const r = route({ appId: 'web', path: '/dash', render: { strategy: 'ssr', defaulted: false }, hydrate: { enabled: true, defaulted: false } });

    expect(owns({ appId: 'web', path: '/dash' }, r)).toBe(true);
    // One field disagreeing is enough to sink the match, even with the rest agreeing.
    expect(owns({ appId: 'web', path: '/dash', render: 'streaming' }, r)).toBe(false);
    expect(owns({ appId: 'other', path: '/dash' }, r)).toBe(false);
  });
});

describe('evaluateRoutePolicy: taujs.csp-configured truth table (RFC 0016 revision 3, verbatim)', () => {
  const activeOverride: GraphRouteCSP = { declared: true, mode: 'merge', dynamic: false, reportOnly: false };
  const softDisabled: GraphRouteCSP = { declared: true, disabled: 'soft' };
  const hardDisabled: GraphRouteCSP = { declared: true, disabled: 'hard' };
  const noDeclaration: GraphRouteCSP = { declared: false };

  const evidencePresent = (csp: GraphRouteCSP, globalCspConfigured: boolean): boolean => {
    const result = evaluateRoutePolicy(
      { rules: [{ id: 'r', match: {}, require: ['taujs.csp-configured'] }] },
      {
        graph: { routes: [route({ middleware: { auth: { declared: false }, csp } })] },
        installation: installation({ globalCspConfigured }),
        bootFacts: bootFacts(),
      },
    );

    return result.ok;
  };

  it.each<[string, GraphRouteCSP, boolean, boolean]>([
    ['1. active route override, no explicit global CSP -> present', activeOverride, false, true],
    ['1b. active route override, WITH explicit global CSP -> present (still, override owns it)', activeOverride, true, true],
    ['2. no route declaration + explicit global CSP -> present', noDeclaration, true, true],
    ['3. soft-disabled declaration + explicit global CSP -> present', softDisabled, true, true],
    ['4. hard-disabled declaration, no explicit global CSP -> absent', hardDisabled, false, false],
    ['4b. hard-disabled declaration, WITH explicit global CSP -> absent (hard disable always wins)', hardDisabled, true, false],
    ['5a. no route declaration, no explicit global CSP -> absent', noDeclaration, false, false],
    ['5b. soft-disabled declaration, no explicit global CSP -> absent', softDisabled, false, false],
  ])('%s', (_label, csp, globalCspConfigured, expectPresent) => {
    expect(evidencePresent(csp, globalCspConfigured)).toBe(expectPresent);
  });

  it('dev-fallback directives never count as evidence: globalCspConfigured must be hasExplicitCSP, not "some CSP header is sent"', () => {
    // A route with no declaration and no EXPLICIT global config: even though τjs sends dev
    // fallback directives in that state, `globalCspConfigured: false` (the honest
    // `hasExplicitCSP` value) must still fail the evidence - this is the same row as 5a above,
    // named explicitly because it is the row most likely to be got wrong.
    expect(evidencePresent(noDeclaration, false)).toBe(false);
  });
});

describe('evaluateRoutePolicy: taujs.auth-wired', () => {
  const evidencePresent = (declared: boolean, authSeamVerified: boolean): boolean =>
    evaluateRoutePolicy(
      { rules: [{ id: 'r', match: {}, require: ['taujs.auth-wired'] }] },
      {
        graph: { routes: [route({ middleware: { auth: { declared }, csp: { declared: false } } })] },
        installation: installation(),
        bootFacts: bootFacts({ authSeamVerified }),
      },
    ).ok;

  it('present: route declares middleware.auth AND the boot seam verified', () => {
    expect(evidencePresent(true, true)).toBe(true);
  });

  it('absent: route declares middleware.auth but the boot seam fact is false', () => {
    expect(evidencePresent(true, false)).toBe(false);
  });

  it('absent: route does not declare middleware.auth at all, regardless of the boot seam fact', () => {
    expect(evidencePresent(false, true)).toBe(false);
    expect(evidencePresent(false, false)).toBe(false);
  });
});
