/**
 * Parking a question in the workspace inbox, through the platform.
 *
 * The other escalation path — a guardian request card — needs a channel whose
 * notification adapter renders tappable options. Most assistants have no
 * messaging channel at all, so on those deployments `park` degraded to a
 * clean refusal: correct, and also the common case, which made the safest
 * policy the one that most often did nothing.
 *
 * This is the path that works without a channel. The question goes into the
 * workspace's own inbox, where it is addressed, escalated on a timer, and
 * answered by a named person on a web page they already have open. A channel
 * card, where one exists, becomes a notification about that row rather than
 * the only way to reach anybody.
 *
 * The pod never talks to the workspace directly. It calls the platform, which
 * holds the organisation-to-workspace mapping and mints a short-lived token
 * for the hop.
 */

import { resolveManagedProxyContext } from "../../providers/platform-proxy/context.js";
import type { SingleQuestion } from "./ask-question-tool.js";

/** How often to ask whether anybody has answered yet. */
const POLL_INTERVAL_MS = 15_000;

/** How long a single HTTP call to the platform may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** One person's decision on one question. */
export interface InboxResponse {
  questionId: string;
  decision: "option" | "free_text" | "skipped";
  optionId?: string;
  text?: string;
}

/**
 * What became of a parked question.
 *
 * `unavailable` and `expired` are deliberately distinct. The first is "we
 * could not ask", which leaves the caller to refuse as it would have anyway;
 * the second is "we asked, and nobody answered in time", which is a decision
 * the workspace made by not making one — and the run stops either way, but
 * only the second is worth telling the model about in those words.
 */
export type InboxOutcome =
  | { outcome: "answered"; responses: InboxResponse[] }
  | { outcome: "expired" }
  | { outcome: "timeout" }
  | { outcome: "unavailable"; reason: string };

interface ParkOptions {
  questions: SingleQuestion[];
  /** Daemon-assigned ids, one per question, in the same order. */
  questionIds: string[];
  /** The prompt's request id — idempotency and return address in one. */
  requestId: string;
  /** What the person sees as the asker. */
  assistantName?: string;
  /** What the assistant was doing when it got stuck. */
  context?: string;
  /** How long to wait for a person before giving up. */
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Whether this deployment can reach a workspace inbox at all. */
export async function canReachWorkspaceInbox(): Promise<boolean> {
  return (await resolveManagedProxyContext()).enabled;
}

/**
 * Put the question in the workspace inbox and wait for a person.
 *
 * Never throws. Every failure becomes an `unavailable` outcome, because the
 * caller's job on not reaching anybody is the same whatever went wrong: stop,
 * and say so. An exception escaping here would surface to the model as a tool
 * crash, which reads like a bug rather than like "nobody could be asked".
 */
export async function parkInWorkspaceInbox(
  options: ParkOptions,
): Promise<InboxOutcome> {
  const { platformBaseUrl, assistantApiKey, enabled } =
    await resolveManagedProxyContext();
  if (!enabled) {
    return {
      outcome: "unavailable",
      reason: "this assistant is not connected to a workspace",
    };
  }

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${assistantApiKey}`,
  };

  // The ids the daemon assigned are sent as-is: the answer comes back keyed
  // by them, and a question whose id changed in transit is an answer
  // delivered to the wrong prompt.
  const body = JSON.stringify({
    origin_ref: options.requestId,
    assistant_name: options.assistantName,
    context: options.context,
    questions: options.questions.map((question, index) => ({
      id: options.questionIds[index],
      question: question.question,
      description: question.description,
      options: question.options,
      freeTextPlaceholder: question.freeTextPlaceholder,
    })),
  });

  const parked = await call(
    `${platformBaseUrl}/v1/human-help/ask`,
    { method: "POST", headers, body },
    options.signal,
  );
  if (!parked.ok) {
    return { outcome: "unavailable", reason: parked.reason };
  }

  const deadline = Date.now() + options.timeoutMs;
  // The question is already recorded and already in front of somebody, so a
  // failed poll is a reason to try again rather than to give up: the platform
  // restarting must not turn an answerable question into a refusal.
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      return { outcome: "unavailable", reason: "the turn was cancelled" };
    }
    await sleep(
      Math.min(POLL_INTERVAL_MS, deadline - Date.now()),
      options.signal,
    );
    if (options.signal?.aborted) {
      return { outcome: "unavailable", reason: "the turn was cancelled" };
    }

    const polled = await call(
      `${platformBaseUrl}/v1/human-help/${encodeURIComponent(options.requestId)}`,
      { method: "GET", headers },
      options.signal,
    );
    if (!polled.ok) {
      continue;
    }
    const status = String(polled.body?.status ?? "");
    if (status === "answered") {
      const responses = polled.body?.answer?.responses;
      return {
        outcome: "answered",
        responses: Array.isArray(responses) ? responses : [],
      };
    }
    if (status === "expired") {
      return { outcome: "expired" };
    }
    // `pending` and `escalated` are both "still with somebody".
  }

  return { outcome: "timeout" };
}

/** A polled question, as much of it as this side reads. */
interface PolledQuestion {
  status?: string;
  answer?: { responses?: InboxResponse[] };
}

type CallResult =
  | { ok: true; body: PolledQuestion }
  | { ok: false; reason: string };

async function call(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<CallResult> {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => timer.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: timer.signal });
    if (!response.ok) {
      return {
        ok: false,
        reason: `the workspace inbox answered ${response.status}`,
      };
    }
    return { ok: true, body: (await response.json()) as PolledQuestion };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? `the workspace inbox could not be reached: ${error.message}`
          : "the workspace inbox could not be reached",
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
