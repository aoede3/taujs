import { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

import React from 'react';
import { renderToPipeableStream } from 'react-dom/server';

import type { RenderCallbacks } from './SSRServer';

type StreamRender = {
  appElement: React.JSX.Element;
  bootstrapModules: string;
  headContent: string;
  getStoreSnapshot: () => unknown;
};

export const createStreamRenderer = (
  serverResponse: ServerResponse,
  { onHead, onFinish, onError }: RenderCallbacks,
  { appElement, bootstrapModules, headContent, getStoreSnapshot }: StreamRender,
) => {
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
            onFinish(getStoreSnapshot());
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
