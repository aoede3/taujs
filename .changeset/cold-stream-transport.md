---
'@taujs/server': minor
---

Streaming responses are now sent through Fastify rather than by taking over the raw socket.

τjs previously called `reply.hijack()` for a streaming route and wrote the response itself. It now returns a document for Fastify to send, which means Fastify owns the transport, the head and the socket for every render strategy.

**`onSend` now runs for streamed responses.** It was silently skipped before, so an `onSend` policy applied to SSR pages and ordinary routes while missing every streamed page. Hosts that assumed that gap should re-read the [hook matrix](https://taujs.dev/guides/host-ownership/#response-policy-and-lifecycle-hooks): `onRequest` and `preHandler` remain the recommended points for security and cache policy, and `onSend` is now usable for deliberate transformation of the final response.

Two consequences worth knowing before you write hooks:

- Once Fastify has been handed the document, a streamed response that then fails **before yielding its first byte** gives the host **two send passes** - the document that was about to be sent, then the error representation Fastify sends instead. (A request that fails earlier, before any document is returned, still takes Fastify's ordinary single error path.) `onResponse` describes the request once either way. Write `onSend` hooks so they are safe across response attempts.
- A hook may wrap the payload, but the wrapper must propagate source errors to the stream it returns. Node's `.pipe()` alone does not, and a wrapper built with it leaves a failed response hanging. The guide carries a worked example.

Failure boundaries are now stated by the byte rather than by a renderer callback: before the first document byte reaches Fastify a failure can still become a real 500; after it, the transfer aborts with whatever was delivered. Each renderer reaches that boundary on its own terms, and no framework-specific code exists in the server.

Observable improvements:

- a renderer failure that used to race the raw socket - sometimes discarding a shell that had already been written - now delivers what was produced and then aborts the transfer;
- a payload replaced by an `onSend` hook means the renderer never starts at all, and the response is recorded as complete while the superseded deferred work is recorded as aborted;
- a streamed response that fails before its first byte sends its error as JSON explicitly, instead of inheriting the HTML content type the abandoned response had already declared;
- a renderer that fails in the same tick as it publishes its head now answers with a real 500. Publishing a head previously entered raw-socket commitment and teardown, so the outcome depended on what had already been flushed; the boundary is now the first byte **yielded to Fastify**, and a head is not one. This changes Vue most visibly, since Vue publishes its head before rendering any component;
- a client that disconnects before the response can be wired at all - while a host hook is still awaiting - is now recorded as `aborted`, and the deferred work that had already started is released rather than stranded.

`reply.hijack()` remains in the development introspection SSE endpoint only, which is intentionally out of scope for this change rather than inherent to SSE.
