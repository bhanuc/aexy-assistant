/**
 * The daemon's `LiveControl`, wired to the conversation machinery: how an
 * instruction reaches a conversation, how a turn is stopped, how the claimed
 * card is given back. Kept apart from `live-control.ts` so the gates the
 * agent loop reads do not import any of this.
 */

import { v7 as uuidv7 } from "uuid";

import { getConfig } from "../config/loader.js";
import { resolveTurnCommitWaitMs } from "../daemon/abort-watchdog.js";
import { findConversation } from "../daemon/conversation-registry.js";
import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { UserMessageAttachment } from "../daemon/message-types/shared.js";
import { startAfterTurnFinalization } from "../daemon/turn-finalization.js";
import { uploadAttachment } from "../persistence/attachments-store.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getSubagentManager } from "../subagent/index.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import { getActiveTask, markSettled } from "../workspace-tasks/active-task.js";
import { releaseTask } from "../workspace-tasks/client.js";
import { installLiveControl, LiveControl } from "./live-control.js";
import {
  requestTakeover,
  type TakeoverRequest,
  type TakeoverResult,
} from "./takeover.js";
import { getLiveWatchHub } from "./watch-hub.js";
import { resolveWatchFollowTarget } from "./watch-target.js";

const log = getLogger("live-control-runtime");

let control: LiveControl | null = null;

export function getLiveControl(): LiveControl {
  if (!control) {
    control = new LiveControl({
      deliver: deliverLiveMessage,
      abortTurn,
      activeTask: () => {
        const active = getActiveTask();
        return active
          ? {
              taskId: active.claim.task_id,
              conversationId: active.conversationId,
            }
          : null;
      },
      releaseActiveTask,
      resolveTarget: resolveWatchFollowTarget,
      captureScreenshot: () => getLiveWatchHub().captureScreenshot(),
    });
    installLiveControl(control);
  }
  return control;
}

/**
 * Put a person's message on a conversation the way a queued send is: a turn
 * in flight takes it at its next checkpoint, an idle conversation starts a
 * turn on it. Guardian trust, as the workspace-task turn itself runs, since
 * Aexy authorised and logged it before it got here.
 */
export async function deliverLiveMessage(
  conversationId: string,
  text: string,
  image?: Uint8Array | null,
): Promise<void> {
  const conversation = await getOrCreateConversation(conversationId);
  const attachments: UserMessageAttachment[] = [];
  if (image && image.byteLength > 0) {
    const data = Buffer.from(image).toString("base64");
    try {
      const stored = await uploadAttachment(
        "page-after-hand-back.jpg",
        "image/jpeg",
        data,
      );
      attachments.push({
        id: stored.id,
        filename: stored.originalFilename,
        mimeType: stored.mimeType,
        data,
      });
    } catch (err) {
      log.warn({ err }, "Could not store the hand-back screenshot");
    }
  }
  const result = conversation.enqueueMessage({
    content: text,
    attachments,
    requestId: uuidv7(),
    onEvent: broadcastMessage,
    metadata: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    },
    isInteractive: false,
    trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
    // Never the idle fast path, which stores nothing: the kick below runs it.
    queueWhenIdle: true,
  });
  if (result.rejected) {
    throw new Error("The conversation's queue is full");
  }
  if (!conversation.isProcessing()) {
    startAfterTurnFinalization(
      conversationId,
      resolveTurnCommitWaitMs(getConfig().workspaceGit?.turnCommitMaxWaitMs),
      () => {
        void conversation.kickDrainQueue("loop_complete", "live_control");
      },
    );
  }
}

function abortTurn(conversationId: string): boolean {
  const conversation = findConversation(conversationId);
  if (!conversation?.isProcessing()) {
    return false;
  }
  conversation.abort(
    createAbortReason("user_cancel", "live-control-stop", conversationId),
  );
  getSubagentManager().abortAllForParent(conversationId, undefined, {
    userCancelled: true,
  });
  return true;
}

async function releaseActiveTask(reason: string): Promise<void> {
  const active = getActiveTask();
  if (!active || active.settled) {
    return;
  }
  // Marked first: the runner, seeing the turn end, must not return the card
  // a second time as "decided nothing".
  markSettled("released");
  const released = await releaseTask(active.claim.task_id, reason);
  if (released.outcome !== "ok") {
    log.warn(
      { taskId: active.claim.task_id, reason: released.reason },
      "Could not return a stopped task; leaving it to the workspace sweep",
    );
  }
}

/** The agent asks a person to take over (D5), with the daemon's wiring. */
export function requestLiveTakeover(
  request: TakeoverRequest,
): Promise<TakeoverResult> {
  return requestTakeover(request, {
    control: getLiveControl(),
    viewerCount: () => getLiveWatchHub().viewerCount,
  });
}
