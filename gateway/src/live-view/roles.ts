/**
 * The vocabulary Aexy and the gateway share about a person on an assistant
 * (contract vocabulary): what they may do on a stream, and what they are.
 */

export const STREAM_SCOPES = ["watch", "control", "chat"] as const;
export type StreamScope = (typeof STREAM_SCOPES)[number];

export const VIEWER_ROLES = ["owner", "manager", "admin", "member"] as const;
export type ViewerRole = (typeof VIEWER_ROLES)[number];

/**
 * Roles that may read anyone's thread through the threads index (C6) and see
 * full thinking (C2). Everyone else sees only their own.
 */
export function isPrivilegedRole(role: ViewerRole): boolean {
  return role === "owner" || role === "manager" || role === "admin";
}
