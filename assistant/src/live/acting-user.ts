/**
 * Everyone with access gets their own chat (WS-12, contract C6), daemon side.
 *
 * The gateway accepts chat from anyone on the access list Aexy pushes, and
 * sends it on the guardian's actor principal — the only actor the daemon
 * knows — with `x-vellum-acting-user-*` headers naming who is actually
 * speaking. Only the gateway can set them (it strips client copies on every
 * hop), and they are absent on the guardian's own turns.
 *
 * Two things follow here:
 *
 * - **The turn knows whose request it is.** Each such turn's context starts
 *   `You are talking with {name} ({role}).`, so the agent weighs a member's
 *   request as a member's and does not treat it as the owner's.
 * - **Conversations are keyed by that user.** One the person starts is keyed
 *   `aexy-user:<platform user id>:…`, which is the durable record of whose it
 *   is; a turn naming a conversation that is not theirs is refused as not
 *   found, so the pod never serves one person's thread to another even if a
 *   caller upstream got it wrong.
 */

import { eq } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { conversationKeys } from "../persistence/schema/index.js";
import { isLiveViewEnabled } from "./live-view-feature.js";

export const ACTING_USER_HEADERS = {
  userId: "x-vellum-acting-user-id",
  userName: "x-vellum-acting-user-name",
  userRole: "x-vellum-acting-user-role",
  aexyDeveloperId: "x-vellum-acting-aexy-developer-id",
} as const;

const ROLES: ReadonlySet<string> = new Set([
  "owner",
  "manager",
  "admin",
  "member",
]);

export interface ActingUser {
  /** Platform `users.id`. */
  readonly platformUserId: string;
  readonly aexyDeveloperId: string | null;
  readonly name: string;
  readonly role: "owner" | "manager" | "admin" | "member";
}

/**
 * The person the gateway says is speaking, or `null` on the guardian's own
 * turn, with the live view off, or when the headers are incomplete.
 */
export function readActingUser(
  headers: Record<string, string> | undefined,
  enabled: () => boolean = () => isLiveViewEnabled(),
): ActingUser | null {
  const platformUserId = headers?.[ACTING_USER_HEADERS.userId]?.trim();
  if (!platformUserId || !enabled()) {
    return null;
  }
  const role = headers?.[ACTING_USER_HEADERS.userRole]?.trim() ?? "";
  return {
    platformUserId,
    aexyDeveloperId:
      headers?.[ACTING_USER_HEADERS.aexyDeveloperId]?.trim() || null,
    name: decodeName(headers?.[ACTING_USER_HEADERS.userName]) ?? platformUserId,
    // An unknown role is read as the least privileged, never the most.
    role: (ROLES.has(role) ? role : "member") as ActingUser["role"],
  };
}

function decodeName(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  // One line, no markup: it is placed in the model's context.
  name = name
    .replace(/[\r\n\u0085\u2028\u2029]+/g, " ")
    .replace(/[\x00-\x1F\x7F-\x9F<>]/g, " ")
    .trim();
  return name || null;
}

export function actingUserKeyPrefix(user: ActingUser): string {
  return `aexy-user:${user.platformUserId}:`;
}

/** The conversation key for a thread this person starts or names by key. */
export function actingUserConversationKey(
  user: ActingUser,
  clientKey: string | undefined,
): string {
  const prefix = actingUserKeyPrefix(user);
  const key =
    clientKey && clientKey.length > 0 ? clientKey : crypto.randomUUID();
  return key.startsWith(prefix) ? key : `${prefix}${key}`;
}

/** Whether `conversationId` is one of this person's threads. */
export function conversationBelongsTo(
  conversationId: string,
  user: ActingUser,
): boolean {
  const prefix = actingUserKeyPrefix(user);
  const keys = getDb()
    .select({ key: conversationKeys.conversationKey })
    .from(conversationKeys)
    .where(eq(conversationKeys.conversationId, conversationId))
    .all();
  return keys.some((row) => row.key.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Who the current turn is with
// ---------------------------------------------------------------------------

const speakers = new Map<string, ActingUser>();

/**
 * Record who sent the latest message on a conversation; `null` for the
 * guardian, which clears it.
 */
export function setConversationSpeaker(
  conversationId: string,
  user: ActingUser | null,
): void {
  if (user) {
    speakers.set(conversationId, user);
  } else {
    speakers.delete(conversationId);
  }
}

export function getConversationSpeaker(
  conversationId: string,
): ActingUser | null {
  return speakers.get(conversationId) ?? null;
}

/** The line each such turn's context starts with (C6). */
export function speakerLine(user: ActingUser): string {
  return `You are talking with ${user.name} (${user.role}).`;
}

/** @internal Test helper. */
export function _resetConversationSpeakersForTests(): void {
  speakers.clear();
}
