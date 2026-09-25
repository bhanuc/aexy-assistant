/**
 * Aexy live view routes (fork). Service-authenticated like every other
 * gateway→daemon route: the gateway is the only caller, and it has already
 * decided who the person is (contracts C2.1, C4.2).
 *
 * - `GET /v1/watch/snapshot` — the newest frame of the agent's page, for the
 *   "agents at work" tiles, which poll rather than stream.
 * - `POST /v1/live/control` — pause, resume, instruct, stop, take control and
 *   hand it back (see `live/live-control.ts`).
 */

import { getDesktopSessionManager } from "../../desktop/desktop-session-manager.js";
import { getLiveControl } from "../../live/live-control-runtime.js";
import { isLiveViewEnabled } from "../../live/live-view-feature.js";
import type { ScreencastFrame } from "../../live/screencast.js";
import { listChatThreads, type ThreadsFor } from "../../live/threads.js";
import { getLiveWatchHub } from "../../live/watch-hub.js";
import { GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { type RouteDefinition, RouteResponse } from "./types.js";

/** A cast frame this recent is the snapshot; older, a fresh still is taken. */
const SNAPSHOT_FRESH_MS = 5_000;

let lastStill: ScreencastFrame | null = null;

/** Exported for tests. */
export async function handleWatchSnapshot(
  deps: {
    enabled?: () => boolean;
    lastFrame?: () => ScreencastFrame | null;
    desktopReady?: () => boolean;
    captureStill?: () => Promise<ScreencastFrame | null>;
    now?: () => number;
  } = {},
): Promise<RouteResponse> {
  const enabled = deps.enabled ?? (() => isLiveViewEnabled());
  if (!enabled()) {
    throw new NotFoundError("The live view is not available on this assistant");
  }
  const now = deps.now ?? Date.now;
  const lastFrame = deps.lastFrame ?? (() => getLiveWatchHub().getLastFrame());
  const desktopReady =
    deps.desktopReady ??
    (() => getDesktopSessionManager().getState() === "ready");
  const captureStill = deps.captureStill ?? captureDesktopStill;

  let frame = newest(lastFrame(), lastStill);
  if (!frame || now() - Date.parse(frame.ts) > SNAPSHOT_FRESH_MS) {
    // Nobody is watching, so nothing is being cast: take a still, but only
    // of a desktop that is already up. A tile must never start one.
    if (desktopReady()) {
      const still = await captureStill();
      if (still) {
        lastStill = still;
        frame = still;
      }
    }
  }
  if (!frame) {
    return new RouteResponse(null, {}, 204);
  }
  return new RouteResponse(new Uint8Array(frame.jpeg), {
    "content-type": "image/jpeg",
    "cache-control": "no-store",
    "x-frame-ts": frame.ts,
    "x-frame-url": encodeURI(frame.url),
  });
}

function newest(
  a: ScreencastFrame | null,
  b: ScreencastFrame | null,
): ScreencastFrame | null {
  if (!a || !b) {
    return a ?? b;
  }
  return Date.parse(a.ts) >= Date.parse(b.ts) ? a : b;
}

async function captureDesktopStill(): Promise<ScreencastFrame | null> {
  const jpeg = await getLiveWatchHub().captureScreenshot();
  if (!jpeg) {
    return null;
  }
  return {
    jpeg,
    width: 0,
    height: 0,
    url: "",
    title: "",
    ts: new Date().toISOString(),
  };
}

/** @internal Test helper. */
export function _resetWatchSnapshotForTests(): void {
  lastStill = null;
}

/** Exported for tests. */
export async function handleLiveControlRoute(
  body: unknown,
  deps: {
    enabled?: () => boolean;
    handle?: (
      body: unknown,
    ) => Promise<{ status: number; body: Record<string, unknown> }>;
  } = {},
): Promise<RouteResponse> {
  const enabled = deps.enabled ?? (() => isLiveViewEnabled());
  if (!enabled()) {
    throw new NotFoundError("The live view is not available on this assistant");
  }
  const handle = deps.handle ?? ((b) => getLiveControl().handle(b));
  const result = await handle(body);
  return new RouteResponse(
    JSON.stringify(result.body),
    { "content-type": "application/json" },
    result.status,
  );
}

/**
 * `GET /v1/live/threads?platform_user=all|guardian|<id>` (C6): the chat
 * threads index, by platform user. Only the gateway calls it, and only after
 * deciding who may see whose; it maps the answer to Aexy developer ids.
 * Exported for tests.
 */
export function handleLiveThreads(
  platformUser: string | undefined,
  deps: { enabled?: () => boolean } = {},
): RouteResponse {
  const enabled = deps.enabled ?? (() => isLiveViewEnabled());
  if (!enabled()) {
    throw new NotFoundError("The live view is not available on this assistant");
  }
  const asked = platformUser?.trim();
  if (!asked) {
    throw new BadRequestError(
      "platform_user is required: all, guardian or an id",
    );
  }
  const who: ThreadsFor =
    asked === "all" || asked === "guardian" ? asked : { platformUserId: asked };
  return new RouteResponse(
    JSON.stringify(listChatThreads(who)),
    { "content-type": "application/json" },
    200,
  );
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "live_control",
    endpoint: "live/control",
    method: "POST",
    policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
    handler: ({ body }) => handleLiveControlRoute(body),
    summary: "Intervene in the running agent",
    description:
      "Aexy live view (C4.2): pause, resume, instruct, stop, acquire_control, release_control. signin_decision answers 501 not_implemented.",
    tags: ["live"],
    additionalResponses: {
      "409": { description: "control_held or no_active_run" },
      "422": { description: "Unknown command or malformed actor or text" },
      "501": { description: "signin_decision is not implemented" },
    },
  },
  {
    operationId: "watch_snapshot",
    endpoint: "watch/snapshot",
    method: "GET",
    policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
    handler: () => handleWatchSnapshot(),
    summary: "Latest frame of the agent's browser",
    description:
      "Aexy live view (C2.1): the newest JPEG of the page the agent is on, with x-frame-ts and x-frame-url, or 204 when there is none.",
    tags: ["live"],
    additionalResponses: {
      "204": { description: "No frame exists" },
      "404": { description: "The live view is off on this assistant" },
    },
  },
  {
    operationId: "live_threads",
    endpoint: "live/threads",
    method: "GET",
    policy: { requiredScopes: [], allowedPrincipalTypes: GATEWAY_PRINCIPALS },
    handler: ({ queryParams }) => handleLiveThreads(queryParams?.platform_user),
    summary: "Chat threads by who started them",
    description:
      "Aexy live view (C6): person-facing conversations with the platform user who started each (null for the guardian's), newest first.",
    tags: ["live"],
    additionalResponses: {
      "400": { description: "No platform_user" },
      "404": { description: "The live view is off on this assistant" },
    },
  },
];
