// A service method's params must be a JSON object type; an `interface` has no implicit index
// signature, so `defineService()` rejects it at the definition, on the offending property.
//
// Type-level test: enforced by `pnpm --filter @taujs/server typecheck` (tsc); the `.test-d.ts`
// suffix is outside vitest's test glob so it never runs as a spec.
import { createServiceData } from '../ServiceData';
import { createCaller, defineService, defineServiceRegistry } from '../DataServices';

import type { RouteParams } from '../../config/types';
import type { ServiceDataRequestFacts } from '../ServiceData';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- Arm a: an interface-typed params method fails AT THE DEFINITION, named on its own property. ---
interface SearchParams {
  q: string;
  page: number;
}

const bad = defineService({
  // @ts-expect-error - an interface without an index signature is not a JSON object type
  byInterface: async (params: SearchParams) => ({ hits: params.q.length + params.page }),
});

type _DiagnosticArm = Expect<
  Equal<
    typeof bad.byInterface,
    {
      readonly __taujsServiceTypeError: 'params must be a JSON object type; an interface without an index signature is not accepted, so use a type alias or an inline object type';
    }
  >
>;
type _NotNeverArm = Expect<Equal<[typeof bad.byInterface] extends [never] ? true : false, false>>;

// --- Arm b: alias, zero-arg and `{ params, handler }` schema forms are unaffected. ---
type Alias = { q: string; page: number };

const good = defineService({
  byAlias: async (params: Alias) => ({ hits: params.q.length + params.page }),
  zeroArg: async () => ({ ok: true as const }),
  withSchema: {
    params: (u: unknown) => u as Alias,
    handler: async (params: Alias) => ({ hits: params.q.length }),
  },
});

type _AliasParamsArm = Expect<Equal<Parameters<typeof good.byAlias>[0], Alias>>;
type _AliasResultArm = Expect<Equal<Awaited<ReturnType<typeof good.byAlias>>, { hits: number }>>;
type _ZeroArgResultArm = Expect<Equal<Awaited<ReturnType<typeof good.zeroArg>>, { ok: true }>>;
type _WithSchemaResultArm = Expect<Equal<Awaited<ReturnType<typeof good.withSchema>>, { hits: number }>>;

// --- Arm c: registry call sites are checked per method. ---
const reg = defineServiceRegistry({ good });
const call = createCaller(reg, {});

void call('good', 'byAlias', { q: 'a', page: 1 });
void call('good', 'zeroArg', {});
// @ts-expect-error - args must match the method's declared params
void call('good', 'byAlias', { slug: 'a' });

// --- Arm d: the serviceData() mapper keeps method-specific params typing (instantiation expression). ---
const sd = createServiceData<typeof reg>();

type _MapperArm = Expect<Equal<Parameters<typeof sd<'good', 'byAlias'>>[2], (params: RouteParams, facts: ServiceDataRequestFacts) => Alias>>;

// --- Arm e: a spec holding the diagnostic is not a ServiceRegistry. ---
// @ts-expect-error - a spec holding the diagnostic is not a ServiceRegistry
createServiceData<Readonly<{ bad: typeof bad }>>();

// --- Arm f: an interface-typed RESULT still fails at the definition (unchanged). ---
interface Hits {
  count: number;
}

defineService({
  // @ts-expect-error - an interface without an index signature is not a JSON object type
  byInterfaceResult: async (params: Alias): Promise<Hits> => ({ count: params.q.length }),
});

// Keep tsc's noUnusedLocals honest.
export type _Proof = [_DiagnosticArm, _NotNeverArm, _AliasParamsArm, _AliasResultArm, _ZeroArgResultArm, _WithSchemaResultArm, _MapperArm];
