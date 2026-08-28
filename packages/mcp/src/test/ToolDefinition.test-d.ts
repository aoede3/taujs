// Type-level test: enforced by `pnpm --filter @taujs/mcp typecheck` (tsc over src/**); the
// `.test-d.ts` suffix is outside vitest's test glob so it never runs as a spec. `defineTool`
// must type a handler's args from its own `z.object` schema - not from the broad default - so a
// field the schema never declared is a compile error, not a silent `undefined` at runtime.
import { z } from 'zod';

import { defineTool } from '../toolkit';

// --- Positive: the handler's args are inferred from its own schema. ---
defineTool({
  name: 'taujs_x',
  title: 't',
  description: 'd',
  inputSchema: z.object({ a: z.string(), n: z.number().optional() }),
  handler: (args) => ({ a: args.a.toUpperCase(), n: args.n ?? 0 }),
});

// --- Negative: a field the schema never declared. ---
defineTool({
  name: 'taujs_x',
  title: 't',
  description: 'd',
  inputSchema: z.object({ a: z.string() }),
  // @ts-expect-error - a field the schema never declared
  handler: (args) => ({ v: args.nope }),
});
