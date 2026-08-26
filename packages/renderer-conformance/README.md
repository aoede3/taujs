# Renderer conformance vectors

Shared, framework-free test data for invariants that every τjs renderer must hold identically.

**Not a package.** There is no `package.json`, so pnpm's `packages/*` glob skips it, nothing is
published, and nothing here ships. It is a plain source directory imported by relative path from
each renderer's own test suite, exactly as `fixtures/test-support/` is imported by the fixtures.

## Why this exists

The renderers are deliberately **pattern-parity, not byte-parity**: `@taujs/react`, `@taujs/vue`
and `@taujs/solid` reimplement the same shapes rather than sharing code, and that is a ruled
decision, not an accident. The cost is that a fix applied to one is not applied to the others, and
nothing notices. The `shellTimeoutMs` validation this directory starts with was the proof: solid
validated at the factory AND refused to arm a timer for a sentinel value; react and vue did
neither, for the whole life of the option.

A conformance vector is the only mechanism that holds an invariant across implementations that
deliberately do not share code. It is not a substitute for each renderer's own tests - it is the
part they must agree on.

## The reference implementation failed its own vector

Worth recording, because it is the clearest argument for this directory existing at all.

`shellTimeout.ts` was written from `@taujs/solid`, which was the only renderer that already
validated the option - so solid was, in effect, the reference. Its first version accepted "any
positive finite number", which was wrong: Node stores a delay as a 32-bit signed integer, so
2_147_483_648 is clamped to 1ms and warned about, exactly like `Infinity`. Review caught the
omission and the vector gained an upper bound.

Run against the merge base, the corrected vector failed **all three** renderers - including solid,
the implementation it had been derived from. Two cells, in the file that was supposed to be the
standard.

Two things follow. A vector written by reading one implementation inherits that implementation's
blind spots, so the contract has to be argued from the RUNTIME (what Node actually does with the
value) rather than from whichever renderer looks most complete. And a vector is worth having even
when every renderer is believed to agree already: agreeing on the wrong thing is the failure mode
it exists to catch, and here it caught one.

## Rules for anything added here

- **Zero imports.** No `vitest`, no framework, no package-local types. This directory has no
  `node_modules` of its own, so a bare import may not resolve from every consumer; and a vector
  that depends on a test framework cannot be run by a renderer that ever chooses a different one.
  Export data, pure functions, and - where an invariant is only observable at runtime - zero-import
  PROBES that return their observations (`collectProcessWarnings` listens on `process.warning`,
  because the 1ms clamp is visible nowhere else). What is forbidden is a shared TEST-FRAMEWORK
  runner, not asynchrony: every one of these hands its result back for the calling suite to assert.
- **Environment-agnostic.** React and vue run under `jsdom`, solid under `node` with
  `--expose-gc`. A vector must not assume either. This is also why there is no shared runner: each
  renderer invokes the vectors from its own suite, in its own environment.
- **One invariant per file**, named for the invariant rather than for the renderer.
- **Adding a vector is a contract change.** If a renderer cannot satisfy it, that is a finding to
  rule on, not a reason to weaken the vector.
