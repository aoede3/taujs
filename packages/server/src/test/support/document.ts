import { Readable } from 'node:stream';

/**
 * Consumes a streaming route's payload the way Fastify does.
 *
 * The streaming strategy returns a COLD document stream: nothing runs until it is consumed, so a
 * unit test that never reads the payload never starts the renderer. This helper is the equivalent
 * of Fastify pulling the stream.
 *
 * SCOPE, deliberately narrow: consuming the document proves ASSEMBLY and LOCAL failure propagation.
 * It proves nothing about status codes, headers, hook invocation, payload replacement, transfer
 * abort or client disconnect - those are Fastify's behaviour and need a real listener. Do not let a
 * document-level assertion stand in for wire evidence.
 */
export const collectDocument = async (payload: unknown): Promise<string> => {
  if (!(payload instanceof Readable)) throw new Error(`collectDocument: expected a Readable payload, received ${typeof payload}`);

  let document = '';

  for await (const chunk of payload) document += String(chunk);

  return document;
};

/**
 * Consumes a payload that is expected to FAIL before yielding its first byte, and returns the
 * reason. This is the document-level face of "a pre-byte failure can still become a real 500":
 * the stream rejects before commitment, which is what lets Fastify send an error response instead.
 * The status itself is asserted on a real listener.
 */
export const collectDocumentFailure = async (payload: unknown): Promise<unknown> => {
  try {
    await collectDocument(payload);
  } catch (error) {
    return error;
  }

  throw new Error('collectDocumentFailure: the document completed instead of failing');
};

/** Bytes yielded before the stream failed: the post-byte "partial document, aborted transfer" case. */
export const collectPartialDocument = async (payload: unknown): Promise<{ document: string; error: unknown }> => {
  if (!(payload instanceof Readable)) throw new Error(`collectPartialDocument: expected a Readable payload, received ${typeof payload}`);

  let document = '';

  try {
    for await (const chunk of payload) document += String(chunk);
  } catch (error) {
    return { document, error };
  }

  return { document, error: undefined };
};
