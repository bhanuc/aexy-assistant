/**
 * Who may call the Aexy live-view service routes (`/v1/live/*`,
 * `/v1/watch/snapshot`; contract C2.1, C4.1, C6).
 *
 * These are service paths, not tunnel paths: Aexy reaches them through the
 * control plane and the orchestrator proxy, which is the only way into a
 * managed pod besides velay (plan D3). So the gateway authenticates them the
 * way it authenticates everything else that arrives on that hop:
 *
 * - **Managed** (`IS_PLATFORM` + `DISABLE_HTTP_AUTH`): the orchestrator
 *   attests the caller in `X-Vellum-User-Id`, overwriting any client copy,
 *   and the gateway compares it to the stored `platform_user_id`, as
 *   `requireEdgeGuardianAuth` does under the platform bypass.
 * - **Everywhere else**: the guardian's own actor edge JWT. There is no
 *   control plane in front of a self-hosted assistant; its guardian is the
 *   only party who could be asking.
 *
 * And they refuse anything that came through velay outright. Velay's path
 * allowlist already keeps these routes off the tunnel; the refusal here is so
 * that stays true if someone widens the allowlist without reading this.
 */

import type { Logger } from "pino";

import { admitActorToken } from "../auth/actor-token-revocation.js";
import { parseSub } from "../auth/subject.js";
import { validateEdgeToken } from "../auth/token-exchange.js";
import {
  isPlatformManaged,
  requireBoundGuardian,
} from "../http/routes/guardian-pin.js";
import { isHttpAuthDisabled } from "../http/middleware/auth.js";
import { readStoredPlatformUserId } from "../platform-user-id.js";
import { requestHasVelayBridgeAuth } from "../velay/bridge-auth.js";
import { VELAY_FORWARDED_HEADER } from "../velay/bridge-utils.js";

const PLATFORM_USER_HEADER = "x-vellum-user-id";

/** The caller a live-view service request was authenticated as. */
export type LiveServiceCaller = { kind: "guardian" };

export type LiveServiceAuth =
  | { ok: true; caller: LiveServiceCaller }
  | { ok: false; response: Response };

function deny(status: 401 | 403 | 503): LiveServiceAuth {
  const error =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : "Service Unavailable";
  return { ok: false, response: Response.json({ error }, { status }) };
}

/** True when the managed-mode platform auth bypass is in effect. */
function platformBypassActive(): boolean {
  return isHttpAuthDisabled() && isPlatformManaged();
}

/**
 * Authenticate a live-view service call. Null-free on purpose: a caller is
 * either named or refused, never waved through on a missing header.
 */
export async function authorizeLiveServiceCall(
  req: Request,
  log: Logger,
): Promise<LiveServiceAuth> {
  const path = new URL(req.url).pathname;
  if (
    req.headers.get(VELAY_FORWARDED_HEADER) ||
    requestHasVelayBridgeAuth(req)
  ) {
    log.warn({ path }, "live service: refused a request relayed by velay");
    return deny(403);
  }

  if (platformBypassActive()) {
    const userId = req.headers.get(PLATFORM_USER_HEADER)?.trim();
    if (!userId) {
      log.warn({ path }, "live service: no attested platform user");
      return deny(401);
    }
    let stored: string | undefined;
    try {
      const result = await readStoredPlatformUserId();
      if (result.unreachable) {
        log.warn({ path }, "live service: credential store unreachable");
        return deny(503);
      }
      stored = result.userId;
    } catch (err) {
      log.error({ err, path }, "live service: platform_user_id lookup failed");
      return deny(503);
    }
    if (stored && stored === userId) {
      return { ok: true, caller: { kind: "guardian" } };
    }
    log.warn({ path }, "live service: attested user is not the guardian");
    return deny(403);
  }

  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return deny(401);
  }
  const token = auth.slice(7);
  const result = validateEdgeToken(token);
  if (!result.ok) {
    log.warn({ path, reason: result.reason }, "live service: bad token");
    return deny(401);
  }
  if (!admitActorToken(token, result.claims)) {
    log.warn({ path }, "live service: actor token revoked");
    return deny(401);
  }
  const parsed = parseSub(result.claims.sub);
  if (
    result.claims.scope_profile !== "actor_client_v1" ||
    !parsed.ok ||
    parsed.principalType !== "actor" ||
    !parsed.actorPrincipalId
  ) {
    log.warn({ path }, "live service: not an actor client token");
    return deny(403);
  }
  const notGuardian = await requireBoundGuardian(parsed.actorPrincipalId, log);
  if (notGuardian) {
    return { ok: false, response: notGuardian };
  }
  return { ok: true, caller: { kind: "guardian" } };
}
