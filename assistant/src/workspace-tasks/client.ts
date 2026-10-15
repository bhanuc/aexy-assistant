/**
 * Reading and working the cards a workspace assigned to this assistant.
 *
 * The pod never talks to the workspace directly. It calls the platform, which
 * holds the organisation-to-workspace mapping and mints a short-lived token
 * for the hop — the same path `workspace-inbox.ts` takes for a parked
 * question, carrying work the other way.
 *
 * Pulled rather than pushed, and the reason is this side: a pod sleeps, and a
 * sleeping pod cannot receive anything. So it wakes, asks what it has been
 * given, and asks again later.
 *
 * **A refusal here is an answer, not an outage.** The workspace says no when
 * somebody else holds the card, when a person pressed stop, or when the claim
 * ran out of time. Retrying any of those is the one thing this side must not
 * do, so `refused` and `unavailable` are separate outcomes and only the second
 * is worth trying again.
 */

import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("workspace-tasks-client");

/** How long a single HTTP call to the platform may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** One card, as the workspace describes it. */
export interface WorkspaceTask {
  id: string;
  task_key?: number | null;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  task_type: string;
  due_at?: string | null;
}

/** What the workspace says this assistant is, and what it has been given. */
export interface WorkspaceTaskQueue {
  developer_id: string;
  assistant_name: string;
  tasks: WorkspaceTask[];
}

/** A card this assistant now holds, and the bounds it holds it under. */
export interface WorkspaceTaskClaim {
  id: string;
  task_id: string;
  status: string;
  claimed_at: string;
  /** Hard stop. The workspace takes the card back at this moment. */
  expires_at: string;
  heartbeat_every_seconds: number;
  budget_seconds: number;
  budget_spend_cents?: number | null;
  budget_capabilities?: string[];
}

/**
 * What came of a call.
 *
 * `refused` and `unavailable` are deliberately distinct, and the distinction
 * is the whole reason this type exists rather than a thrown error. A refusal
 * is the workspace deciding something — stop, somebody else has it, your time
 * is up — and the right response is to stop. Unavailable is the network, and
 * the right response is to try again.
 */
export type TaskCallResult<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "refused"; reason: string }
  | { outcome: "unavailable"; reason: string };

/** Whether this deployment is connected to a workspace at all. */
export async function canReachWorkspaceTasks(): Promise<boolean> {
  return (await resolveManagedProxyContext()).enabled;
}

/** The cards assigned to this assistant that are ready to be started. */
export async function readTaskQueue(
  signal?: AbortSignal,
): Promise<TaskCallResult<WorkspaceTaskQueue>> {
  return call<WorkspaceTaskQueue>("/v1/tasks/mine", { method: "GET" }, signal);
}

/**
 * Take a card before starting work on it.
 *
 * A refusal is ordinary and expected: another pod, or this pod on a duplicate
 * wake, may already hold it. The card is simply not this run's work.
 */
export async function claimTask(
  taskId: string,
  signal?: AbortSignal,
  conversationId?: string,
): Promise<TaskCallResult<WorkspaceTaskClaim>> {
  return call<WorkspaceTaskClaim>(
    `/v1/tasks/${encodeURIComponent(taskId)}/claim`,
    { method: "POST", body: conversationBody(conversationId) },
    signal,
  );
}

/**
 * Say the work is still going, and find out whether it may continue.
 *
 * **A refusal means stop.** It is how a person's stop button reaches this
 * process: the workspace cannot call into the pod, so the pod comes and asks.
 * Treating it as a transient failure and carrying on would defeat the only
 * control anybody has over unattended work.
 */
export async function heartbeatTask(
  taskId: string,
  signal?: AbortSignal,
  conversationId?: string,
): Promise<TaskCallResult<WorkspaceTaskClaim>> {
  return call<WorkspaceTaskClaim>(
    `/v1/tasks/${encodeURIComponent(taskId)}/heartbeat`,
    { method: "POST", body: conversationBody(conversationId) },
    signal,
  );
}

/**
 * Which conversation is working the card (C8), so the workspace can say
 * which run a card is and open its live view. Omitted until there is one.
 */
function conversationBody(conversationId: string | undefined): string {
  return conversationId
    ? JSON.stringify({ conversation_id: conversationId })
    : "{}";
}

/**
 * Leave a progress note in the card's ordinary activity feed.
 *
 * `attachmentIds` link files already uploaded under this claim to the note.
 */
export async function reportTaskProgress(
  taskId: string,
  note: string,
  spendCents?: number,
  signal?: AbortSignal,
  attachmentIds?: string[],
): Promise<TaskCallResult<unknown>> {
  return call(
    `/v1/tasks/${encodeURIComponent(taskId)}/activity`,
    {
      method: "POST",
      body: JSON.stringify({
        note,
        spend_cents: spendCents,
        ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}),
      }),
    },
    signal,
  );
}

/** A file the workspace accepted onto the card. */
export interface UploadedTaskAttachment {
  id: string;
  file_name: string;
  content_type: string | null;
  file_size: number | null;
  url: string;
}

/** The workspace's per-file limit; checked here so nothing oversized is sent. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Uploads are bigger than a JSON note, so they get longer than a note does. */
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Put a file from the sandbox on the card, as the pod's deliverable.
 *
 * Takes the bytes, not a path. The caller (`attachments.ts`) opened and vetted
 * the file descriptor the bytes came from; reading the path again here would
 * reopen the window between the check and the read that it closes.
 */
export async function uploadTaskAttachment(
  taskId: string,
  bytes: Buffer<ArrayBuffer>,
  fileName: string,
  note?: string,
  signal?: AbortSignal,
): Promise<TaskCallResult<UploadedTaskAttachment>> {
  if (bytes.byteLength === 0) {
    return { outcome: "refused", reason: "the file is empty" };
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      outcome: "refused",
      reason: `the file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
    };
  }
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  if (note?.trim()) {
    form.append("note", note.trim().slice(0, 2000));
  }
  return call<UploadedTaskAttachment>(
    `/v1/tasks/${encodeURIComponent(taskId)}/attachments`,
    { method: "POST", body: form },
    signal,
    UPLOAD_TIMEOUT_MS,
  );
}

/**
 * Hand the work in.
 *
 * The workspace puts the card up for review, never straight to done — nothing
 * on its side witnessed the work, so what this reports is a claim rather than
 * a fact, and a person decides.
 */
export async function submitTask(
  taskId: string,
  summary: string,
  signal?: AbortSignal,
  attachmentIds?: string[],
): Promise<TaskCallResult<WorkspaceTaskClaim>> {
  return call<WorkspaceTaskClaim>(
    `/v1/tasks/${encodeURIComponent(taskId)}/submit`,
    {
      method: "POST",
      body: JSON.stringify({
        summary,
        ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}),
      }),
    },
    signal,
  );
}

/** Give the card back, having decided it cannot be done. */
export async function releaseTask(
  taskId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<TaskCallResult<WorkspaceTaskClaim>> {
  return call<WorkspaceTaskClaim>(
    `/v1/tasks/${encodeURIComponent(taskId)}/release`,
    { method: "POST", body: JSON.stringify({ reason }) },
    signal,
  );
}

/** Longest a `Retry-After` is honoured, and how many times it is followed. */
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 2;

/** `Retry-After` in milliseconds (seconds form only), capped. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 1_000;
  }
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * One call, following the platform's 429s: wait what it asked (capped) and
 * try again, twice at most. A 429 means the request was not processed, so
 * repeating it cannot duplicate anything.
 */
async function call<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<TaskCallResult<T>> {
  let result = await callOnce<T>(path, init, signal, timeoutMs);
  for (
    let attempt = 0;
    attempt < MAX_RATE_LIMIT_RETRIES && result.rateLimitedForMs !== undefined;
    attempt++
  ) {
    await sleep(result.rateLimitedForMs, signal);
    if (signal?.aborted) {
      break;
    }
    result = await callOnce<T>(path, init, signal, timeoutMs);
  }
  const { rateLimitedForMs: _unused, ...settled } = result;
  return settled as TaskCallResult<T>;
}

async function callOnce<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<TaskCallResult<T> & { rateLimitedForMs?: number }> {
  const { platformBaseUrl, assistantApiKey, enabled } =
    await resolveManagedProxyContext();
  if (!enabled) {
    return {
      outcome: "unavailable",
      reason: "this assistant is not connected to a workspace",
    };
  }

  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), timeoutMs);
  const onAbort = () => timer.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(`${platformBaseUrl}${path}`, {
      ...init,
      headers: {
        // A multipart body carries its own content type, with the boundary.
        ...(init.body instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
        authorization: `Bearer ${assistantApiKey}`,
      },
      signal: timer.signal,
    });
    if (response.ok) {
      return { outcome: "ok", value: (await response.json()) as T };
    }
    // 4xx is the workspace deciding. Anything else is the workspace being
    // unreachable in a more complicated way than a connection error, and is
    // worth retrying.
    if (response.status >= 400 && response.status < 500) {
      return {
        outcome: "refused",
        reason: await refusalText(response),
        ...(response.status === 429
          ? { rateLimitedForMs: retryAfterMs(response) }
          : {}),
      };
    }
    return {
      outcome: "unavailable",
      reason: `the workspace answered ${response.status}`,
    };
  } catch (error) {
    return {
      outcome: "unavailable",
      reason:
        error instanceof Error
          ? `the workspace could not be reached: ${error.message}`
          : "the workspace could not be reached",
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The refusal in words, when the platform bothered to give any. */
async function refusalText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      detail?: string | { code?: string; message?: string };
      message?: string;
    };
    const detail = body?.detail;
    const text =
      typeof detail === "object" && detail !== null
        ? (detail.message ?? detail.code)
        : (detail ?? body?.message);
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  } catch (error) {
    log.debug({ err: error }, "Refusal body was not JSON");
  }
  return `the workspace answered ${response.status}`;
}
