<script setup lang="ts">
import { useSSRDataAsync } from '@taujs/vue';

type Data = { message: string; timestamp: string };

// Suspense idiom (blocking): async setup awaits the data, so the streamed route delivers it
// into the payload and blocks the stream until it resolves.
const data = await useSSRDataAsync<Data>();
</script>

<template>
  <section class="card" data-route="streaming">
    <p class="message">{{ data.message }}</p>
    <p class="meta">Streaming · {{ data.timestamp }}</p>
  </section>
</template>
