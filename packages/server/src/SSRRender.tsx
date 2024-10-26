import { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

import React from 'react';
import { renderToPipeableStream, renderToString } from 'react-dom/server';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';

type RendererOptions = {
  appComponent: React.ReactElement;
  headContent: string | ((data: Record<string, unknown>) => string);
};

type RenderCallbacks = {
  onHead: (headContent: string) => void;
  onFinish: (initialDataResolved: unknown) => void;
  onError: (error: unknown) => void;
};

export const resolveHeadContent = (headContent: string | ((data: Record<string, unknown>) => string), initialDataResolved: Record<string, unknown>): string => {
  return typeof headContent === 'function' ? headContent(initialDataResolved) : headContent;
};

export const createRenderer = ({ appComponent, headContent }: RendererOptions) => {
  const renderSSR = async (initialDataResolved: Record<string, unknown>) => {
    const dynamicHeadContent = resolveHeadContent(headContent, initialDataResolved);
    const appHtml = renderToString(<SSRStoreProvider store={createSSRStore(Promise.resolve(initialDataResolved))}>{appComponent}</SSRStoreProvider>);

    return {
      headContent: dynamicHeadContent,
      appHtml,
      initialDataScript: `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')}</script>`,
    };
  };

  const renderStream = (
    serverResponse: ServerResponse,
    callbacks: RenderCallbacks,
    initialDataResolved: Record<string, unknown>,
    bootstrapModules?: string,
  ) => {
    const dynamicHeadContent = typeof headContent === 'function' ? headContent(initialDataResolved) : headContent;

    createRenderStream(serverResponse, callbacks, {
      appComponent,
      headContent: dynamicHeadContent,
      initialDataResolved,
      bootstrapModules,
    });
  };

  return { renderSSR, renderStream };
};

export const createRenderStream = (
  serverResponse: ServerResponse,
  { onHead, onFinish, onError }: RenderCallbacks,
  {
    appComponent,
    headContent,
    initialDataResolved,
    bootstrapModules,
  }: RendererOptions & { initialDataResolved: Record<string, unknown>; bootstrapModules?: string },
): void => {
  const store = createSSRStore(Promise.resolve(initialDataResolved));
  const appElement = <SSRStoreProvider store={store}>{appComponent}</SSRStoreProvider>;

  const { pipe } = renderToPipeableStream(appElement, {
    bootstrapModules: bootstrapModules ? [bootstrapModules] : undefined,

    onShellReady() {
      const dynamicHeadContent = resolveHeadContent(headContent, initialDataResolved);
      onHead(dynamicHeadContent);

      pipe(
        new Writable({
          write(chunk, _encoding, callback) {
            serverResponse.write(chunk, callback);
          },

          final(callback) {
            onFinish(store.getSnapshot());
            callback();
          },
        }),
      );
    },

    onAllReady() {},

    onError(error: unknown) {
      onError(error);
    },
  });
};
