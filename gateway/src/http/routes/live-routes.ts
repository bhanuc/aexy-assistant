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
import { z } from "zod";

import { findVellumGuardian } from "../../auth/guardian-bootstrap.js";
import type { GatewayConfig } from "../../config.js";
import {
  conversationOwner,
  listAccessEntries,
  recordConversationOwner,
  replaceAccessEntries,
  type AccessEntry,
} from "../../live-view/access-store.js";
import {
  actingUserHeaders,
  mintGuardianExchangeToken,
} from "../../live-view/acting-user.js";
import { forwardToDaemon } from "../../live-view/daemon-forward.js";
import { isLiveViewEnabled } from "../../live-view/flag.js";
import { isPrivilegedRole, VIEWER_ROLES } from "../../live-view/roles.js";
import { authorizeLiveServiceCall } from "../../live-view/service-auth.js";
import { getLogger } from "../../logger.js";
import { readJsonObjectBody } from "../route-helpers.js";
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

function forbidden(code: string, message: string): Response {
  return Response.json({ error: "Forbidden", code, message }, { status: 403 });
}

function badRequest(message: string): Response {
  return Response.json({ error: "Bad Request", message }, { status: 400 });
}

/**
 * `GET /v1/live/threads?user=all|<aexy_developer_id>` (C5, C6): the threads
 * index. The guardian and an owner, manager or admin on the access list may
 * ask for anyone's (`all`, or a named developer); a member only ever gets
 * their own, whatever they asked for, and asking for someone else's is a 403
 * rather than a quietly narrowed answer.
 *
 * The daemon knows whose a thread is by platform user (it is in the
 * conversation key, which survives a restart); only the access list knows
 * which Aexy developer that is. So the daemon is asked by platform user and
 * its answer is named back in Aexy's terms here. A developer not on the list
 * is the guardian: the owner is not an entry, and is who is left.
 */
async function handleThreads(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const auth = await authorizeLiveServiceCall(req, log);
  if (!auth.ok) return auth.response;
  const asked = new URL(req.url).searchParams.get("user")?.trim() || null;
  const caller = auth.caller;
  const entries = listAccessEntries();

  let platformUser: string;
  if (caller.kind === "entry" && !isPrivilegedRole(caller.entry.role)) {
    if (asked && asked !== caller.entry.aexyDeveloperId) {
      return forbidden(
        "threads_not_yours",
        "Only owners, managers and admins may list other people's threads",
      );
    }
    platformUser = caller.entry.platformUserId;
  } else if (!asked || asked === "all") {
    platformUser = "all";
  } else {
    platformUser =
      entries.find((e) => e.aexyDeveloperId === asked)?.platformUserId ??
      "guardian";
  }

  const res = await forwardToDaemon(config, {
    method: "GET",
    path: "/v1/live/threads",
    search: `?${new URLSearchParams({ platform_user: platformUser })}`,
    headers: caller.kind === "entry" ? actingUserHeaders(caller.entry) : {},
  });
  if (res.status >= 400) return res;

  const threads = DaemonThreads.safeParse(await res.json().catch(() => null));
  if (!threads.success) {
    log.error({ status: res.status }, "live threads: unreadable daemon answer");
    return Response.json({ error: "Bad Gateway" }, { status: 502 });
  }
  const developerOf = new Map(
    entries.map((e) => [e.platformUserId, e.aexyDeveloperId]),
  );
  return Response.json(
    threads.data.map((t) => ({
      conversation_id: t.conversation_id,
      aexy_developer_id: t.platform_user_id
        ? (developerOf.get(t.platform_user_id) ?? null)
        : null,
      title: t.title,
      updated_at: t.updated_at,
    })),
  );
}

const DaemonThreads = z.array(
  z.object({
    conversation_id: z.string().min(1),
    platform_user_id: z.string().nullable(),
    title: z.string().nullable(),
    updated_at: z.string(),
  }),
);

const AccessListBody = z.object({
  entries: z.array(
    z.object({
      platform_user_id: z.string().trim().min(1),
      aexy_developer_id: z.string().trim().min(1),
      display_name: z.string(),
      role: z.enum(VIEWER_ROLES),
      can_chat: z.boolean(),
    }),
  ),
});

/**
 * `PUT /v1/live/access-list` (C6): the whole list, replacing the last one.
 * Pushed by the control plane on every change in Aexy; the guardian or an
 * owner, manager or admin already on the list may send it.
 */
async function handleAccessList(req: Request): Promise<Response> {
  const auth = await authorizeLiveServiceCall(req, log);
  if (!auth.ok) return auth.response;
  if (
    auth.caller.kind === "entry" &&
    !isPrivilegedRole(auth.caller.entry.role)
  ) {
    return forbidden(
      "access_list_not_yours",
      "Only owners, managers and admins may change who has access",
    );
  }
  const body = await readJsonObjectBody(req, MAX_LIVE_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = AccessListBody.safeParse(body);
  if (!parsed.success) {
    return badRequest("entries must be a list of access entries (C6)");
  }
  const seen = new Set<string>();
  const entries: AccessEntry[] = [];
  for (const e of parsed.data.entries) {
    if (seen.has(e.platform_user_id)) {
      return badRequest(
        `platform_user_id ${e.platform_user_id} is listed twice`,
      );
    }
    seen.add(e.platform_user_id);
    entries.push({
      platformUserId: e.platform_user_id,
      aexyDeveloperId: e.aexy_developer_id,
      displayName: e.display_name,
      role: e.role,
      canChat: e.can_chat,
    });
  }
  try {
    replaceAccessEntries(entries);
  } catch (err) {
    log.error({ err }, "live access list: write failed");
    return Response.json({ error: "Service Unavailable" }, { status: 503 });
  }
  return Response.json({ ok: true, entries: entries.length });
}

const ChatBody = z.object({
  conversation_id: z.string().trim().min(1).nullable().optional(),
  text: z.string().refine((t) => t.trim().length > 0, "text is empty"),
});

const DaemonSendReply = z.object({ conversationId: z.string().min(1) });

/**
 * `POST /v1/live/chat/messages` (C5 chat relay, C6): `{conversation_id?,
 * text}` → `{conversation_id}`, sent as the acting person.
 *
 * The guardian, or anyone on the access list with `can_chat`. Each person
 * posts only to their own conversations: one they started here, or for the
 * guardian one nobody on the list started. Reading someone else's is the
 * threads index's business, never this route's.
 *
 * Delivered as the daemon's ordinary `POST /v1/messages`, on the guardian's
 * actor principal (the only one the daemon knows) with the acting-user
 * headers naming who is really speaking; see `live-view/acting-user.ts`.
 */
async function handleChat(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const auth = await authorizeLiveServiceCall(req, log);
  if (!auth.ok) return auth.response;
  const caller = auth.caller;
  if (caller.kind === "entry" && !caller.entry.canChat) {
    return forbidden("chat_not_allowed", "This person may not chat here");
  }
  const body = await readJsonObjectBody(req, MAX_LIVE_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = ChatBody.safeParse(body);
  if (!parsed.success) {
    return badRequest("expected {conversation_id?, text}");
  }
  const conversationId = parsed.data.conversation_id ?? undefined;
  if (conversationId) {
    const owner = conversationOwner(conversationId);
    const mine =
      caller.kind === "guardian"
        ? owner === undefined
        : owner?.platformUserId === caller.entry.platformUserId;
    if (!mine) {
      return forbidden(
        "not_your_conversation",
        "A conversation can only be continued by the person who started it",
      );
    }
  }

  let guardian: { principalId: string } | null;
  try {
    guardian = await findVellumGuardian();
  } catch (err) {
    log.error({ err }, "live chat: guardian lookup failed");
    return Response.json({ error: "Service Unavailable" }, { status: 503 });
  }
  if (!guardian) {
    return Response.json(
      { error: "Service Unavailable", message: "No guardian is bound" },
      { status: 503 },
    );
  }

  const res = await forwardToDaemon(config, {
    method: "POST",
    path: "/v1/messages",
    body: JSON.stringify({
      ...(conversationId ? { conversationId } : {}),
      content: parsed.data.text,
      sourceChannel: "vellum",
      interface: "vellum",
    }),
    token: mintGuardianExchangeToken(guardian.principalId),
    headers: caller.kind === "entry" ? actingUserHeaders(caller.entry) : {},
  });
  if (res.status >= 400) return res;

  const reply = DaemonSendReply.safeParse(await res.json().catch(() => null));
  if (!reply.success) {
    log.error(
      { status: res.status },
      "live chat: daemon named no conversation",
    );
    return Response.json({ error: "Bad Gateway" }, { status: 502 });
  }
  const sentTo = reply.data.conversationId;
  if (caller.kind === "entry" && !conversationId) {
    recordConversationOwner(sentTo, {
      platformUserId: caller.entry.platformUserId,
      aexyDeveloperId: caller.entry.aexyDeveloperId,
    });
  }
  return Response.json({ conversation_id: sentTo }, { status: res.status });
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
    {
      path: "/v1/live/access-list",
      method: "PUT",
      auth: "custom",
      handler: gated((req) => handleAccessList(req)),
    },
    {
      path: "/v1/live/chat/messages",
      method: "POST",
      auth: "custom",
      handler: gated(handleChat),
    },
  ];
}
