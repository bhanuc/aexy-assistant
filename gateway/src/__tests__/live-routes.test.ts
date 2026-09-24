import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
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

beforeEach(() => {
  liveViewEnabled = true;
  daemonCalls = [];
  daemonReply = () => Response.json({ ok: true });
  storedPlatformUser = { userId: VELAY_USER_ID, unreachable: false };
  fallthrough.mockClear();
});

afterEach(() => {
  delete process.env.IS_PLATFORM;
  delete process.env.DISABLE_HTTP_AUTH;
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
    expect(daemonCalls[0]!.url.searchParams.get("user")).toBe("all");
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
  ])(
    "%s %s goes to the runtime-proxy catch-all, as upstream",
    async (method, path) => {
      liveViewEnabled = false;
      managedMode();

      const res = await route(
        managed(path, { method, body: method === "POST" ? "{}" : undefined }),
      );

      expect(res!.status).toBe(418);
      expect(fallthrough).toHaveBeenCalledTimes(1);
      expect(daemonCalls).toHaveLength(0);
    },
  );
});
