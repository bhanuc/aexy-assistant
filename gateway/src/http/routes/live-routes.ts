/**
 * The Aexy live-view service routes (contract C2.1, C4.1, C6), behind the
 * `aexy-live-view` fork flag.
 *
 * All of them are service-authenticated (`live-view/service-auth.ts`): Aexy
 * reaches them through the control plane and the orchestrator proxy, never
 * through the tunnel, and none is on the velay allowlist.
 *
 * With the flag off each route hands the request to `fallthrough`, the
 * runtime-proxy catch-all it would have reached upstream, so an upstream
 * build's answer to these paths is exactly what it always was.
 */

import type { Logger } from "pino";

import type { GatewayConfig } from "../../config.js";
import { forwardToDaemon } from "../../live-view/daemon-forward.js";
import { isLiveViewEnabled } from "../../live-view/flag.js";
import { authorizeLiveServiceCall } from "../../live-view/service-auth.js";
import { getLogger } from "../../logger.js";
import { readLimitedBodyBytes } from "../read-limited-body.js";
import type { GetClientIp, RouteDefinition } from "../router.js";

const log: Logger = getLogger("live-routes");

/** Control bodies are a command and a sentence or two of instruction. */
export const MAX_LIVE_BODY_BYTES = 1024 * 1024;

type Fallthrough = (
  req: Request,
  getClientIp: GetClientIp,
) => Promise<Response> | Response;

function payloadTooLarge(): Response {
  return Response.json({ error: "Payload Too Large" }, { status: 413 });
}

async function readBody(
  req: Request,
): Promise<Uint8Array<ArrayBuffer> | Response> {
  const body = await readLimitedBodyBytes(req, MAX_LIVE_BODY_BYTES);
  if (body.status === "too_large") return payloadTooLarge();
  if (body.status === "unreadable") {
    return Response.json({ error: "Bad Request" }, { status: 400 });
  }
  return body.bytes;
}

/**
 * `POST /v1/live/control` (C4.1): the command body, unchanged, to the
 * daemon's `POST /v1/live/control`, and its answer back verbatim. The actor
 * is named in the body; Aexy wrote the intervention row before sending it.
 */
async function handleControl(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const auth = await authorizeLiveServiceCall(req, log);
  if (!auth.ok) return auth.response;
  const body = await readBody(req);
  if (body instanceof Response) return body;
  return forwardToDaemon(config, {
    method: "POST",
    path: "/v1/live/control",
    body,
    contentType: req.headers.get("content-type") ?? "application/json",
  });
}

/**
 * `GET /v1/watch/snapshot` (C2.1): the last frame for a tile, as the
 * daemon's JPEG bytes and `x-frame-*` headers, or its 204.
 */
async function handleSnapshot(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const auth = await authorizeLiveServiceCall(req, log);
  if (!auth.ok) return auth.response;
  return forwardToDaemon(config, {
    method: "GET",
    path: "/v1/watch/snapshot",
  });
}

/** `GET /v1/live/threads?user=all|<aexy_developer_id>` (C5, C6). */
async function handleThreads(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const auth = await authorizeLiveServiceCall(req, log);
  if (!auth.ok) return auth.response;
  return forwardToDaemon(config, {
    method: "GET",
    path: "/v1/live/threads",
    search: new URL(req.url).search,
  });
}

/** The live-view routes, to be mounted ahead of the runtime-proxy catch-all. */
export function createLiveViewRoutes(
  config: GatewayConfig,
  fallthrough: Fallthrough,
): RouteDefinition[] {
  const gated =
    (handler: (req: Request, config: GatewayConfig) => Promise<Response>) =>
    (req: Request, _params: string[], getClientIp: GetClientIp) =>
      isLiveViewEnabled()
        ? handler(req, config)
        : fallthrough(req, getClientIp);

  return [
    {
      path: "/v1/live/control",
      method: "POST",
      auth: "custom",
      handler: gated(handleControl),
    },
    {
      path: "/v1/watch/snapshot",
      method: "GET",
      auth: "custom",
      handler: gated(handleSnapshot),
    },
    {
      path: "/v1/live/threads",
      method: "GET",
      auth: "custom",
      handler: gated(handleThreads),
    },
  ];
}
