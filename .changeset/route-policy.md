---
'@taujs/server': minor
---

Route policy: opt-in top-level `routePolicy` declares ordered, first-match rules over each route's own declared shape (`appId`, `path`, `render`, `hydrate`, `hasData`, `hasHead`, `hasDeferred` - all exact match, fields conjunctive, `{}` the explicit catch-all), each requiring zero or more framework-derived evidence names: `taujs.auth-wired` (a declared auth seam that boot verified), `taujs.csp-configured` (a durable, production-effective CSP posture - development fallback directives never count), and `taujs.request-budget-configured` (`server.requestBudgetMs` set). A route no rule owns, not even a catch-all, is a fail-closed configuration error; an empty or omitted `require` explicitly marks a route public rather than leaving it silently unmatched.

When declared, τjs builds the canonical request graph and evaluates it once at boot - in development and production alike - logs every finding, then refuses to boot on any finding, with no escape switch. A malformed rule (an unknown key, an unknown selector, an unknown evidence name, a malformed or duplicate rule id) is rejected at configuration validation, before evaluation ever runs.

Left unset (the default): no request graph is built and no evaluation, policy logging or request-time work runs - configuration validation is the entire cost of absence, and there is no new failure surface or presentation change.
