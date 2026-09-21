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
}

let active: ActiveTask | null = null;

export function getActiveTask(): ActiveTask | null {
  return active;
}

export function setActiveTask(value: ActiveTask | null): void {
  active = value;
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
