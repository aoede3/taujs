import { createApp, createSSRApp, h, type Component, type VNode } from "vue";

import { createSSRStore, SSRStoreProvider } from "./SSRDataStore";
import { createUILogger } from "./utils/Logger";

import type { LoggerLike } from "./utils/Logger";

export type HydrateAppOptions<T> = {
  /** Root app component. */
  appComponent: Component | (() => VNode);
  rootElementId?: string;
  enableDebug?: boolean;
  logger?: LoggerLike;
  dataKey?: string;
  onHydrationError?: (err: unknown) => void;
  onStart?: () => void;
  onSuccess?: () => void;
};

/**
 * Vue client bootstrap.
 *
 * Behaviour matches taujs/react:
 * - If window[dataKey] is missing, mount CSR (and clear existing DOM).
 * - Otherwise, hydrate SSR markup.
 */
export function hydrateApp<T>({
  appComponent,
  rootElementId = "root",
  enableDebug = false,
  logger,
  dataKey = "__INITIAL_DATA__",
  onHydrationError,
  onStart,
  onSuccess,
}: HydrateAppOptions<T>) {
  const { log, warn, error } = createUILogger(logger, {
    debugCategory: "ssr",
    context: { scope: "vue-hydration" },
    enableDebug,
  });

  const normalizeRoot = (): Component => {
    // Allow passing either a component or a render function.
    if (
      typeof appComponent === "function" &&
      !(appComponent as any).setup &&
      !(appComponent as any).render
    ) {
      return { name: "TauJsRoot", render: appComponent as any };
    }
    return appComponent as Component;
  };

  const mountCSR = (rootEl: HTMLElement, initialData: T) => {
    rootEl.innerHTML = "";

    const store = createSSRStore(initialData);

    const app = createApp({
      name: "TauJsCSR",
      render: () =>
        h(SSRStoreProvider, { store }, { default: () => h(normalizeRoot()) }),
    });

    app.mount(rootEl);
  };

  const startHydration = (rootEl: HTMLElement, initialData: T) => {
    if (enableDebug) log("Hydration started");
    onStart?.();

    if (enableDebug) log("Initial data loaded:", initialData);

    const store = createSSRStore(initialData);
    if (enableDebug) log("Store created:", store);

    try {
      const app = createSSRApp({
        name: "TauJsHydration",
        render: () =>
          h(SSRStoreProvider, { store }, { default: () => h(normalizeRoot()) }),
      });

      // 2nd arg true => hydrate
      app.mount(rootEl, true);

      if (enableDebug) log("Hydration completed");
      onSuccess?.();
    } catch (err) {
      error("Hydration error:", err);
      onHydrationError?.(err);
    }
  };

  const bootstrap = () => {
    const rootEl = document.getElementById(rootElementId);
    if (!rootEl) {
      error(`Root element with id "${rootElementId}" not found.`);
      return;
    }

    const data = (window as any)[dataKey] as T | undefined;

    if (data === undefined) {
      const empty = {} as T;
      if (enableDebug)
        warn(`No initial SSR data at window["${dataKey}"]. Mounting CSR.`);
      mountCSR(rootEl, empty);
      return;
    }

    startHydration(rootEl, data);
  };

  if (document.readyState !== "loading") {
    bootstrap();
  } else {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  }
}
