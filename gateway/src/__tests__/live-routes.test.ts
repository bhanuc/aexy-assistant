import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyToken } from "../auth/token-service.js";
import { AuthRateLimiter } from "../auth-rate-limiter.js";
import { createRouter } from "../http/router.js";
import { setVelayBridgeAuthHeader } from "../velay/bridge-auth.js";
import {
  GUARDIAN_PRINCIPAL,
  VELAY_USER_ID,
  makeConfig,
  mintEdgeToken,
  mintServiceEdgeToken,
} from "./runtime-stream-test-utils.js";

let liveViewEnabled = true;
mock.module("../feature-flag-resolver.js", () => ({
  isFeatureFlagEnabled: (key: string) =>
    key === "aexy-live-view" ? liveViewEnabled : false,
  getFeatureFlagValue: (key: string) =>
    key === "aexy-live-view" ? liveViewEnabled : false,
  isPlatformMode: () => false,
  arePlatformFeaturesEnabled: () => true,
}));
mock.module("../auth/guardian-bootstrap.js", () => ({
  findVellumGuardian: async () => ({ principalId: GUARDIAN_PRINCIPAL }),
}));
let storedPlatformUser: { userId?: string; unreachable: boolean } = {
  userId: VELAY_USER_ID,
  unreachable: false,
};
mock.module("../platform-user-id.js", () => ({
  readStoredPlatformUserId: async () => storedPlatformUser,
}));

/** One daemon call the gateway made. */
interface DaemonCall {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
}
let daemonCalls: DaemonCall[] = [];
let daemonReply: () => Response = () => Response.json({ ok: true });
mock.module("../fetch.js", () => ({
  fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    daemonCalls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body:
        body === undefined || body === null
          ? null
          : typeof body === "string"
            ? body
            : new TextDecoder().decode(body as Uint8Array),
    });
    return daemonReply();
  },
}));

const { createLiveViewRoutes } = await import("../http/routes/live-routes.js");
const {
  clearLiveAccessStoreCache,
  conversationOwner,
  getLiveAccessStorePath,
  recordConversationOwner,
} = await import("../live-view/access-store.js");

const fallthrough = mock(async (_req: Request) =>
  Response.json({ source: "runtime-proxy" }, { status: 418 }),
);

function route(req: Request): Promise<Response | null> {
  const router = createRouter(createLiveViewRoutes(makeConfig(), fallthrough), {
    authRateLimiter: new AuthRateLimiter(),
  });
  return router(req, new URL(req.url), () => "10.0.0.1");
}

/** A request as the orchestrator proxy delivers it to a managed pod. */
function managed(
  path: string,
  init: RequestInit & { userId?: string | null } = {},
): Request {
  const headers = new Headers(init.headers);
  const userId = init.userId === undefined ? VELAY_USER_ID : init.userId;
  if (userId !== null) headers.set("x-vellum-user-id", userId);
  return new Request(`http://localhost:7830${path}`, { ...init, headers });
}

function managedMode() {
  process.env.IS_PLATFORM = "true";
  process.env.DISABLE_HTTP_AUTH = "true";
}

let securityDir: string;

beforeEach(() => {
  securityDir = mkdtempSync(join(tmpdir(), "live-routes-test-"));
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  clearLiveAccessStoreCache();
  liveViewEnabled = true;
  daemonCalls = [];
  daemonReply = () => Response.json({ ok: true });
  storedPlatformUser = { userId: VELAY_USER_ID, unreachable: false };
  fallthrough.mockClear();
});

afterEach(() => {
  delete process.env.IS_PLATFORM;
  delete process.env.DISABLE_HTTP_AUTH;
  delete process.env.GATEWAY_SECURITY_DIR;
  clearLiveAccessStoreCache();
  rmSync(securityDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /v1/live/control (C4.1)
// ---------------------------------------------------------------------------

describe("POST /v1/live/control", () => {
  const COMMAND = JSON.stringify({
    command: "instruct",
    actor: {
      aexy_developer_id: "dev-1",
      display_name: "Priya",
      role: "member",
    },
    intervention_id: "iv-1",
    text: "Use the venue on 5th instead",
  });

  test("relays the body unchanged to the daemon and its answer back verbatim", async () => {
    managedMode();
    daemonReply = () =>
      Response.json(
        {
          ok: false,
          code: "control_held",
          holder: { id: "u2", name: "Arjun" },
        },
        { status: 409, headers: { "x-daemon": "1" } },
      );

    const res = await route(
      managed("/v1/live/control", {
        method: "POST",
        body: COMMAND,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res!.status).toBe(409);
    expect(res!.headers.get("x-daemon")).toBe("1");
    expect(await res!.json()).toEqual({
      ok: false,
      code: "control_held",
      holder: { id: "u2", name: "Arjun" },
    });
    expect(daemonCalls).toHaveLength(1);
    const call = daemonCalls[0]!;
    expect(call.url.pathname).toBe("/v1/live/control");
    expect(call.method).toBe("POST");
    expect(call.body).toBe(COMMAND);
    expect(call.headers.get("content-type")).toBe("application/json");
  });

  /**
   * Nothing the caller sent reaches the daemon beyond the body: not its
   * identity, not a forged viewer, not the orchestrator's user header.
   */
  test("sends the daemon a service token and none of the caller's headers", async () => {
    managedMode();

    await route(
      managed("/v1/live/control", {
        method: "POST",
        body: COMMAND,
        headers: {
          "x-vellum-viewer-id": "forged",
          "x-vellum-acting-user-id": "forged",
          cookie: "session=abc",
        },
      }),
    );

    const headers = daemonCalls[0]!.headers;
    expect(headers.has("x-vellum-viewer-id")).toBe(false);
    expect(headers.has("x-vellum-acting-user-id")).toBe(false);
    expect(headers.has("x-vellum-user-id")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    const auth = headers.get("authorization")!;
    const claims = verifyToken(auth.slice(7), "vellum-daemon");
    expect(claims.ok && claims.claims.sub).toBe("svc:gateway:self");
  });

  test("refuses a managed call attested for someone other than the guardian", async () => {
    managedMode();

    const res = await route(
      managed("/v1/live/control", {
        method: "POST",
        body: COMMAND,
        userId: "not-the-owner",
      }),
    );

    expect(res!.status).toBe(403);
    expect(daemonCalls).toHaveLength(0);
  });

  test("refuses a managed call with no attested user", async () => {
    managedMode();

    const res = await route(
      managed("/v1/live/control", {
        method: "POST",
        body: COMMAND,
        userId: null,
      }),
    );

    expect(res!.status).toBe(401);
  });

  test("answers 503 when the stored guardian cannot be read", async () => {
    managedMode();
    storedPlatformUser = { unreachable: true };

    const res = await route(
      managed("/v1/live/control", { method: "POST", body: COMMAND }),
    );

    expect(res!.status).toBe(503);
  });

  /** Not a tunnel path, even if someone widens velay's allowlist. */
  test.each([
    ["the velay HTTP bridge marker", { "x-velay-forwarded": "1" }],
    ["the velay bridge proof", null],
  ])("refuses a request carrying %s", async (_label, extra) => {
    managedMode();
    const headers = new Headers(extra ?? {});
    if (!extra) setVelayBridgeAuthHeader(headers);

    const res = await route(
      managed("/v1/live/control", { method: "POST", body: COMMAND, headers }),
    );

    expect(res!.status).toBe(403);
    expect(daemonCalls).toHaveLength(0);
  });

  test("refuses an oversized body", async () => {
    managedMode();

    const res = await route(
      managed("/v1/live/control", {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
      }),
    );

    expect(res!.status).toBe(413);
  });

  describe("off the platform", () => {
    const withToken = (token: string) =>
      new Request("http://localhost:7830/v1/live/control", {
        method: "POST",
        body: COMMAND,
        headers: { authorization: `Bearer ${token}` },
      });

    test("admits the guardian's own token", async () => {
      const res = await route(withToken(mintEdgeToken(GUARDIAN_PRINCIPAL)));

      expect(res!.status).toBe(200);
      expect(daemonCalls).toHaveLength(1);
    });

    test("refuses another actor's token", async () => {
      const res = await route(withToken(mintEdgeToken("someone-else")));

      expect(res!.status).toBe(403);
    });

    test("refuses a service token", async () => {
      const res = await route(withToken(mintServiceEdgeToken()));

      expect(res!.status).toBe(403);
    });

    test("refuses no token, and ignores an attested-user header", async () => {
      const res = await route(
        managed("/v1/live/control", { method: "POST", body: COMMAND }),
      );

      expect(res!.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/watch/snapshot (C2.1)
// ---------------------------------------------------------------------------

describe("GET /v1/watch/snapshot", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

  test("passes the daemon's JPEG and frame headers through byte-identical", async () => {
    managedMode();
    daemonReply = () =>
      new Response(JPEG, {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "x-frame-ts": "2026-09-24T10:00:00.000Z",
          "x-frame-url": "https://venues.example/booking",
        },
      });

    const res = await route(managed("/v1/watch/snapshot"));

    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("image/jpeg");
    expect(res!.headers.get("x-frame-ts")).toBe("2026-09-24T10:00:00.000Z");
    expect(res!.headers.get("x-frame-url")).toBe(
      "https://venues.example/booking",
    );
    expect(Array.from(new Uint8Array(await res!.arrayBuffer()))).toEqual(
      Array.from(JPEG),
    );
    expect(daemonCalls[0]!.url.pathname).toBe("/v1/watch/snapshot");
    expect(daemonCalls[0]!.method).toBe("GET");
  });

  test("passes a 204 through when there is no frame", async () => {
    managedMode();
    daemonReply = () => new Response(null, { status: 204 });

    const res = await route(managed("/v1/watch/snapshot"));

    expect(res!.status).toBe(204);
  });

  test("refuses a caller who is not service-authenticated", async () => {
    managedMode();

    const res = await route(
      managed("/v1/watch/snapshot", { userId: "a-stranger" }),
    );

    expect(res!.status).toBe(403);
    expect(daemonCalls).toHaveLength(0);
  });

  test("answers 502 when the daemon is unreachable", async () => {
    managedMode();
    daemonReply = () => {
      throw new TypeError("connection refused");
    };

    const res = await route(managed("/v1/watch/snapshot"));

    expect(res!.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/live/threads
// ---------------------------------------------------------------------------

describe("GET /v1/live/threads", () => {
  test("relays the query to the daemon for the guardian", async () => {
    managedMode();
    daemonReply = () => Response.json([]);

    const res = await route(managed("/v1/live/threads?user=all"));

    expect(res!.status).toBe(200);
    expect(daemonCalls[0]!.url.pathname).toBe("/v1/live/threads");
    expect(daemonCalls[0]!.url.searchParams.get("platform_user")).toBe("all");
  });
});

// ---------------------------------------------------------------------------
// Flag off: the routes are not there
// ---------------------------------------------------------------------------

describe("with aexy-live-view off", () => {
  test.each([
    ["POST", "/v1/live/control"],
    ["GET", "/v1/watch/snapshot"],
    ["GET", "/v1/live/threads"],
    ["PUT", "/v1/live/access-list"],
    ["POST", "/v1/live/chat/messages"],
  ])(
    "%s %s goes to the runtime-proxy catch-all, as upstream",
    async (method, path) => {
      liveViewEnabled = false;
      managedMode();

      const res = await route(
        managed(path, { method, body: method === "GET" ? undefined : "{}" }),
      );

      expect(res!.status).toBe(418);
      expect(fallthrough).toHaveBeenCalledTimes(1);
      expect(daemonCalls).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// C6: the access list, and chat for everyone on it
// ---------------------------------------------------------------------------

const PRIYA = {
  platform_user_id: "user-priya",
  aexy_developer_id: "dev-priya",
  display_name: "Priya Shāh",
  role: "member",
  can_chat: true,
};
const ARJUN = {
  platform_user_id: "user-arjun",
  aexy_developer_id: "dev-arjun",
  display_name: "Arjun Mehta",
  role: "manager",
  can_chat: true,
};
const WATCHER = {
  platform_user_id: "user-watcher",
  aexy_developer_id: "dev-watcher",
  display_name: "Wen",
  role: "member",
  can_chat: false,
};

async function putAccessList(
  entries: unknown[],
  userId: string = VELAY_USER_ID,
): Promise<Response> {
  return (await route(
    managed("/v1/live/access-list", {
      method: "PUT",
      body: JSON.stringify({ entries }),
      userId,
    }),
  ))!;
}

function chat(
  body: Record<string, unknown>,
  userId: string = VELAY_USER_ID,
): Promise<Response | null> {
  return route(
    managed("/v1/live/chat/messages", {
      method: "POST",
      body: JSON.stringify(body),
      userId,
    }),
  );
}

describe("PUT /v1/live/access-list", () => {
  beforeEach(managedMode);

  test("stores the list the guardian pushes, 0600 in the security dir", async () => {
    const res = await putAccessList([PRIYA, ARJUN]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, entries: 2 });
    const path = getLiveAccessStorePath();
    expect(path.startsWith(securityDir)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    expect(stored.entries).toEqual([
      {
        platformUserId: "user-priya",
        aexyDeveloperId: "dev-priya",
        displayName: "Priya Shāh",
        role: "member",
        canChat: true,
      },
      {
        platformUserId: "user-arjun",
        aexyDeveloperId: "dev-arjun",
        displayName: "Arjun Mehta",
        role: "manager",
        canChat: true,
      },
    ]);
    expect(daemonCalls).toHaveLength(0);
  });

  test("replaces the whole list, and survives a restart", async () => {
    await putAccessList([PRIYA, ARJUN]);
    await putAccessList([ARJUN]);
    clearLiveAccessStoreCache();

    const res = await chat({ text: "hi" }, "user-priya");

    expect(res!.status).toBe(403);
  });

  test("accepts a list from a manager already on it", async () => {
    await putAccessList([ARJUN]);

    const res = await putAccessList([ARJUN, PRIYA], "user-arjun");

    expect(res.status).toBe(200);
  });

  test("refuses a list from a member on it", async () => {
    await putAccessList([PRIYA]);

    const res = await putAccessList(
      [{ ...PRIYA, role: "owner" }],
      "user-priya",
    );

    expect(res.status).toBe(403);
  });

  test("refuses a list from someone not on it", async () => {
    const res = await putAccessList([PRIYA], "user-stranger");

    expect(res.status).toBe(403);
  });

  test.each([
    ["an unknown role", [{ ...PRIYA, role: "superuser" }]],
    ["a missing can_chat", [{ ...PRIYA, can_chat: undefined }]],
    ["a blank platform user", [{ ...PRIYA, platform_user_id: " " }]],
    ["the same user twice", [PRIYA, { ...PRIYA, role: "admin" }]],
  ])("refuses %s with 400", async (_label, entries) => {
    const res = await putAccessList(entries);

    expect(res.status).toBe(400);
  });
});

describe("POST /v1/live/chat/messages", () => {
  beforeEach(async () => {
    managedMode();
    await putAccessList([PRIYA, ARJUN, WATCHER]);
    daemonReply = () =>
      Response.json(
        { accepted: true, conversationId: "conv-new", messageId: "m1" },
        { status: 202 },
      );
  });

  test("sends the guardian's message as the guardian, with no acting headers", async () => {
    const res = await chat({ text: "Book the venue" });

    expect(res!.status).toBe(202);
    expect(await res!.json()).toEqual({ conversation_id: "conv-new" });
    const call = daemonCalls[0]!;
    expect(call.url.pathname).toBe("/v1/messages");
    expect(JSON.parse(call.body!)).toEqual({
      content: "Book the venue",
      sourceChannel: "vellum",
      interface: "vellum",
    });
    expect(call.headers.has("x-vellum-acting-user-id")).toBe(false);
    const auth = call.headers.get("authorization")!;
    const claims = verifyToken(auth.slice(7), "vellum-daemon");
    expect(claims.ok && claims.claims.sub).toBe(
      `actor:self:${GUARDIAN_PRINCIPAL}`,
    );
    expect(conversationOwner("conv-new")).toBeUndefined();
  });

  test("sends a can_chat member's message naming them, and keys the new conversation to them", async () => {
    const res = await chat({ text: "What's left on the list?" }, "user-priya");

    expect(res!.status).toBe(202);
    expect(await res!.json()).toEqual({ conversation_id: "conv-new" });
    const headers = daemonCalls[0]!.headers;
    expect(headers.get("x-vellum-acting-user-id")).toBe("user-priya");
    expect(headers.get("x-vellum-acting-user-name")).toBe(
      encodeURIComponent("Priya Shāh"),
    );
    expect(headers.get("x-vellum-acting-user-role")).toBe("member");
    expect(headers.get("x-vellum-acting-aexy-developer-id")).toBe("dev-priya");
    expect(conversationOwner("conv-new")).toEqual({
      platformUserId: "user-priya",
      aexyDeveloperId: "dev-priya",
    });
  });

  test("lets a member continue their own conversation", async () => {
    recordConversationOwner("conv-p", {
      platformUserId: "user-priya",
      aexyDeveloperId: "dev-priya",
    });
    daemonReply = () =>
      Response.json(
        { accepted: true, conversationId: "conv-p" },
        { status: 202 },
      );

    const res = await chat(
      { conversation_id: "conv-p", text: "And the caterer?" },
      "user-priya",
    );

    expect(res!.status).toBe(202);
    expect(JSON.parse(daemonCalls[0]!.body!).conversationId).toBe("conv-p");
  });

  test.each([
    ["another member's", "user-priya", "user-arjun"],
    ["the guardian's", null, "user-priya"],
    ["a member's, as the guardian", "user-priya", VELAY_USER_ID],
  ])("refuses a post to %s conversation", async (_label, owner, caller) => {
    if (owner) {
      recordConversationOwner("conv-x", {
        platformUserId: owner,
        aexyDeveloperId: "dev-x",
      });
    }

    const res = await chat({ conversation_id: "conv-x", text: "hi" }, caller);

    expect(res!.status).toBe(403);
    expect((await res!.json()).code).toBe("not_your_conversation");
    expect(daemonCalls).toHaveLength(0);
  });

  test("refuses someone on the list without can_chat", async () => {
    const res = await chat({ text: "hi" }, "user-watcher");

    expect(res!.status).toBe(403);
    expect((await res!.json()).code).toBe("chat_not_allowed");
  });

  test("refuses someone not on the list", async () => {
    const res = await chat({ text: "hi" }, "user-stranger");

    expect(res!.status).toBe(403);
  });

  test("strips a client's own acting headers", async () => {
    await route(
      managed("/v1/live/chat/messages", {
        method: "POST",
        body: JSON.stringify({ text: "hi" }),
        headers: { "x-vellum-acting-user-role": "owner" },
        userId: "user-priya",
      }),
    );

    expect(daemonCalls[0]!.headers.get("x-vellum-acting-user-role")).toBe(
      "member",
    );
  });

  test.each([
    ["no text", {}],
    ["blank text", { text: "   " }],
    ["a non-string conversation", { text: "hi", conversation_id: 7 }],
  ])("refuses %s with 400", async (_label, body) => {
    const res = await chat(body);

    expect(res!.status).toBe(400);
  });

  test("passes a daemon refusal through and records nothing", async () => {
    daemonReply = () =>
      Response.json({ error: { code: "BAD_REQUEST" } }, { status: 400 });

    const res = await chat({ text: "hi" }, "user-priya");

    expect(res!.status).toBe(400);
    expect(conversationOwner("conv-new")).toBeUndefined();
  });

  test("answers 502 when the daemon names no conversation", async () => {
    daemonReply = () => Response.json({ accepted: true }, { status: 202 });

    const res = await chat({ text: "hi" }, "user-priya");

    expect(res!.status).toBe(502);
  });
});

describe("GET /v1/live/threads for people on the access list", () => {
  beforeEach(async () => {
    managedMode();
    await putAccessList([PRIYA, ARJUN]);
    daemonReply = () => Response.json([]);
  });

  test("gives a member only their own threads", async () => {
    const res = await route(
      managed("/v1/live/threads", { userId: "user-priya" }),
    );

    expect(res!.status).toBe(200);
    const call = daemonCalls[0]!;
    // The daemon knows threads by platform user; the list says which one.
    expect(call.url.searchParams.get("platform_user")).toBe("user-priya");
    expect(call.headers.get("x-vellum-acting-user-id")).toBe("user-priya");
  });

  test.each(["all", "dev-arjun"])(
    "refuses a member asking for user=%s",
    async (user) => {
      const res = await route(
        managed(`/v1/live/threads?user=${user}`, { userId: "user-priya" }),
      );

      expect(res!.status).toBe(403);
      expect(daemonCalls).toHaveLength(0);
    },
  );

  test("gives a manager everyone's", async () => {
    const res = await route(
      managed("/v1/live/threads?user=all", { userId: "user-arjun" }),
    );

    expect(res!.status).toBe(200);
    expect(daemonCalls[0]!.url.searchParams.get("platform_user")).toBe("all");
    expect(daemonCalls[0]!.headers.get("x-vellum-acting-user-role")).toBe(
      "manager",
    );
  });

  test("names each thread's starter in Aexy's terms, and the owner's as nobody's", async () => {
    daemonReply = () =>
      Response.json([
        {
          conversation_id: "c-p",
          platform_user_id: "user-priya",
          title: "Venues",
          updated_at: "2026-09-25T04:00:00.000Z",
        },
        {
          conversation_id: "c-g",
          platform_user_id: null,
          title: null,
          updated_at: "2026-09-25T03:00:00.000Z",
        },
      ]);

    const res = await route(
      managed("/v1/live/threads?user=all", { userId: "user-arjun" }),
    );

    expect(await res!.json()).toEqual([
      {
        conversation_id: "c-p",
        aexy_developer_id: "dev-priya",
        title: "Venues",
        updated_at: "2026-09-25T04:00:00.000Z",
      },
      {
        conversation_id: "c-g",
        aexy_developer_id: null,
        title: null,
        updated_at: "2026-09-25T03:00:00.000Z",
      },
    ]);
  });

  test("asks for one person by their platform user, and for anyone else as the guardian", async () => {
    await route(
      managed("/v1/live/threads?user=dev-priya", { userId: "user-arjun" }),
    );
    await route(
      managed("/v1/live/threads?user=dev-owner", { userId: "user-arjun" }),
    );

    expect(
      daemonCalls.map((c) => c.url.searchParams.get("platform_user")),
    ).toEqual(["user-priya", "guardian"]);
  });
});

describe("control and snapshot for people on the access list", () => {
  test("relay for anyone on the list, since Aexy authorized the actor", async () => {
    managedMode();
    await putAccessList([PRIYA]);

    const control = await route(
      managed("/v1/live/control", {
        method: "POST",
        body: '{"command":"pause"}',
        userId: "user-priya",
      }),
    );
    const snapshot = await route(
      managed("/v1/watch/snapshot", { userId: "user-priya" }),
    );

    expect(control!.status).toBe(200);
    expect(snapshot!.status).toBe(200);
    expect(daemonCalls).toHaveLength(2);
  });
});
