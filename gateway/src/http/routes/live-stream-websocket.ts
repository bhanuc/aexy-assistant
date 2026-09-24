/**
 * The Aexy live-view halves of `/v1/watch/stream` and `/v1/desktop/stream`
 * (contract C1.4, C2, C3): sockets admitted on the tunnel's attested stream
 * scope instead of the guardian pin.
 *
 * Same pump as the guardian's sockets (`runtime-audio-stream.ts`), with two
 * differences. The upstream dial carries the attested viewer as `x-vellum-*`
 * headers, which is what lets the daemon tell one viewer from another at all.
 * And the two paths treat a slow viewer differently:
 *
 * - **Watch** carries self-contained JSON events and whole JPEG frames. The
 *   daemon already sends each viewer only its latest frame (C2 "latest frame
 *   wins"), so a frame Bun drops past backpressure is one the next frame
 *   replaces. Closing the socket for it would turn a busy moment into a
 *   reconnect.
 * - **Desktop** is RFB, an ordered byte stream with no resync, so a dropped
 *   frame still ends the session, as it does for the guardian.
 *
 * A refused attestation is still upgraded, then closed at once with the
 * refusal's code: a browser WebSocket never sees an HTTP status, and a close
 * code (4003) is the only answer the viewer can act on.
 */

import {
  createRuntimeAudioStreamHandlers,
  type RuntimeAudioStreamState,
} from "./runtime-audio-stream.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import {
  liveStreamUpstreamHeaders,
  type LiveStreamAttestation,
  type LiveStreamDecision,
  type StreamRefusal,
} from "../../live-view/stream-auth.js";

const log = getLogger("live-stream-ws");

export type LiveStreamWsType = "live-watch-stream" | "live-desktop-stream";

export type LiveStreamSocketData = RuntimeAudioStreamState & {
  wsType: LiveStreamWsType;
  /** Null only on a refused upgrade, which never dials upstream. */
  attestation: LiveStreamAttestation | null;
  refusal?: StreamRefusal;
};

/**
 * Upgrade a request the live-stream authorization has decided on. Returns a
 * Response only when the request cannot be upgraded at all.
 */
export function upgradeLiveStream(
  req: Request,
  server: import("bun").Server<unknown>,
  config: GatewayConfig,
  decision: Exclude<LiveStreamDecision, { kind: "not-live" }>,
  wsType: LiveStreamWsType,
): Response | undefined {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Upgrade Required", { status: 426 });
  }
  const data: LiveStreamSocketData =
    decision.kind === "admit"
      ? { wsType, config, attestation: decision.attestation }
      : { wsType, config, attestation: null, refusal: decision.refusal };
  if (!server.upgrade(req, { data })) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }
  return undefined;
}

function logContext(data: LiveStreamSocketData): Record<string, unknown> {
  const attestation = data.attestation;
  return attestation
    ? {
        viewerId: attestation.userId,
        scope: attestation.scope,
        liveSessionId: attestation.liveSessionId,
      }
    : {};
}

function createLiveStreamHandlers(
  upstreamPath: "/v1/watch/stream" | "/v1/desktop/stream",
  label: string,
  closeOnDroppedFrame: boolean,
) {
  const pump = createRuntimeAudioStreamHandlers<LiveStreamSocketData>({
    upstreamPath,
    log,
    label,
    logContext,
    upstreamHeaders: (data) =>
      data.attestation
        ? liveStreamUpstreamHeaders(data.attestation)
        : undefined,
    closeOnDroppedFrame,
  });
  return {
    open(ws: import("bun").ServerWebSocket<LiveStreamSocketData>) {
      const { refusal, attestation } = ws.data;
      if (refusal || !attestation) {
        const code = refusal?.code ?? 4003;
        const reason = refusal?.reason ?? "Forbidden";
        log.info({ code, reason }, `${label} refused`);
        ws.close(code, reason);
        return;
      }
      pump.open(ws);
    },
    message(
      ws: import("bun").ServerWebSocket<LiveStreamSocketData>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      if (!ws.data.attestation) {
        return;
      }
      pump.message(ws, message);
    },
    close(
      ws: import("bun").ServerWebSocket<LiveStreamSocketData>,
      code: number,
      reason: string,
    ) {
      pump.close(ws, code, reason);
    },
  };
}

/** Handlers for a live watch socket: events and frames, drops tolerated. */
export function getLiveWatchStreamWebsocketHandlers() {
  return createLiveStreamHandlers(
    "/v1/watch/stream",
    "live watch stream",
    false,
  );
}

/** Handlers for a live desktop socket: RFB, so a drop ends the session. */
export function getLiveDesktopStreamWebsocketHandlers() {
  return createLiveStreamHandlers(
    "/v1/desktop/stream",
    "live desktop stream",
    true,
  );
}

/** Both live sockets behind one set of `Bun.serve` handlers, by `wsType`. */
export function getLiveStreamWebsocketHandlers() {
  const watch = getLiveWatchStreamWebsocketHandlers();
  const desktop = getLiveDesktopStreamWebsocketHandlers();
  const pick = (ws: import("bun").ServerWebSocket<LiveStreamSocketData>) =>
    ws.data.wsType === "live-desktop-stream" ? desktop : watch;
  return {
    open(ws: import("bun").ServerWebSocket<LiveStreamSocketData>) {
      pick(ws).open(ws);
    },
    message(
      ws: import("bun").ServerWebSocket<LiveStreamSocketData>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      pick(ws).message(ws, message);
    },
    close(
      ws: import("bun").ServerWebSocket<LiveStreamSocketData>,
      code: number,
      reason: string,
    ) {
      pick(ws).close(ws, code, reason);
    },
  };
}

export function isLiveStreamSocketData(
  data: unknown,
): data is LiveStreamSocketData {
  if (!data || typeof data !== "object") {
    return false;
  }
  const wsType = (data as { wsType?: unknown }).wsType;
  return wsType === "live-watch-stream" || wsType === "live-desktop-stream";
}
