---
'@taujs/react': minor
'@taujs/vue': minor
---

Remove the deprecated `onFinish` callback alias from `renderStream`'s callbacks. Use `onAllReady`, which receives the same data at the same moment.

**BREAKING CHANGE** (released as `minor` under the repository's pre-1.0 convention - these packages are pre-1 and a `major` bump would declare τjs stable 1.0, which this work does not decide). `@taujs/server` never passed `onFinish`, so only code that calls `renderStream` directly is affected.

```ts
// before
renderStream(sink, { onHead, onFinish: (data) => seed(data) }, initialData, location);

// after
renderStream(sink, { onHead, onAllReady: (data) => seed(data) }, initialData, location);
```
