/**
 * Naming the person behind a chat request to the daemon (contract C6).
 *
 * The daemon's chat routes admit actor principals only, and the only actor it
 * knows is its guardian, so a chat request from someone else on the access
 * list reaches it on the guardian's principal. These headers are what tell
 * the daemon it is not the guardian speaking: it prefixes the turn with
 * `You are talking with {name} ({role}).` and keys the conversation to them.
 * A daemon that ignored them would treat that person as the guardian, which
 * is why the gateway strips any client copy (`identity-headers.ts`) and sets
 * them only from the access list Aexy pushed.
 */

import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { mintToken } from "../auth/token-service.js";
import type { AccessEntry } from "./access-store.js";
import { DAEMON_ACTING_USER_HEADERS } from "./identity-headers.js";

/** Matches the gateway's other daemon-audience exchange tokens. */
const EXCHANGE_TOKEN_TTL_SECONDS = 60;

export function actingUserHeaders(entry: AccessEntry): Record<string, string> {
  return {
    [DAEMON_ACTING_USER_HEADERS.userId]: entry.platformUserId,
    [DAEMON_ACTING_USER_HEADERS.userName]: encodeURIComponent(
      entry.displayName,
    ),
    [DAEMON_ACTING_USER_HEADERS.userRole]: entry.role,
    [DAEMON_ACTING_USER_HEADERS.aexyDeveloperId]: entry.aexyDeveloperId,
  };
}

/**
 * A daemon-audience token for the guardian's actor principal, the same token
 * the runtime proxy mints from the guardian's own edge JWT.
 */
export function mintGuardianExchangeToken(guardianPrincipalId: string): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: `actor:self:${guardianPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
  });
}
