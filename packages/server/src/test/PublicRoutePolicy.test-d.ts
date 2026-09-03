// HARD GATE on the PUBLIC ENTRY: these imports come from '../Config', exercising exactly what
// ships as '@taujs/server/config' (the PublicRequestBudget.test-d.ts idiom - the internal
// `core/policy/RoutePolicy` module exporting the type cannot substitute, which is precisely
// how a prior unit's export missed the real entry). Proves: `RoutePolicy`, `RoutePolicyRule`,
// `RoutePolicySelector` and `RoutePolicyEvidenceName` are named exports of the public config
// surface, with exactly the RFC 0016 (Phase A) shape - no service/method selectors, no
// `forbid`, no severity, no coverage.
// Enforced by `pnpm --filter @taujs/server typecheck` (tsc).
import type { RoutePolicy, RoutePolicyEvidenceName, RoutePolicyRule, RoutePolicySelector } from '../Config';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const evidence: RoutePolicyEvidenceName;
type _evidence = Expect<Eq<typeof evidence, 'taujs.auth-wired' | 'taujs.csp-configured' | 'taujs.request-budget-configured'>>;

declare const selector: RoutePolicySelector;
type _selectorKeys = Expect<Eq<keyof RoutePolicySelector, 'appId' | 'path' | 'render' | 'hydrate' | 'hasData' | 'hasHead' | 'hasDeferred'>>;
type _selectorAppId = Expect<Eq<typeof selector.appId, string | undefined>>;
type _selectorPath = Expect<Eq<typeof selector.path, string | undefined>>;
type _selectorRender = Expect<Eq<typeof selector.render, 'ssr' | 'streaming' | undefined>>;
type _selectorHydrate = Expect<Eq<typeof selector.hydrate, boolean | undefined>>;

declare const rule: RoutePolicyRule;
type _ruleKeys = Expect<Eq<keyof RoutePolicyRule, 'id' | 'match' | 'require'>>;
type _ruleId = Expect<Eq<typeof rule.id, string>>;
type _ruleMatch = Expect<Eq<typeof rule.match, RoutePolicySelector>>;
type _ruleRequire = Expect<Eq<typeof rule.require, RoutePolicyEvidenceName[] | undefined>>;

declare const policy: RoutePolicy;
type _policyKeys = Expect<Eq<keyof RoutePolicy, 'rules'>>;
type _policyRules = Expect<Eq<typeof policy.rules, RoutePolicyRule[]>>;
