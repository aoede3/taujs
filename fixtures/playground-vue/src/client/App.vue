<script setup lang="ts">
import { computed, inject } from 'vue';

import HomePage from './HomePage.vue';
import StreamingPage from './StreamingPage.vue';
import { PLAYGROUND_KEY } from './setup-app';

const props = defineProps<{ location?: string }>();

// Server passes `location`; on the client fall back to the current path so hydration matches.
const path = computed(() => props.location ?? (typeof window !== 'undefined' ? window.location.pathname : '/'));
const isStreaming = computed(() => path.value.startsWith('/streaming'));

// Provided by setupApp on both server and client — presence proves the hook ran on this path.
const playgroundName = inject(PLAYGROUND_KEY, 'no-setup-app');
</script>

<template>
  <main class="app">
    <h1>τjs Vue playground <small>(setupApp: {{ playgroundName }})</small></h1>
    <nav><a href="/">/ (ssr)</a> · <a href="/streaming">/streaming</a></nav>

    <Suspense v-if="isStreaming">
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
