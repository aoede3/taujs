<script setup lang="ts">
import { createDeferredAccessor } from '@taujs/vue';

import type { DeferredRouteData } from '../server/routes/deferred.ts';

/**
 * RFC 0007: the ROUTE-DECLARED deferred read.
 *
 * The accessor is typed from the route config alone - `DeferredDataOf<typeof deferredRoute>` - so
 * the payload shape is never re-declared here. The component starts nothing: the host began this
 * work before the render, and the result read only projects the named promise onto Vue's own async
 * `setup()`, which the parent `<Suspense>` awaits.
 *
 * The RESULT read is the one to reach for: Vue renders each subtree once, so a handled `failed` or
 * `aborted` branch renders INTO the response rather than only on the client.
 */
const deferred = createDeferredAccessor<DeferredRouteData>();
const outcome = await deferred.result('reviews');
</script>

<template>
  <p v-if="outcome.status === 'complete'" id="reviews">reviews: {{ outcome.value.count }} - {{ outcome.value.top }}</p>
  <p v-else id="reviews-error">reviews unavailable ({{ outcome.status }})</p>
</template>
