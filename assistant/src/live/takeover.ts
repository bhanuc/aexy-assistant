/**
 * The agent asking a person to take the wheel (plan D4 rung 3, D5).
 *
 * Upstream's handoff waited up to five minutes for the page URL to change, for
 * a human who was never told, and returned the same way whether someone had
 * solved the problem, given up, or never come. This asks instead: a
 * `kind:"takeover"` human-help ask goes to the workspace inbox (C8), which
 * routes it to a named person with a Take over button, and the ask is put on
 * the watch stream's control state so anyone already watching sees it too.
 *
 * It then waits for exactly three things: a `release_control` naming this
 * takeover (or the lease taken for it running out), the workspace saying the
 * ask expired, or the deadline. None of them is evidence that the obstacle is
 * gone — the caller looks at the page afterwards (D5).
 */

import { v4 as uuidv4 } from "uuid";

import {
  pollTakeoverAsk,
  postTakeoverAsk,
} from "../tools/ask-question/workspace-inbox.js";
import { getLogger } from "../util/logger.js";
import type { LiveControl } from "./live-control.js";

const log = getLogger("live-takeover");

export const DEFAULT_TAKEOVER_DEADLINE_SECONDS = 1800;
const POLL_INTERVAL_MS = 15_000;

export interface TakeoverRequest {
  readonly reason: string;
  readonly whatToDo: string;
  readonly deadlineSeconds?: number;
  readonly page?: { url: string; title: string };
  readonly signal?: AbortSignal;
}

export type TakeoverResult =
  | {
      readonly outcome: "handed_back";
      readonly takeoverId: string;
      readonly result: "done" | "cannot";
      readonly note: string;
      readonly by: string;
      /** True when the hand-back was the lease running out, not a person. */
      readonly leaseExpired: boolean;
    }
  | { readonly outcome: "expired"; readonly takeoverId: string }
  | { readonly outcome: "cancelled"; readonly takeoverId: string }
  | { readonly outcome: "unavailable"; readonly reason: string };

export interface TakeoverDeps {
  readonly control: Pick<
    LiveControl,
    "openTakeover" | "closeTakeover" | "awaitTakeover"
  >;
  /** Whether anybody is on the watch stream right now. */
  readonly viewerCount: () => number;
  readonly post?: typeof postTakeoverAsk;
  readonly poll?: typeof pollTakeoverAsk;
  readonly pollIntervalMs?: number;
  readonly newId?: () => string;
}

export async function requestTakeover(
  request: TakeoverRequest,
  deps: TakeoverDeps,
): Promise<TakeoverResult> {
  const post = deps.post ?? postTakeoverAsk;
  const poll = deps.poll ?? pollTakeoverAsk;
  const takeoverId = (deps.newId ?? uuidv4)();
  const deadlineSeconds =
    request.deadlineSeconds ?? DEFAULT_TAKEOVER_DEADLINE_SECONDS;
  const deadlineAt = Date.now() + deadlineSeconds * 1000;

  const posted = await post({
    takeoverId,
    reason: request.reason,
    whatToDo: request.whatToDo,
    deadlineSeconds,
    page: request.page,
    signal: request.signal,
  });
  if (!posted.ok && deps.viewerCount() === 0) {
    // Nobody was asked and nobody is watching: waiting would be waiting for
    // no one, which is exactly what upstream's handoff did.
    log.info({ reason: posted.reason }, "No one could be asked to take over");
    return { outcome: "unavailable", reason: posted.reason };
  }
  if (!posted.ok) {
    log.warn(
      { reason: posted.reason },
      "Takeover ask did not reach the inbox; offering it to current watchers",
    );
  }

  deps.control.openTakeover(takeoverId, request.reason);
  const stopPolling = new AbortController();
  const onAbort = () => stopPolling.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const released = deps.control
      .awaitTakeover(takeoverId, deadlineAt - Date.now(), request.signal)
      .then((outcome) => ({ kind: "released" as const, outcome }));
    const workspace = posted.ok
      ? watchWorkspace(
          takeoverId,
          deadlineAt,
          poll,
          deps.pollIntervalMs ?? POLL_INTERVAL_MS,
          stopPolling.signal,
        )
      : new Promise<never>(() => {});
    const first = await Promise.race([released, workspace]);

    if (first.kind === "released") {
      if (first.outcome) {
        return {
          outcome: "handed_back",
          takeoverId,
          result: first.outcome.outcome,
          note: first.outcome.note,
          by: first.outcome.by,
          leaseExpired: first.outcome.reason === "lease_expired",
        };
      }
      return request.signal?.aborted
        ? { outcome: "cancelled", takeoverId }
        : { outcome: "expired", takeoverId };
    }
    if (first.kind === "answered") {
      // Aexy marked it answered without a hand-back reaching us first (the
      // relay dropped it, or the person answered from the inbox).
      return {
        outcome: "handed_back",
        takeoverId,
        result: first.response.outcome === "cannot" ? "cannot" : "done",
        note: first.response.note ?? "",
        by: first.response.by ?? "Someone",
        leaseExpired: false,
      };
    }
    return { outcome: "expired", takeoverId };
  } finally {
    stopPolling.abort();
    request.signal?.removeEventListener("abort", onAbort);
    deps.control.closeTakeover(takeoverId);
  }
}

type WorkspaceVerdict =
  | { kind: "expired" }
  | {
      kind: "answered";
      response: { outcome?: string; note?: string; by?: string };
    };

/**
 * Poll the ask until the workspace settles it. Never resolves on its own
 * deadline; the hand-back wait owns that. Never rejects.
 */
async function watchWorkspace(
  takeoverId: string,
  deadlineAt: number,
  poll: typeof pollTakeoverAsk,
  intervalMs: number,
  signal: AbortSignal,
): Promise<WorkspaceVerdict> {
  while (!signal.aborted && Date.now() < deadlineAt) {
    await sleep(Math.min(intervalMs, deadlineAt - Date.now()), signal);
    if (signal.aborted) {
      break;
    }
    const state = await poll(takeoverId, signal).catch(() => null);
    if (state?.status === "expired") {
      return { kind: "expired" };
    }
    if (state?.status === "answered") {
      return { kind: "answered", response: state.responses[0] ?? {} };
    }
    // pending / escalated / in_progress: still with somebody.
  }
  return new Promise<never>(() => {});
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** What the agent is told once the takeover ends. */
export function describeTakeover(result: TakeoverResult): string {
  switch (result.outcome) {
    case "handed_back":
      return result.leaseExpired
        ? `${result.by} took control but the lease expired before they handed it back.`
        : `${result.by} handed back control (${result.result})` +
            (result.note ? `: ${result.note}` : ".");
    case "expired":
      return "Nobody took over before the deadline.";
    case "cancelled":
      return "The takeover request was cancelled.";
    case "unavailable":
      return `Nobody could be asked to take over (${result.reason}).`;
  }
}
