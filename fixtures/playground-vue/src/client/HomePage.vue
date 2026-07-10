<script setup lang="ts">
import { useSSRData } from '@taujs/vue';

type Data = { message: string; timestamp: string };

// Fallback idiom (non-blocking): undefined until ready, guarded with v-if.
const data = useSSRData<Data>();
</script>

<template>
  <section v-if="data" class="card" data-route="ssr">
    <p class="message">{{ data.message }}</p>
    <p class="meta">SSR · {{ data.timestamp }}</p>
  </section>
  <section v-else class="card">Loading…</section>
</template>
