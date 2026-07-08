import { ref, onMounted, type Ref } from 'vue';
import { fetchRouteData, readInitialDataOnce, getCurrentPath, type RouteData } from './RouteData';

export type RouteClientData<T> = {
  data: Ref<T | null>;
  pending: Ref<boolean>;
  error: Ref<unknown | null>;
  refresh: () => Promise<void>;
};

/**
 * Client-side data fetching for progressive streaming.
 *
 * Server: Returns immediately with data=null (renders fallback)
 * Client: Fetches via /__taujs/data after hydration (swaps to content)
 *
 * This enables shell-first streaming without blocking SSR on async data.
 * The component renders a fallback on the server, then fetches and updates
 * on the client.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useRouteClientData } from '@taujs/vue';
 *
 * type MyData = { message: string };
 * const { data, pending, error } = useRouteClientData<MyData>();
 * </script>
 *
 * <template>
 *   <div v-if="data">{{ data.message }}</div>
 *   <div v-else-if="pending">Loading...</div>
 *   <div v-else-if="error">Failed to load</div>
 * </template>
 * ```
 */
export function useRouteClientData<T extends RouteData>(): RouteClientData<T> {
  const data: Ref<T | null> = ref<T | null>(null) as Ref<T | null>;
  const pending = ref(false);
  const error = ref<unknown | null>(null);

  async function refresh() {
    // Server-safe: do nothing on SSR
    if (typeof window === 'undefined') return;

    pending.value = true;
    error.value = null;

    try {
      // First paint after SSR: use boot data if present
      const boot = readInitialDataOnce<T>();
      if (boot !== null) {
        data.value = boot;
        return;
      }

      // Navigation / no boot data: fetch from /__taujs/data
      const path = getCurrentPath();
      if (!path) throw new Error('useRouteClientData: No current path available');

      data.value = await fetchRouteData<T>(path);
    } catch (e) {
      error.value = e;
    } finally {
      pending.value = false;
    }
  }

  // Only runs on client after hydration
  onMounted(() => {
    void refresh();
  });

  return { data, pending, error, refresh };
}
