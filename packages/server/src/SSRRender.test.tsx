import { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';

import { renderToPipeableStream } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { createStreamRenderer } from './SSRRender';

import type { Mock } from 'vitest';

vi.mock('react-dom/server', () => ({
  renderToPipeableStream: vi.fn(),
}));

describe('createStreamRenderer', () => {
  it('should render the stream and call callbacks correctly', async () => {
    const mockAppElement = <div>Test</div>;
    const mockBootstrapModules = 'test-module';
    const mockHeadContent = '<title>Test</title>';
    const mockStoreSnapshot = { data: 'test' };

    const onHead = vi.fn();
    const onFinish = vi.fn();
    const onError = vi.fn();

    const serverResponse = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(callback);
      },
    });

    const writeSpy = vi.spyOn(serverResponse, 'write');

    const onFinishPromise = new Promise<void>((resolve) => {
      onFinish.mockImplementation(() => {
        resolve();
      });
    });

    const renderToPipeableStreamMock = vi.fn((_appElement: React.JSX.Element, options: any) => {
      const stream = {
        pipe: (writable: Writable) => {
          writable.write(Buffer.from('Test chunk'), (err) => {
            if (err) throw err;
            writable.end();
          });
        },
      };

      setImmediate(() => {
        options.onShellReady();
        options.onAllReady();
      });

      return stream;
    });

    (renderToPipeableStream as Mock).mockImplementation(renderToPipeableStreamMock);

    createStreamRenderer(
      serverResponse as any,
      { onHead, onFinish, onError },
      {
        appElement: mockAppElement,
        bootstrapModules: mockBootstrapModules,
        headContent: mockHeadContent,
        getStoreSnapshot: () => mockStoreSnapshot,
      },
    );

    await onFinishPromise;

    expect(renderToPipeableStreamMock).toHaveBeenCalled();
    expect(onHead).toHaveBeenCalledWith(mockHeadContent);

    const chunk = Buffer.from('Test chunk');
    expect(writeSpy).toHaveBeenCalledWith(chunk, expect.any(Function));

    expect(onFinish).toHaveBeenCalledWith(mockStoreSnapshot);
  });

  it('should handle errors in rendering', () => {
    const mockAppElement = <div>Test</div>;
    const mockBootstrapModules = 'test-module';
    const mockHeadContent = '<title>Test</title>';
    const mockStoreSnapshot = { data: 'test' };

    const serverResponse = {
      write: vi.fn(),
    } as unknown as ServerResponse;

    const onHead = vi.fn();
    const onFinish = vi.fn();
    const onError = vi.fn();

    (renderToPipeableStream as any).mockImplementation((_appElement: JSX.Element, { onError }: any) => {
      onError(new Error('Test Error'));
      return { pipe: vi.fn() };
    });

    createStreamRenderer(
      serverResponse,
      { onHead, onFinish, onError },
      {
        appElement: mockAppElement,
        bootstrapModules: mockBootstrapModules,
        headContent: mockHeadContent,
        getStoreSnapshot: () => mockStoreSnapshot,
      },
    );

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0]?.[0].message).toBe('Test Error');
  });
});
