import { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

import React from 'react';
import { renderToPipeableStream } from 'react-dom/server';

import { createSSRStore, SSRStoreProvider } from './SSRDataStore';

type StreamRenderOptions = {
  appComponent: React.ReactElement;
  initialDataPromise: Promise<Record<string, unknown>>;
  bootstrapModules: string;
  headContent: string;
};

type RenderCallbacks = {
  onHead: (headContent: string) => void;
  onFinish: (initialDataResolved: unknown) => void;
  onError: (error: unknown) => void;
};

export const createStreamRenderer = (
  serverResponse: ServerResponse,
  { onHead, onFinish, onError }: RenderCallbacks,
  { appComponent, initialDataPromise, bootstrapModules, headContent }: StreamRenderOptions,
): void => {
  const store = createSSRStore(initialDataPromise);
  const appElement = <SSRStoreProvider store={store}>{appComponent}</SSRStoreProvider>;

  const { pipe } = renderToPipeableStream(appElement, {
    bootstrapModules: [bootstrapModules],

    onShellReady() {
      onHead(headContent);

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
