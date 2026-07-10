// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, Suspense, type Component } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import {
  createSSRStore,
  SSRStoreProvider,
  useSSRData,
  useSSRDataAsync,
  useSSRReady,
  useSSRStatus,
  useSSRStore,
  type SSRStore,
} from '../SSRDataStore';
import * as pkg from '..';

const mountWithStore = (child: Component, store: SSRStore<any>) =>
  mount(
    defineComponent({
      render() {
        return h(SSRStoreProvider, { store }, { default: () => h(child) });
      },
    }),
  );

const mountWithStoreSuspense = (child: Component, store: SSRStore<any>) =>
  mount(
    defineComponent({
      render() {
        return h(SSRStoreProvider, { store }, { default: () => h(Suspense, null, { default: () => h(child) }) });
      },
    }),
  );

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe('createSSRStore — initialisation forms', () => {
  it('sync value initialises to success immediately', async () => {
    const store = createSSRStore({ a: 1 });
    expect(store.status.value).toBe('success');
    expect(store.getSnapshot()).toEqual({ a: 1 });
    await expect(store.ready).resolves.toBeUndefined();
  });

  it('promise value is pending then success', async () => {
    const store = createSSRStore(Promise.resolve({ b: 2 }));
    expect(store.status.value).toBe('pending');
    await store.ready;
    expect(store.status.value).toBe('success');
    expect(store.getSnapshot()).toEqual({ b: 2 });
  });

  it('thunk value is pending then success', async () => {
    const store = createSSRStore(() => Promise.resolve({ c: 3 }));
    expect(store.status.value).toBe('pending');
    await store.ready;
    expect(store.getSnapshot()).toEqual({ c: 3 });
  });
});

describe('createSSRStore — errors & recovery', () => {
  it('rejected promise sets error status, lastError, and rejects ready', async () => {
    const store = createSSRStore(Promise.reject(new Error('load fail')));
    await expect(store.ready).rejects.toThrow('load fail');
    expect(store.status.value).toBe('error');
    expect(store.lastError.value).toBeInstanceOf(Error);
    expect(store.lastError.value?.message).toBe('load fail');
  });

  it('normalises a non-Error rejection into an Error', async () => {
    const store = createSSRStore(Promise.reject('string failure'));
    await expect(store.ready).rejects.toBeTruthy();
    expect(store.lastError.value).toBeInstanceOf(Error);
    expect(store.lastError.value?.message).toContain('string failure');
  });

  it('setData resolves a still-pending ready and flips to success (recovery path)', async () => {
    const store = createSSRStore<{ v: number }>(new Promise<{ v: number }>(() => {})); // never settles
    expect(store.status.value).toBe('pending');

    store.setData({ v: 42 });

    expect(store.status.value).toBe('success');
    expect(store.getSnapshot()).toEqual({ v: 42 });
    await expect(store.ready).resolves.toBeUndefined();
  });
});

describe('createSSRStore — subscribe', () => {
  it('notifies subscribers on data change and stops after unsubscribe', () => {
    const store = createSSRStore<{ n: number }>(new Promise<{ n: number }>(() => {}));
    const cb = vi.fn();
    const off = store.subscribe(cb);

    store.setData({ n: 1 });
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    store.setData({ n: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('F7 — snapshot identity (shallowReadonly)', () => {
  it('getSnapshot() and the reactive data ref both preserve object identity with the input', () => {
    const input = { a: 1 };
    const store = createSSRStore(input);
    expect(store.getSnapshot()).toBe(input);
    expect(store.data.value).toBe(input);
  });

  it('useSSRData().value preserves identity with the input inside a component', () => {
    const input = { a: 1 };
    const store = createSSRStore(input);
    let captured: unknown;

    mountWithStore(
      defineComponent({
        setup() {
          captured = useSSRData<{ a: number }>().value;
          return () => h('div');
        },
      }),
      store,
    );

    expect(captured).toBe(input);
  });

  it('the exposed data ref is read-only at the top level (writes are ignored, not applied)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createSSRStore({ a: 1 });

    store.data.value = { a: 99 }; // shallowReadonly ignores this at runtime and warns

    expect(store.getSnapshot()).toEqual({ a: 1 });
    expect(store.data.value).toEqual({ a: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('provide / inject', () => {
  it('useSSRStore returns the provided store inside a provider', () => {
    const store = createSSRStore({ a: 1 });
    let injected: unknown;
    mountWithStore(
      defineComponent({
        setup() {
          injected = useSSRStore();
          return () => h('div');
        },
      }),
      store,
    );
    expect(injected).toBe(store);
  });

  it('useSSRStore throws when used outside a provider', () => {
    const Bad = defineComponent({
      setup() {
        useSSRStore();
        return () => h('div');
      },
    });
    expect(() => mount(Bad)).toThrow('useSSRStore must be used within a SSRStoreProvider');
  });
});

describe('composables', () => {
  it('useSSRData exposes a non-throwing fallback (undefined while pending, value after)', async () => {
    const store = createSSRStore<{ msg: string }>(Promise.resolve({ msg: 'hi' }));
    const values: Array<unknown> = [];

    mountWithStore(
      defineComponent({
        setup() {
          const data = useSSRData<{ msg: string }>();
          return () => {
            values.push(data.value);
            return h('div', data.value?.msg ?? 'pending');
          };
        },
      }),
      store,
    );

    expect(values[0]).toBeUndefined();
    await flushPromises();
    expect(store.getSnapshot()).toEqual({ msg: 'hi' });
  });

  it('useSSRDataAsync resolves data inside async setup under <Suspense>', async () => {
    const store = createSSRStore(() => Promise.resolve({ msg: 'ready' }));

    const wrapper = mountWithStoreSuspense(
      defineComponent({
        async setup() {
          const data = await useSSRDataAsync<{ msg: string }>();
          return () => h('div', { class: 'out' }, data.msg);
        },
      }),
      store,
    );

    await flushPromises();
    expect(wrapper.get('.out').text()).toBe('ready');
  });

  it('useSSRDataAsync rejects when the store data fails', async () => {
    const store = createSSRStore<{ x: number }>(() => Promise.reject(new Error('nope')));
    let captured: unknown;

    mountWithStoreSuspense(
      defineComponent({
        async setup() {
          try {
            await useSSRDataAsync();
          } catch (e) {
            captured = e;
          }
          return () => h('div');
        },
      }),
      store,
    );

    await flushPromises();
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('nope');
  });

  it('useSSRReady resolves once data is ready', async () => {
    const store = createSSRStore(() => Promise.resolve({ ok: true }));
    let resolved = false;

    mountWithStore(
      defineComponent({
        async setup() {
          await useSSRReady();
          resolved = true;
          return () => h('div');
        },
      }),
      store,
    );

    await flushPromises();
    expect(resolved).toBe(true);
  });

  it('useSSRStatus reflects the store status reactively', async () => {
    const store = createSSRStore(() => Promise.resolve({ ok: true }));
    let statusRef: any;

    mountWithStore(
      defineComponent({
        setup() {
          statusRef = useSSRStatus();
          return () => h('div');
        },
      }),
      store,
    );

    expect(statusRef.value).toBe('pending');
    await flushPromises();
    expect(statusRef.value).toBe('success');
  });
});

describe('public surface (V1-01 removals)', () => {
  it('no longer exports the removed React-ism symbols', () => {
    expect('useSSRDataOrSuspend' in pkg).toBe(false);
    expect('getSnapshotOrThrow' in pkg).toBe(false);
  });

  it('the store object has no getSnapshotOrThrow method', () => {
    const store = createSSRStore({ a: 1 }) as Record<string, unknown>;
    expect('getSnapshotOrThrow' in store).toBe(false);
    expect(typeof store.getSnapshot).toBe('function');
  });

  it('still exports the Vue-native store surface', () => {
    for (const name of ['createSSRStore', 'SSRStoreProvider', 'SSR_STORE_KEY', 'useSSRStore', 'useSSRData', 'useSSRDataAsync', 'useSSRReady', 'useSSRStatus']) {
      expect(name in pkg, `missing export: ${name}`).toBe(true);
    }
  });
});
