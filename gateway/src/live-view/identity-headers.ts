/**
 * The identity headers the gateway hands the daemon for Aexy live view
 * (contract C1.4), and the rule that nobody else may.
 *
 * The daemon trusts these because only the gateway can reach it. That trust
 * holds only if no client-supplied copy ever gets through, so every proxy hop
 * that forwards caller headers to the daemon strips them first, whatever the
 * flag says: a header the daemon reads as "the gateway attested this" must
 * mean exactly that, on every build.
 */

/** Headers the gateway sets on a live stream it forwards to the daemon. */
export const DAEMON_VIEWER_HEADERS = {
  viewerId: "x-vellum-viewer-id",
  viewerRole: "x-vellum-viewer-role",
  streamScope: "x-vellum-stream-scope",
  liveSessionId: "x-vellum-live-session-id",
  aexyDeveloperId: "x-vellum-aexy-developer-id",
  displayName: "x-vellum-display-name",
} as const;

/**
 * Headers the gateway sets on a chat request it forwards for someone on the
 * access list who is not the guardian (C6). Absent on the guardian's own.
 */
export const DAEMON_ACTING_USER_HEADERS = {
  /** Platform `users.id`, the same id as `x-vellum-viewer-id`. */
  userId: "x-vellum-acting-user-id",
  /** URL-encoded UTF-8, like `x-velay-display-name`. */
  userName: "x-vellum-acting-user-name",
  userRole: "x-vellum-acting-user-role",
  aexyDeveloperId: "x-vellum-acting-aexy-developer-id",
} as const;

/**
 * Every live-view identity header the daemon may read. Stripped from client
 * requests by the runtime proxies, so only the gateway itself can set one.
 *
 * `x-vellum-conversation-id` is deliberately absent: it is an ordinary client
 * header upstream (the queued-message routes read it) and carries no identity.
 * The live watch stream sets its own copy on a socket the gateway dials fresh,
 * so no client value can reach the daemon alongside it.
 */
export const DAEMON_IDENTITY_HEADER_NAMES: readonly string[] = Object.freeze([
  ...Object.values(DAEMON_VIEWER_HEADERS),
  ...Object.values(DAEMON_ACTING_USER_HEADERS),
]);

/** Remove every live-view identity header from `headers`, in place. */
export function stripLiveViewIdentityHeaders(headers: Headers): Headers {
  for (const name of DAEMON_IDENTITY_HEADER_NAMES) {
    headers.delete(name);
  }
  return headers;
}

/** The same, for the IPC proxy's plain header record (keys lower-cased). */
export function stripLiveViewIdentityHeaderRecord(
  headers: Record<string, string>,
): Record<string, string> {
  for (const name of DAEMON_IDENTITY_HEADER_NAMES) {
    delete headers[name];
  }
  return headers;
}
