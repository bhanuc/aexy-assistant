/**
 * Which card this process is working on, if any.
 *
 * Module scope, deliberately, and it is the plan's "one pod, one task at a
 * time" decision made concrete rather than a shortcut. A pod runs one browser,
 * one filesystem and one shell; two tasks in flight would share all three, and
 * that is how two pieces of work corrupt each other's state. Holding a single
 * claim here means a second task cannot start while one is running, and the
 * task tools need no way to be told which card they mean.
 *
 * It also bounds what the tools can reach: `submit_task` acts on the claim
 * this process actually holds, not on a task id the model supplies. A model
 * that could name the card could submit somebody else's.
 */

import type { WorkspaceTask, WorkspaceTaskClaim } from "./client.js";

export interface ActiveTask {
  task: WorkspaceTask;
  claim: WorkspaceTaskClaim;
  /** Set by the task tools so the runner knows the turn settled itself. */
  settled: "submitted" | "released" | null;
  /**
   * The conversation working the card, once the turn has one. Reported to
   * the workspace on heartbeats (C8) and followed by the live view.
   */
  conversationId?: string;
}

let active: ActiveTask | null = null;
const listeners = new Set<() => void>();

export function getActiveTask(): ActiveTask | null {
  return active;
}

export function setActiveTask(value: ActiveTask | null): void {
  active = value;
  notify();
}

/** Record the conversation the active card's turn runs in. */
export function setActiveTaskConversation(conversationId: string): void {
  if (!active) {
    return;
  }
  active.conversationId = conversationId;
  notify();
}

/** Hear when the active card, or its conversation, changes. */
export function onActiveTaskChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A watcher's bookkeeping must never disturb the card.
    }
  }
}

export function markSettled(how: "submitted" | "released"): void {
  if (active) {
    active.settled = how;
  }
}

/** @internal Test helper. */
export function resetActiveTaskForTest(): void {
  active = null;
}
