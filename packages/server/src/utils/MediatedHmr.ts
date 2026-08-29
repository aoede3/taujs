import http from 'node:http';

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logs } from '../core/logging/types';

/**
 * RFC 0014: the public first-refusal capability handed back as `dev.hmr.tryHandleUpgrade`.
 * `true` means the socket is τjs's HMR channel and must not be offered elsewhere; `false` means
 * it is not τjs's and the caller decides. Never throws.
 */
export type MediatedHmrCapability = {
  tryHandleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
};

/**
 * RFC 0014: the internal controller `CreateServer` builds once and threads through the SSR
 * plugin options. `source` is the package-internal, never-`listen()`ed `http.Server` handed to
 * Vite as `server.ws.server` - present only when the controller is active, ABSENT when inert.
 */
export type MediatedHmrController = {
  capability: MediatedHmrCapability;
  source?: http.Server;
  /** Starts the never-wired warning window on the first call after the client has been served. */
  noteClientServed(): void;
  /** Stops admitting new upgrades and cancels the never-wired timer. Idempotent. */
  beginClosing(): void;
};

export type MediatedHmrOptions = {
  /** `callerOwnedHost && development && hmrTransport === 'mediated'` - resolved by the caller. */
  active: boolean;
  /** The exact pathname τjs's Vite instance is configured with (`${publicBasePath}/`). */
  hmrBase: string;
  logger: Logs;
};

const NEVER_WIRED_WARNING_DELAY_MS = 5000;

const NEVER_WIRED_MESSAGE =
  "hmr: mediated transport selected but no HMR upgrade has reached τjs - offer upgrades to dev.hmr.tryHandleUpgrade from the server's 'upgrade' listener";

/** Swallows a synchronous exception. Used so a logging or socket-teardown failure can never escape containment. */
const guarded = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // deliberately silent: this call exists precisely so a failure here cannot propagate
  }
};

/**
 * RFC 0014 §3-§6: builds ONE mediated-HMR controller. Inert configurations allocate no
 * `http.Server`, no timer and no other live development resource - only an active controller
 * (caller-owned host, development, `hmrTransport: 'mediated'`) creates the never-listened source.
 */
export const createMediatedHmr = (options: MediatedHmrOptions): MediatedHmrController => {
  if (!options.active) {
    return {
      capability: { tryHandleUpgrade: () => false },
      source: undefined,
      noteClientServed: () => {},
      beginClosing: () => {},
    };
  }

  const { hmrBase, logger } = options;

  // Never `listen()`ed: it binds no port and is handed to Vite as `server.ws.server` only so Vite
  // can install its own guarded `upgrade` listener on it (RFC 0014 §3).
  const source = http.createServer();
  const claimed = new WeakSet<Duplex>();

  let closing = false;
  let claimedOnce = false;
  let servedNoted = false;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelWarningTimer = (): void => {
    if (warningTimer !== undefined) {
      clearTimeout(warningTimer);
      warningTimer = undefined;
    }
  };

  const tryHandleUpgrade: MediatedHmrCapability['tryHandleUpgrade'] = (req, socket, head) => {
    // (1) A socket τjs already claimed is reported `true` on every later call, in every state -
    // checked first so a claimed socket can never fall through to "not mine" below.
    let alreadyClaimed = false;
    try {
      alreadyClaimed = claimed.has(socket);
    } catch {
      // defensive only: WeakSet#has on an object argument does not throw in practice
    }
    if (alreadyClaimed) return true;

    let matched = false;
    try {
      // (2) / (3) unclaimed + closing, or unclaimed + destroyed: not τjs's to take.
      if (closing) return false;
      if (socket.destroyed) return false;

      // (4) parse: a missing URL or subprotocol, or a URL the parser rejects, is never τjs's.
      const rawUrl = req.url;
      const protocol = req.headers?.['sec-websocket-protocol'];
      if (!rawUrl || typeof protocol !== 'string') return false;

      let pathname: string;
      try {
        pathname = new URL('http://x' + rawUrl).pathname;
      } catch {
        return false;
      }

      // (5) exact predicate equivalence with Vite's own guard - no normalisation, no superset.
      if (pathname !== hmrBase) return false;
      if (protocol !== 'vite-hmr' && protocol !== 'vite-ping') return false;

      matched = true;
    } catch {
      // Nothing has been claimed yet on this path, so an unexpected failure while classifying is
      // reported the same as "not mine".
      return false;
    }

    if (!matched) return false;

    // (6) Claim BEFORE emitting, so a synchronous listener failure below still leaves the socket
    // correctly claimed (RFC 0014 §5.3) - and cancel the never-wired timer permanently: a
    // successful claim is the only thing that silences it.
    guarded(() => claimed.add(socket));
    claimedOnce = true;
    cancelWarningTimer();

    try {
      const delivered = source.emit('upgrade', req, socket, head);

      if (delivered === false) {
        // `emit` returning `false` means no listener was installed - correct lifecycle ordering
        // makes this impossible, but containment must still cover it (RFC 0014 §5.3).
        guarded(() => logger.error({ component: 'mediated-hmr' }, 'hmr: mediated transport has no listener on its internal source (invariant failure)'));
        guarded(() => socket.destroy());
      }
    } catch (err) {
      guarded(() => logger.error({ component: 'mediated-hmr', err }, 'hmr: mediated transport failed to hand a claimed upgrade to Vite'));
      guarded(() => socket.destroy());
    }

    return true;
  };

  const noteClientServed = (): void => {
    // First call only - later calls no-op regardless of what they would otherwise have done.
    if (servedNoted) return;
    servedNoted = true;

    if (closing || claimedOnce) return;

    warningTimer = setTimeout(() => {
      warningTimer = undefined;
      guarded(() => logger.warn({ component: 'mediated-hmr' }, NEVER_WIRED_MESSAGE));
    }, NEVER_WIRED_WARNING_DELAY_MS);
    warningTimer.unref();
  };

  const beginClosing = (): void => {
    closing = true;
    cancelWarningTimer();
  };

  return {
    capability: { tryHandleUpgrade },
    source,
    noteClientServed,
    beginClosing,
  };
};
