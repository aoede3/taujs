// HARD GATE on the PUBLIC ENTRY: this import comes from '../Config', exercising exactly what
// ships as '@taujs/server/config' (the PublicRouteContext.test-d.ts idiom - the internal module
// exporting the type cannot substitute, which is precisely how the first export of this type
// missed the real entry). Proves: `RequestBudget` is a named export of the public config surface,
// carries exactly the four public members, and does NOT expose the internal lifecycle `dispose()`
// - application code must not be able to disable deadline signalling.
// Enforced by `pnpm --filter @taujs/server typecheck` (tsc).
import type { RequestBudget } from '../Config';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const budget: RequestBudget;

type _deadline = Expect<Eq<typeof budget.deadline, number>>;
type _signal = Expect<Eq<typeof budget.signal, AbortSignal>>;
type _remaining = Expect<Eq<ReturnType<typeof budget.remaining>, number>>;
type _child = Expect<Eq<ReturnType<typeof budget.child>, RequestBudget>>;

// The public shape has exactly these four keys - `dispose` is not among them.
type _keys = Expect<Eq<keyof RequestBudget, 'deadline' | 'signal' | 'remaining' | 'child'>>;
