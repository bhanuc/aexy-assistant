/**
 * Who may open an Aexy live stream (contract C1.4).
 *
 * Upstream admits exactly one person to `/v1/watch/stream` and
 * `/v1/desktop/stream`: the bound guardian (`guardian-pin.ts`). Aexy decides
 * who else may watch or drive (plan D3), mints a single-use token for that
 * person through the control plane, and the tunnel consumes it and injects
 * the decision as `X-Velay-*` headers. This module is the gateway's half of
 * that: when the tunnel has attested a stream scope, the scope is the
 * authorization, not the guardian pin.
 *
 * The attestation is trusted only as far as the guardian pin trusts the
 * tunnel's other headers, and for the same reason: the process-local bridge
 * proof shows the upgrade came through this gateway's own velay bridge, so
 * the headers are velay's and not the caller's. A scope header without that
 * proof is not an attestation at all, so the request is left to the guardian
 * pin exactly as upstream would have handled it.
 */

import type { Logger } from "pino";

import {
  acceptsVelayAttestation,
  extractVelayAttestedContext,
} from "../http/routes/guardian-pin.js";
import type { GatewayConfig } from "../config.js";
import { requestHasVelayBridgeAuth } from "../velay/bridge-auth.js";
import { DAEMON_VIEWER_HEADERS } from "./identity-headers.js";
import { isLiveViewEnabled } from "./flag.js";
import { conversationOwner } from "./access-store.js";
import {
  isPrivilegedRole,
  STREAM_SCOPES,
  VIEWER_ROLES,
  type StreamScope,
  type ViewerRole,
} from "./roles.js";

/** Headers the tunnel injects on a relayed live stream (contract C1.3). */
export const VELAY_STREAM_HEADERS = {
  scope: "x-velay-stream-scope",
  viewerRole: "x-velay-viewer-role",
  liveSessionId: "x-velay-live-session-id",
  aexyDeveloperId: "x-velay-aexy-developer-id",
  displayName: "x-velay-display-name",
  conversationId: "x-velay-conversation-id",
} as const;

/** Close code for a live stream the attestation does not admit. */
export const LIVE_STREAM_FORBIDDEN = 4003;

export type LiveStreamPath = "/v1/watch/stream" | "/v1/desktop/stream";

/** What the tunnel attested about the person opening a live stream. */
export interface LiveStreamAttestation {
  /** Platform `users.id` (`x-velay-user-id`). */
  userId: string;
  orgId: string;
  scope: StreamScope;
  viewerRole: ViewerRole;
  liveSessionId: string;
  aexyDeveloperId: string;
  /** Still URL-encoded, as the tunnel sent it; forwarded verbatim. */
  displayName: string;
  /** Set only when the token named one. */
  conversationId?: string;
}

/** A live upgrade the gateway accepts only to close with `code`. */
export interface StreamRefusal {
  code: number;
  reason: string;
}

export type LiveStreamDecision =
  /** Not a live stream: the guardian pin decides, as upstream. */
  | { kind: "not-live" }
  | { kind: "admit"; attestation: LiveStreamAttestation }
  | { kind: "refuse"; refusal: StreamRefusal };

function isOneOf<T extends string>(
  values: readonly T[],
  value: string | undefined,
): value is T {
  return value !== undefined && (values as readonly string[]).includes(value);
}

function header(req: Request, name: string): string | undefined {
  return req.headers.get(name)?.trim() || undefined;
}

function refuse(reason: string): LiveStreamDecision {
  return {
    kind: "refuse",
    refusal: { code: LIVE_STREAM_FORBIDDEN, reason },
  };
}

/**
 * Decide a live-stream upgrade on the tunnel's attestation.
 *
 * `not-live` means the attestation does not apply (flag off, no scope header,
 * no tunnel, no bridge proof) and the caller runs the guardian pin instead.
 * `refuse` means it does apply and says no: the caller upgrades and closes
 * with the refusal's code, because a browser's WebSocket never sees an HTTP
 * status and a close code is the only answer it can act on.
 */
export function authorizeLiveStream(
  req: Request,
  config: GatewayConfig,
  path: LiveStreamPath,
  log: Logger,
): LiveStreamDecision {
  if (!isLiveViewEnabled()) {
    return { kind: "not-live" };
  }
  const scopeRaw = header(req, VELAY_STREAM_HEADERS.scope);
  if (scopeRaw === undefined) {
    return { kind: "not-live" };
  }
  if (!acceptsVelayAttestation(config)) {
    // No tunnel means no velay traffic: the header is the caller's own.
    log.warn({ path }, "live stream: scope header on a gateway with no tunnel");
    return { kind: "not-live" };
  }
  if (!requestHasVelayBridgeAuth(req)) {
    log.warn(
      { path },
      "live stream: ignoring scope header without bridge proof",
    );
    return { kind: "not-live" };
  }

  const base = extractVelayAttestedContext(req);
  if (!base) {
    log.warn({ path }, "live stream: incomplete velay attestation");
    return refuse("Incomplete attestation");
  }
  const scope = scopeRaw.toLowerCase();
  if (!isOneOf(STREAM_SCOPES, scope)) {
    log.warn({ path, scope }, "live stream: unknown scope");
    return refuse("Unknown stream scope");
  }
  const viewerRole = header(
    req,
    VELAY_STREAM_HEADERS.viewerRole,
  )?.toLowerCase();
  if (!isOneOf(VIEWER_ROLES, viewerRole)) {
    log.warn({ path, viewerRole }, "live stream: unknown viewer role");
    return refuse("Unknown viewer role");
  }
  const liveSessionId = header(req, VELAY_STREAM_HEADERS.liveSessionId);
  const aexyDeveloperId = header(req, VELAY_STREAM_HEADERS.aexyDeveloperId);
  const displayName = header(req, VELAY_STREAM_HEADERS.displayName) ?? "";
  if (!liveSessionId || !aexyDeveloperId) {
    log.warn({ path }, "live stream: attestation missing session or developer");
    return refuse("Incomplete attestation");
  }
  try {
    decodeURIComponent(displayName);
  } catch {
    log.warn({ path }, "live stream: display name is not URL-encoded UTF-8");
    return refuse("Malformed display name");
  }
  const conversationId = header(req, VELAY_STREAM_HEADERS.conversationId);

  if (path === "/v1/desktop/stream" && scope !== "control") {
    // Driving the desktop is what `control` means; anything less may watch.
    log.warn({ path, scope }, "live stream: desktop needs control scope");
    return refuse("Desktop needs control scope");
  }
  if (scope === "chat" && !conversationId) {
    log.warn({ path }, "live stream: chat scope without a conversation");
    return refuse("Chat scope needs a conversation");
  }
  if (
    scope === "chat" &&
    conversationId &&
    !isPrivilegedRole(viewerRole) &&
    conversationOwner(conversationId)?.platformUserId !== base.userId
  ) {
    // C6: a member reads only a conversation they started. Owners, managers
    // and admins reach others' through the threads index, which Aexy logs.
    log.warn({ path }, "live stream: chat on someone else's conversation");
    return refuse("Not your conversation");
  }

  const attestation: LiveStreamAttestation = {
    userId: base.userId,
    orgId: base.orgId,
    scope,
    viewerRole,
    liveSessionId,
    aexyDeveloperId,
    displayName,
    ...(conversationId ? { conversationId } : {}),
  };
  log.info(
    {
      path,
      userId: attestation.userId,
      scope,
      viewerRole,
      liveSessionId,
    },
    "live stream: authorized by attested scope",
  );
  return { kind: "admit", attestation };
}

/**
 * The headers the daemon reads to know who is on a live stream (C1.4). The
 * service token rides the query string as on every gateway-dialed socket.
 */
export function liveStreamUpstreamHeaders(
  attestation: LiveStreamAttestation,
): Record<string, string> {
  const headers: Record<string, string> = {
    [DAEMON_VIEWER_HEADERS.viewerId]: attestation.userId,
    [DAEMON_VIEWER_HEADERS.viewerRole]: attestation.viewerRole,
    [DAEMON_VIEWER_HEADERS.streamScope]: attestation.scope,
    [DAEMON_VIEWER_HEADERS.liveSessionId]: attestation.liveSessionId,
    [DAEMON_VIEWER_HEADERS.aexyDeveloperId]: attestation.aexyDeveloperId,
    [DAEMON_VIEWER_HEADERS.displayName]: attestation.displayName,
  };
  if (attestation.conversationId) {
    headers["x-vellum-conversation-id"] = attestation.conversationId;
  }
  return headers;
}
