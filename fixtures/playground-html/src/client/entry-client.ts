import { onDataReady } from '@taujs/html/client';

type ContentData = { message?: string; timestamp?: string };
type DeferredData = { reviews: { count: number; top: string }; neverResolves: Record<string, unknown> };

// The whole client story: read the snapshot + the typed deferred envelope once, then enhance the
// server-rendered HTML in place. No hydration, no framework, no DOM diffing.
onDataReady<ContentData, DeferredData>(({ data, deferred }) => {
  const root = document.getElementById('root');
  if (!root) return;

  const messageEl = document.getElementById('message');
  if (messageEl && data?.message) messageEl.textContent = data.message;

  if (deferred) {
    for (const key of Object.keys(deferred) as (keyof DeferredData)[]) {
      const outcome = deferred[key];
      const el = document.createElement('p');
      el.id = key;
      el.textContent = outcome.status === 'complete' ? JSON.stringify(outcome.value) : outcome.status;
      root.appendChild(el);
    }
  }
});
