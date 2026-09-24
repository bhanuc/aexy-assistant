/**
 * Which conversation a watcher sees when their token names none (C2): the
 * active workspace-task conversation, else the most recent background one.
 */

import { desc, eq } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { conversations } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";
import { getActiveTask } from "../workspace-tasks/active-task.js";

const log = getLogger("live-watch-target");

export function resolveWatchFollowTarget(): string | null {
  const active = getActiveTask()?.conversationId;
  if (active) {
    return active;
  }
  return mostRecentBackgroundConversationId();
}

function mostRecentBackgroundConversationId(): string | null {
  try {
    const row = getDb()
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.conversationType, "background"))
      .orderBy(desc(conversations.updatedAt))
      .limit(1)
      .get();
    return row?.id ?? null;
  } catch (err) {
    log.debug(
      { err },
      "Could not read the most recent background conversation",
    );
    return null;
  }
}
