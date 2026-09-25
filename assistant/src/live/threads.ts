/**
 * The chat threads index (WS-12, contract C6), daemon side.
 *
 * Whose a thread is lives in its conversation key, not anywhere the gateway
 * keeps: one a person on the access list starts is keyed
 * `aexy-user:<platform user id>:…` (see `acting-user.ts`), and every other
 * person-facing conversation is the guardian's. The gateway's own record of
 * who started what is in memory and gone after a restart; this is not.
 *
 * The daemon knows platform user ids only. The gateway, which holds the access
 * list, asks by platform user and turns the answer into Aexy developer ids.
 */

import { and, desc, eq, isNull, like } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import {
  conversationKeys,
  conversations,
} from "../persistence/schema/index.js";

const KEY_PREFIX = "aexy-user:";

/** How many threads one answer lists, newest first. */
export const MAX_THREADS = 200;

export interface ChatThread {
  conversation_id: string;
  /** The person on the access list who started it; `null` for the guardian. */
  platform_user_id: string | null;
  title: string | null;
  updated_at: string;
}

/** `all`, `guardian`, or one person's platform user id. */
export type ThreadsFor = "all" | "guardian" | { platformUserId: string };

/** The platform user a conversation key names, if it is a person's thread. */
export function threadOwnerFromKey(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX)) {
    return null;
  }
  const owner = key.slice(KEY_PREFIX.length).split(":")[0];
  return owner ? owner : null;
}

export function listChatThreads(who: ThreadsFor): ChatThread[] {
  const db = getDb();
  const owners = new Map<string, string>();
  for (const row of db
    .select({
      conversationId: conversationKeys.conversationId,
      key: conversationKeys.conversationKey,
    })
    .from(conversationKeys)
    .where(like(conversationKeys.conversationKey, `${KEY_PREFIX}%`))
    .all()) {
    const owner = threadOwnerFromKey(row.key);
    if (owner) {
      owners.set(row.conversationId, owner);
    }
  }

  // Person-facing conversations only: a card's turn or a schedule is work,
  // not somebody's chat.
  const rows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.source, "user"),
        eq(conversations.conversationType, "standard"),
        isNull(conversations.archivedAt),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .all();

  const threads: ChatThread[] = [];
  for (const row of rows) {
    const owner = owners.get(row.id) ?? null;
    const wanted =
      who === "all" ||
      (who === "guardian" && owner === null) ||
      (typeof who === "object" && owner === who.platformUserId);
    if (!wanted) {
      continue;
    }
    threads.push({
      conversation_id: row.id,
      platform_user_id: owner,
      title: row.title,
      updated_at: new Date(row.updatedAt).toISOString(),
    });
    if (threads.length >= MAX_THREADS) {
      break;
    }
  }
  return threads;
}
