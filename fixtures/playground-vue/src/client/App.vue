<script setup lang="ts">
import { computed, inject, ref } from 'vue';

import DeferredPage from './DeferredPage.vue';
import HomePage from './HomePage.vue';
import StreamingPage from './StreamingPage.vue';
import { PLAYGROUND_KEY } from './setup-app';

const props = defineProps<{ location?: string }>();

// Server passes `location`; on the client fall back to the current path so hydration matches.
const path = computed(() => props.location ?? (typeof window !== 'undefined' ? window.location.pathname : '/'));
const isStreaming = computed(() => path.value.startsWith('/streaming'));
const isDeferred = computed(() => path.value.startsWith('/deferred'));

// Provided by setupApp on both server and client — presence proves the hook ran on this path.
const playgroundName = inject(PLAYGROUND_KEY, 'no-setup-app');

// Proves hydration by EXECUTED BEHAVIOUR rather than markup: the server renders `count: 0`, and
// only a hydrated, interactive root can turn a click into `count: 1`.
const count = ref(0);
</script>

<template>
  <main class="app">
    <h1>
      τjs Vue playground <small>(setupApp: {{ playgroundName }})</small>
    </h1>
    <nav><a href="/">/ (ssr)</a> · <a href="/streaming">/streaming</a> · <a href="/deferred">/deferred</a></nav>

    <button id="counter" type="button" @click="count += 1">count: {{ count }}</button>

    <Suspense v-if="isDeferred">
      <template #default>
        <DeferredPage />
      </template>
      <template #fallback>
        <p id="reviews-pending">loading reviews</p>
      </template>
    </Suspense>
    <Suspense v-else-if="isStreaming">
      <template #default>
        <StreamingPage />
      </template>
      <template #fallback>
        <p class="fallback">Streaming… waiting on the server.</p>
      </template>
    </Suspense>
    <HomePage v-else />
  </main>
</template>
