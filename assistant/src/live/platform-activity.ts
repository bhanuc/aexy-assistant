/**
 * Tell the platform someone is watching, so it does not put the pod to sleep
 * under them (C2 behaviour). The same call the gateway makes on inbound Slack
 * traffic, throttled the same way: at most one POST per 30 seconds.
 */

import { VellumPlatformClient } from "../platform/client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("live-platform-activity");

export const RECORD_ACTIVITY_THROTTLE_MS = 30_000;

let lastRecordedAt = 0;

export async function recordWatchActivity(
  now: number = Date.now(),
): Promise<void> {
  if (now - lastRecordedAt < RECORD_ACTIVITY_THROTTLE_MS) {
    return;
  }
  lastRecordedAt = now;
  try {
    const client = await VellumPlatformClient.create();
    const assistantId = client?.platformAssistantId;
    if (!client || !assistantId) {
      return;
    }
    const res = await client.fetch(
      `/v1/assistants/${encodeURIComponent(assistantId)}/record-activity`,
      { method: "POST", signal: AbortSignal.timeout(10_000) },
    );
    await res.body?.cancel();
    if (!res.ok) {
      log.warn({ status: res.status }, "record-activity was refused");
    }
  } catch (err) {
    log.debug({ err }, "Could not record watch activity");
  }
}

/** @internal Test helper. */
export function _resetWatchActivityForTests(): void {
  lastRecordedAt = 0;
}
