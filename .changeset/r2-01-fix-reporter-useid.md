---
'@taujs/react': patch
---

Fix: the internal hydration commit reporter now WRAPS the app instead of sitting beside it.

React's `useId` is tree-position sensitive: a SIBLING of the app shifts every `useId` value in the app,
so the sibling reporter introduced with the hydration-observability work made the client tree's ids
diverge from the SSR markup (which renders the app without it) - a hydration mismatch for any app using
`useId`. The reporter is now a pass-through wrapper: it adds tree DEPTH only (which `useId` ignores) and
no extra DOM, so a `useId` app hydrates with no mismatch. First-commit detection (onSuccess /
hydration:success) is unchanged.
