---
'@taujs/react': patch
---

R3-02: three contained hygiene fixes in the store and utils.

- **Error normalisation.** A rejected data load that threw a STRING produced a quoted message
  (`'"boom"'`), and one that threw a CIRCULAR object made `JSON.stringify` THROW inside the store's
  error handler - turning a data-load failure into an unhandled rejection. The store now normalises via
  the same pattern as `@taujs/vue`: an `Error` passes through unchanged, a string keeps its message
  unquoted, an object is JSON-stringified, and an unserialisable value falls back to `String(error)`
  without throwing.
- **`useSSRStore` reads the store directly.** Removed `useMemo(() => deferred, [deferred])` (an identity
  memo - a no-op by definition) and `useDeferredValue`, which was introduced with no stated rationale, is
  relied on by no test, has no `@taujs/vue` equivalent, and measurably cost an extra render pass per
  update while serving one-render-stale data. Consumers now observe `setData` immediately. The Suspense
  path is unaffected (suspension happens inside `useSyncExternalStore`, before any value reaches the
  removed hooks).
- Deleted the dead `utils/index.ts` barrel (`export * from './'` - self-referential, exported nothing,
  imported by nothing).
