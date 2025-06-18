import { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

import React from 'react';
import { renderToPipeableStream, renderToString } from 'react-dom/server';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';

type RendererOptions = {
  appComponent: (props: { location: string }) => React.ReactElement;
  headContent: string | ((data: Record<string, unknown>) => string);
};

type RenderCallbacks = {
  onHead: (headContent: string) => void;
  onFinish: (initialDataPromise: unknown) => void;
  onError: (error: unknown) => void;
};

export const resolveHeadContent = (headContent: string | ((meta: Record<string, unknown>) => string), meta: Record<string, unknown> = {}): string =>
  typeof headContent === 'function' ? headContent(meta) : headContent;

export const createRenderer = ({ appComponent, headContent }: RendererOptions) => {
  const renderSSR = async (initialDataPromise: Record<string, unknown>, location: string, meta: Record<string, unknown> = {}) => {
    const dataForHeadContent = Object.keys(initialDataPromise).length > 0 ? initialDataPromise : meta;
    const dynamicHeadContent = resolveHeadContent(headContent, dataForHeadContent);
    const appHtml = renderToString(<SSRStoreProvider store={createSSRStore(initialDataPromise)}>{appComponent({ location })}</SSRStoreProvider>);

    return {
      headContent: dynamicHeadContent,
      appHtml,
    };
  };

  const renderStream = (
    serverResponse: ServerResponse,
    callbacks: RenderCallbacks,
    initialDataPromise: Record<string, unknown>,
    location: string,
    bootstrapModules?: string,
    meta: Record<string, unknown> = {},
  ) => {
    const dynamicHeadContent = resolveHeadContent(headContent, meta);

    createRenderStream(serverResponse, callbacks, {
      appComponent: (props) => appComponent({ ...props, location }),
      headContent: dynamicHeadContent,
      initialDataPromise,
      location,
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
    initialDataPromise,
    location,
    bootstrapModules,
  }: RendererOptions & { initialDataPromise: Record<string, unknown>; location: string; bootstrapModules?: string },
): void => {
  const store = createSSRStore(initialDataPromise);
  const appElement = <SSRStoreProvider store={store}>{appComponent({ location })}</SSRStoreProvider>;

  const { pipe } = renderToPipeableStream(appElement, {
    bootstrapModules: bootstrapModules ? [bootstrapModules] : undefined,

    onShellReady() {
      Promise.resolve(initialDataPromise).then((resolvedData) => {
        const dynamicHeadContent = resolveHeadContent(headContent, resolvedData);
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
      });
    },

    onAllReady() {},

    onError(error: unknown) {
      onError(error);
    },
  });
};
