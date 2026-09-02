// Shared sensitive-key denylist (conventions rule 13). Matching is case-insensitive substring on
// the key; a matched key's entire subtree is dropped, never partially serialised. This is the
// single source for both the general logger and the dev introspection annex - see
// core/introspection/DevIntrospection.ts, which re-exports DEFAULT_DENY_KEYS unchanged.
export const DEFAULT_DENY_KEYS = ['password', 'token', 'secret', 'ssn', 'auth', 'cookie', 'session', 'key'] as const;

// Processing budgets, not semantic caps (those are dev-annex filterMeta semantics and stay there).
// Generous by design. The node budget is a WORK bound charged per property read: once exhausted,
// traversal stops - no further property is read - and one '[truncated]' marker stands in for
// everything unvisited. Metadata is never passed through unredacted because it was too big to walk.
const DEPTH_CAP = 32;
const NODE_BUDGET = 10_000;
const ARRAY_CAP = 1_000;

export function isDeniedKey(key: string, denyKeys: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return denyKeys.some((deny) => lower.includes(deny));
}

export type RedactOptions = {
  /** Skip `stack`/`*Stack` keys BEFORE reading them - the logger's one guarded traversal does
   * stack filtering and denylist redaction together, so no unguarded walk precedes this one. */
  stripStackKeys?: boolean;
};

const isStackKey = (key: string): boolean => key === 'stack' || key.endsWith('Stack');

/**
 * Total function: never throws, whatever the metadata does. Denied keys are rejected BEFORE their
 * values are read, so a denied getter never executes (and with `stripStackKeys`, so does a stack
 * getter); a permitted getter that throws yields '[unreadable]'; an object that defeats inspection
 * (hostile or revoked proxy) yields '[unredactable]'. Errors are projected explicitly
 * (name/message/stack are non-enumerable and a plain rebuild would flatten them to {}); Dates are
 * rebuilt without expando properties; every other object - class instances included - is projected
 * through the same deny-before-read walk, so no inspectable object reaches a sink carrying denied
 * properties.
 */
export function redactDeniedKeys(value: unknown, denyKeys: readonly string[] = DEFAULT_DENY_KEYS, options: RedactOptions = {}): unknown {
  try {
    return walk(value, denyKeys, options, 0, { nodes: NODE_BUDGET }, new WeakSet<object>());
  } catch {
    return '[unredactable]';
  }
}

function walk(value: unknown, denyKeys: readonly string[], options: RedactOptions, depth: number, budget: { nodes: number }, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  if (depth >= DEPTH_CAP) return '[depth]';
  if (budget.nodes <= 0) return '[truncated]';
  seen.add(value as object);

  // Even the type dispatch can throw on a revoked proxy (Array.isArray, instanceof both consult
  // its traps) - a node that defeats inspection is replaced, never allowed to escape the walk.
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      const limit = Math.min(value.length, ARRAY_CAP);
      for (let i = 0; i < limit; i += 1) {
        if (budget.nodes-- <= 0) {
          out.push('[truncated]');
          return out;
        }
        let v: unknown;
        try {
          v = value[i];
        } catch {
          out.push('[unreadable]');
          continue;
        }
        out.push(walk(v, denyKeys, options, depth + 1, budget, seen));
      }
      if (value.length > ARRAY_CAP) out.push('[truncated]');
      return out;
    }

    if (value instanceof Error) {
      const out: Record<string, unknown> = options.stripStackKeys
        ? { name: value.name, message: value.message }
        : { name: value.name, message: value.message, stack: value.stack };
      return projectOwnKeys(value, out, denyKeys, options, depth, budget, seen);
    }

    if (value instanceof Date) return new Date(value.getTime());

    return projectOwnKeys(value as object, {}, denyKeys, options, depth, budget, seen);
  } catch {
    return '[unredactable]';
  }
}

/**
 * Deny-before-read projection of own enumerable keys. Budget is charged per key BEFORE its value
 * is read; on exhaustion the remaining keys are left unread behind one '[truncated]' entry.
 */
function projectOwnKeys(
  source: object,
  out: Record<string, unknown>,
  denyKeys: readonly string[],
  options: RedactOptions,
  depth: number,
  budget: { nodes: number },
  seen: WeakSet<object>,
): unknown {
  let keys: string[];
  try {
    keys = Object.keys(source);
  } catch {
    return '[unredactable]';
  }
  for (const k of keys) {
    if (isDeniedKey(k, denyKeys)) continue;
    if (options.stripStackKeys && isStackKey(k)) continue;
    if (budget.nodes-- <= 0) {
      out['[truncated]'] = true;
      return out;
    }
    let v: unknown;
    try {
      v = (source as Record<string, unknown>)[k];
    } catch {
      out[k] = '[unreadable]';
      continue;
    }
    out[k] = walk(v, denyKeys, options, depth + 1, budget, seen);
  }
  return out;
}
