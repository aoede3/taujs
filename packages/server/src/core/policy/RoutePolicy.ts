import type { GraphRoute } from '../introspection/RequestGraph';

/**
 * RFC 0016 (Phase A): the two evidence names τjs can honestly derive from what it already
 * proves at boot - never an authentication OUTCOME, never a coverage statement about runtime
 * reachability. Framework-derived and environment-independent (the truth tables live on
 * `isEvidencePresent` below).
 */
export type RoutePolicyEvidenceName = 'taujs.auth-wired' | 'taujs.csp-configured';

/**
 * RFC 0016 (Phase A): every field is DETERMINATE (match or no-match, nothing else) and
 * EXACT-MATCH only - no wildcard grammar, no transitive service/method reachability (deferred
 * by the revision-5 shrink). Fields are conjunctive; `{}` is the explicit catch-all that owns
 * every route no other rule claims.
 */
export type RoutePolicySelector = {
  /** Exact match against the route's declared `appId`. */
  appId?: string;
  /** Exact match against the graph's declared path string - no wildcard grammar. */
  path?: string;
  render?: 'ssr' | 'streaming';
  hydrate?: boolean;
  /** `true` when the route's `data.kind !== 'none'`. */
  hasData?: boolean;
  /** `true` when the route declares `attr.head.data`. */
  hasHead?: boolean;
  /** `true` when the route declares at least one `attr.deferred` entry. */
  hasDeferred?: boolean;
};

/**
 * RFC 0016 (Phase A): one ordered rule. `id` is required, unique and stable
 * (`^[a-z][a-z0-9-]{0,63}$`). `require` empty or omitted is valid and EXPLICITLY owns a public
 * route - it is not the same as no rule matching at all (`policy.route_unmatched`).
 */
export type RoutePolicyRule = {
  id: string;
  match: RoutePolicySelector;
  require?: RoutePolicyEvidenceName[];
};

/** RFC 0016 (Phase A): the top-level declared shape - ordered, first-match rules. */
export type RoutePolicy = { rules: RoutePolicyRule[] };

/**
 * RFC 0016 (Phase A): two codes, and every finding refuses boot - there is deliberately no
 * severity field, because it would carry no information (revision 4 shrink).
 */
export type RoutePolicyFinding = {
  code: 'policy.route_unmatched' | 'policy.evidence_missing';
  routeId: string;
  /** The owning rule - present on `policy.evidence_missing` only. */
  ruleId?: string;
  /** The missing evidence name - present on `policy.evidence_missing` only. */
  evidence?: RoutePolicyEvidenceName;
  /** Presentation only - never machine-interpreted. */
  message: string;
};

export type RoutePolicyResult = {
  /** `true` iff `findings` is empty. */
  ok: boolean;
  findings: RoutePolicyFinding[];
};

/**
 * RFC 0016 (Phase A): the evaluator's typed input, evaluated against a separately-supplied
 * `RoutePolicy`. `graph` is deliberately narrowed to what the evaluator reads - the canonical
 * `RequestGraph` satisfies it structurally, so boot wiring passes the real graph straight
 * through, and cells need only construct the routes they exercise.
 */
export type RoutePolicyEvaluatorInput = {
  graph: { routes: readonly GraphRoute[] };
  installation: {
    /**
     * A DURABLE production-effective global CSP configuration exists (`extractSecurity`'s
     * `hasExplicitCSP`). Development fallback directives never count - this is exactly the
     * flag that already distinguishes them elsewhere in the codebase.
     */
    globalCspConfigured: boolean;
  };
  bootFacts: {
    /**
     * A declared auth seam was verified at boot (the `verifyContracts` "auth" contract
     * passed, or no route required it). A WIRED seam, never an authentication outcome.
     */
    authSeamVerified: boolean;
  };
};

const RULE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ALLOWED_RULE_KEYS = new Set(['id', 'match', 'require']);
const ALLOWED_SELECTOR_KEYS = new Set(['appId', 'path', 'render', 'hydrate', 'hasData', 'hasHead', 'hasDeferred']);
const BOOLEAN_SELECTOR_KEYS = ['hydrate', 'hasData', 'hasHead', 'hasDeferred'] as const;
const RENDER_VALUES = new Set(['ssr', 'streaming']);
const EVIDENCE_NAMES: ReadonlySet<RoutePolicyEvidenceName> = new Set(['taujs.auth-wired', 'taujs.csp-configured']);

// The established τjs plain-record check (ResolveRouteData.ts / Setup.ts): a foreign prototype
// is rejected outright, so inherited `rules`/selector fields can never smuggle past the exact
// grammar through property lookup or `in`.
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

const quoteList = (values: string[]): string => values.map((v) => `"${v}"`).join(', ');

/**
 * RFC 0016 (Phase A): validate and resolve `routePolicy`, at FUNCTION ENTRY for the same reason
 * the coordinate resolvers are - invalid configuration must fail before any host state exists.
 * `undefined` (the default) means no policy is declared: no graph
 * construction, evaluation, logging or request-time work happens anywhere (this validation
 * call and its one property read are the entire cost of absence).
 *
 * Fail-closed on every row: a policy typo must never silently weaken enforcement, so anything
 * outside the exact declared shape is rejected rather than coerced or ignored - unknown rule
 * keys, unknown selector names, unknown evidence names, malformed or duplicate rule ids, and
 * every wrong-typed field.
 */
export const validateRoutePolicy = (config: { routePolicy?: RoutePolicy }): RoutePolicy | undefined => {
  const declared = config.routePolicy;
  if (declared === undefined) return undefined;

  if (!isPlainObject(declared)) throw new Error('routePolicy must be a plain object with a "rules" array');

  const unknownRootKeys = Object.keys(declared).filter((k) => k !== 'rules');
  if (unknownRootKeys.length > 0) {
    throw new Error(`routePolicy: unknown key(s) ${quoteList(unknownRootKeys)} - expected only "rules"`);
  }

  const rawRules = (declared as { rules?: unknown }).rules;
  if (!Array.isArray(rawRules)) throw new Error('routePolicy.rules must be an array');

  const seenIds = new Set<string>();
  const rules: RoutePolicyRule[] = [];

  rawRules.forEach((rawRule, index) => {
    const at = `routePolicy.rules[${index}]`;

    if (!isPlainObject(rawRule)) throw new Error(`${at} must be an object`);

    const unknownRuleKeys = Object.keys(rawRule).filter((k) => !ALLOWED_RULE_KEYS.has(k));
    if (unknownRuleKeys.length > 0) {
      throw new Error(`${at}: unknown key(s) ${quoteList(unknownRuleKeys)} - expected only "id", "match", "require"`);
    }

    const { id, match, require: requireField } = rawRule as { id?: unknown; match?: unknown; require?: unknown };

    if (typeof id !== 'string' || !RULE_ID_PATTERN.test(id)) {
      throw new Error(`${at}.id must be a string matching ${RULE_ID_PATTERN.source} (received ${JSON.stringify(id)})`);
    }
    if (seenIds.has(id)) throw new Error(`routePolicy.rules: duplicate rule id "${id}"`);
    seenIds.add(id);

    if (!isPlainObject(match)) throw new Error(`${at}.match must be an object ({} is the explicit catch-all)`);

    const unknownSelectorKeys = Object.keys(match).filter((k) => !ALLOWED_SELECTOR_KEYS.has(k));
    if (unknownSelectorKeys.length > 0) throw new Error(`${at}.match: unknown selector(s) ${quoteList(unknownSelectorKeys)}`);

    const selector: RoutePolicySelector = {};

    if ('appId' in match) {
      if (typeof match.appId !== 'string') throw new Error(`${at}.match.appId must be a string`);
      selector.appId = match.appId;
    }
    if ('path' in match) {
      if (typeof match.path !== 'string') throw new Error(`${at}.match.path must be a string`);
      selector.path = match.path;
    }
    if ('render' in match) {
      if (typeof match.render !== 'string' || !RENDER_VALUES.has(match.render)) {
        throw new Error(`${at}.match.render must be "ssr" or "streaming" (received ${JSON.stringify(match.render)})`);
      }
      selector.render = match.render as 'ssr' | 'streaming';
    }
    for (const key of BOOLEAN_SELECTOR_KEYS) {
      if (key in match) {
        if (typeof match[key] !== 'boolean') throw new Error(`${at}.match.${key} must be a boolean`);
        selector[key] = match[key] as boolean;
      }
    }

    let require: RoutePolicyEvidenceName[] | undefined;
    if (requireField !== undefined) {
      if (!Array.isArray(requireField)) throw new Error(`${at}.require must be an array of evidence names`);
      for (const name of requireField) {
        if (typeof name !== 'string' || !EVIDENCE_NAMES.has(name as RoutePolicyEvidenceName)) {
          throw new Error(`${at}.require: unknown evidence name ${JSON.stringify(name)}`);
        }
      }
      require = requireField as RoutePolicyEvidenceName[];
    }

    rules.push({ id, match: selector, ...(require !== undefined ? { require } : {}) });
  });

  return { rules };
};

// Conjunctive: every declared field must agree; an undeclared field imposes no constraint, so
// `{}` matches unconditionally (the explicit catch-all).
const matchesSelector = (route: GraphRoute, selector: RoutePolicySelector): boolean => {
  if (selector.appId !== undefined && selector.appId !== route.appId) return false;
  if (selector.path !== undefined && selector.path !== route.path) return false;
  if (selector.render !== undefined && selector.render !== route.render.strategy) return false;
  if (selector.hydrate !== undefined && selector.hydrate !== route.hydrate.enabled) return false;
  if (selector.hasData !== undefined && selector.hasData !== (route.data.kind !== 'none')) return false;
  if (selector.hasHead !== undefined && selector.hasHead !== (route.head !== undefined)) return false;
  if (selector.hasDeferred !== undefined && selector.hasDeferred !== (route.deferred?.length ?? 0) > 0) return false;

  return true;
};

// RFC 0016 revision 3 truth table (verbatim), five rows:
// 1. active route override (declared, no disabled arm)              -> present, regardless of global
// 2. no route declaration + explicit global CSP                     -> present
// 3. soft-disabled declaration + explicit global CSP                -> present
// 4. hard-disabled declaration                                      -> absent, regardless of global
// 5. (no declaration OR soft-disabled) + no explicit global CSP     -> absent
// Development fallback directives never count: `globalCspConfigured` is `hasExplicitCSP`, which
// is `false` exactly when only dev-default directives apply.
const isEvidencePresent = (
  evidence: RoutePolicyEvidenceName,
  route: GraphRoute,
  installation: RoutePolicyEvaluatorInput['installation'],
  bootFacts: RoutePolicyEvaluatorInput['bootFacts'],
): boolean => {
  switch (evidence) {
    case 'taujs.auth-wired':
      return route.middleware.auth.declared && bootFacts.authSeamVerified;
    case 'taujs.csp-configured': {
      const csp = route.middleware.csp;
      if (!csp.declared) return installation.globalCspConfigured;
      if ('disabled' in csp) return csp.disabled === 'hard' ? false : installation.globalCspConfigured;

      return true; // active route override
    }
  }
};

/**
 * RFC 0016 (Phase A): the pure evaluator. Ordered first-match ownership - the first rule whose
 * `match` selector matches a route owns it; an unmatched route is a fail-closed
 * `policy.route_unmatched` finding (a `{}` catch-all rule owns every route no other rule
 * claims, so an unmatched finding means no rule at all - including no catch-all - was
 * declared). An owning rule's `require` (empty or omitted is valid and explicitly public) is
 * checked evidence-by-evidence, and every missing evidence becomes its own
 * `policy.evidence_missing` finding - never just the first. Zero imports from MCP, logging or
 * Fastify: pure data in, data out.
 */
export const evaluateRoutePolicy = (policy: RoutePolicy, input: RoutePolicyEvaluatorInput): RoutePolicyResult => {
  const findings: RoutePolicyFinding[] = [];

  for (const route of input.graph.routes) {
    const rule = policy.rules.find((r) => matchesSelector(route, r.match));

    if (!rule) {
      findings.push({
        code: 'policy.route_unmatched',
        routeId: route.id,
        message: `Route "${route.id}" matched no routePolicy rule (fail-closed). Declare an owning rule, or a "{}" catch-all rule to own every otherwise-unmatched route.`,
      });
      continue;
    }

    for (const evidence of rule.require ?? []) {
      if (!isEvidencePresent(evidence, route, input.installation, input.bootFacts)) {
        findings.push({
          code: 'policy.evidence_missing',
          routeId: route.id,
          ruleId: rule.id,
          evidence,
          message: `Route "${route.id}" is owned by routePolicy rule "${rule.id}", which requires "${evidence}" - that evidence is missing.`,
        });
      }
    }
  }

  return { ok: findings.length === 0, findings };
};
