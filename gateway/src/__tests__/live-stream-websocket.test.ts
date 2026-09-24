import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLiveAccessStoreCache,
  recordConversationOwner,
} from "../live-view/access-store.js";
import { setVelayBridgeAuthHeader } from "../velay/bridge-auth.js";
import type { LiveStreamSocketData } from "../http/routes/live-stream-websocket.js";
import {
  GUARDIAN_PRINCIPAL,
  VELAY_USER_ID,
  createFakeDownstreamWs,
  makeConfig,
  makeFakeServer,
  mintEdgeToken,
  settle,
  startFakeRuntime,
  upgradedData,
  waitFor,
  type FakeRuntime,
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
mock.module("../platform-user-id.js", () => ({
  readStoredPlatformUserId: async () => ({
    userId: VELAY_USER_ID,
    unreachable: false,
  }),
}));

const { createWatchStreamWebsocketHandler } =
  await import("../http/routes/watch-stream-websocket.js");
const { createDesktopStreamWebsocketHandler } =
  await import("../http/routes/desktop-stream-websocket.js");
const {
  getLiveWatchStreamWebsocketHandlers,
  getLiveDesktopStreamWebsocketHandlers,
} = await import("../http/routes/live-stream-websocket.js");

/** Someone Aexy let watch, who is not the pod's guardian. */
const VIEWER_ID = "22222222-2222-2222-2222-222222222222";
const TUNNEL_CONFIG = () =>
  makeConfig({ velayBaseUrl: "wss://velay.test" } as never);

/** The headers the tunnel injects for a minted live-stream token (C1.3). */
function attestedHeaders(
  overrides: Record<string, string | null> = {},
  { bridgeProof = true }: { bridgeProof?: boolean } = {},
): Headers {
  const base: Record<string, string | null> = {
    upgrade: "websocket",
    "x-velay-user-id": VIEWER_ID,
    "x-velay-org-id": "org-1",
    "x-velay-actor": "user",
    "x-velay-stream-scope": "watch",
    "x-velay-viewer-role": "member",
    "x-velay-live-session-id": "33333333-3333-3333-3333-333333333333",
    "x-velay-aexy-developer-id": "44444444-4444-4444-4444-444444444444",
    "x-velay-display-name": encodeURIComponent("Priya Shāh"),
    ...overrides,
  };
  const headers = new Headers();
  for (const [name, value] of Object.entries(base)) {
    if (value !== null) headers.set(name, value);
  }
  if (bridgeProof) setVelayBridgeAuthHeader(headers);
  return headers;
}

type Upgrade = (
  req: Request,
  server: import("bun").Server<unknown>,
) => Promise<Response | undefined>;

async function open(
  handler: Upgrade,
  path: string,
  headers: Headers,
  query = "",
) {
  const server = makeFakeServer();
  const res = await handler(
    new Request(`http://localhost:7830${path}${query}`, { headers }),
    server,
  );
  return { res, server };
}

let securityDir: string;

beforeEach(() => {
  liveViewEnabled = true;
  securityDir = mkdtempSync(join(tmpdir(), "live-stream-test-"));
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  clearLiveAccessStoreCache();
});

afterEach(() => {
  delete process.env.IS_PLATFORM;
  delete process.env.GATEWAY_SECURITY_DIR;
  clearLiveAccessStoreCache();
  rmSync(securityDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Upgrade: who gets in on an attested scope
// ---------------------------------------------------------------------------

describe("live watch stream upgrade", () => {
  const watch = () => createWatchStreamWebsocketHandler(TUNNEL_CONFIG());

  test("admits an attested watcher who is not the guardian, without a token or mimeType", async () => {
    const { res, server } = await open(
      watch(),
      "/v1/watch/stream",
      attestedHeaders(),
    );

    expect(res).toBeUndefined();
    expect(upgradedData<LiveStreamSocketData>(server)).toMatchObject({
      wsType: "live-watch-stream",
      attestation: {
        userId: VIEWER_ID,
        orgId: "org-1",
        scope: "watch",
        viewerRole: "member",
        liveSessionId: "33333333-3333-3333-3333-333333333333",
        aexyDeveloperId: "44444444-4444-4444-4444-444444444444",
        displayName: encodeURIComponent("Priya Shāh"),
      },
    });
  });

  test("admits a control-scope viewer on the watch stream", async () => {
    const { server } = await open(
      watch(),
      "/v1/watch/stream",
      attestedHeaders({ "x-velay-stream-scope": "control" }),
    );

    expect(upgradedData<LiveStreamSocketData>(server).attestation?.scope).toBe(
      "control",
    );
  });

  test("admits on a managed pod with no tunnel URL in config", async () => {
    process.env.IS_PLATFORM = "true";
    const { server } = await open(
      createWatchStreamWebsocketHandler(makeConfig()),
      "/v1/watch/stream",
      attestedHeaders(),
    );

    expect(upgradedData<LiveStreamSocketData>(server).wsType).toBe(
      "live-watch-stream",
    );
  });

  test("carries the token's conversation for a chat-scope viewer who started it", async () => {
    recordConversationOwner("conv-7", {
      platformUserId: VIEWER_ID,
      aexyDeveloperId: "44444444-4444-4444-4444-444444444444",
    });
    const { server } = await open(
      watch(),
      "/v1/watch/stream",
      attestedHeaders({
        "x-velay-stream-scope": "chat",
        "x-velay-conversation-id": "conv-7",
      }),
    );

    expect(
      upgradedData<LiveStreamSocketData>(server).attestation?.conversationId,
    ).toBe("conv-7");
  });

  /** C6: nobody reads another person's thread through the pod... */
  test.each([
    ["someone else's", "55555555-5555-5555-5555-555555555555"],
    ["the guardian's (unrecorded)", null],
  ])(
    "refuses a member chat stream on %s conversation, with 4003",
    async (_label, owner) => {
      if (owner) {
        recordConversationOwner("conv-9", {
          platformUserId: owner,
          aexyDeveloperId: "dev-other",
        });
      }
      const { server } = await open(
        watch(),
        "/v1/watch/stream",
        attestedHeaders({
          "x-velay-stream-scope": "chat",
          "x-velay-conversation-id": "conv-9",
        }),
      );

      expect(upgradedData<LiveStreamSocketData>(server).refusal).toEqual({
        code: 4003,
        reason: "Not your conversation",
      });
    },
  );

  /** ...except an owner, manager or admin, through the threads index. */
  test.each(["owner", "manager", "admin"])(
    "admits a %s chat stream on someone else's conversation",
    async (role) => {
      recordConversationOwner("conv-9", {
        platformUserId: "55555555-5555-5555-5555-555555555555",
        aexyDeveloperId: "dev-other",
      });
      const { server } = await open(
        watch(),
        "/v1/watch/stream",
        attestedHeaders({
          "x-velay-stream-scope": "chat",
          "x-velay-viewer-role": role,
          "x-velay-conversation-id": "conv-9",
        }),
      );

      expect(
        upgradedData<LiveStreamSocketData>(server).attestation?.conversationId,
      ).toBe("conv-9");
    },
  );

  /** C1.1: a chat token always names its conversation. */
  test("refuses a chat scope with no conversation, with 4003", async () => {
    const { server } = await open(
      watch(),
      "/v1/watch/stream",
      attestedHeaders({ "x-velay-stream-scope": "chat" }),
    );

    const data = upgradedData<LiveStreamSocketData>(server);
    expect(data.attestation).toBeNull();
    expect(data.refusal?.code).toBe(4003);
  });

  test.each([
    ["an unknown scope", { "x-velay-stream-scope": "drive" }],
    ["an unknown role", { "x-velay-viewer-role": "superuser" }],
    ["no live session", { "x-velay-live-session-id": null }],
    ["no Aexy developer", { "x-velay-aexy-developer-id": null }],
    [
      "a display name that is not URL-encoded",
      { "x-velay-display-name": "%E0%A4" },
    ],
    ["no org", { "x-velay-org-id": null }],
  ])("refuses %s with 4003", async (_label, overrides) => {
    const { server } = await open(
      watch(),
      "/v1/watch/stream",
      attestedHeaders(overrides),
    );

    expect(upgradedData<LiveStreamSocketData>(server).refusal?.code).toBe(4003);
  });

  /**
   * The scope is only an attestation when velay's bridge relayed it. Without
   * the proof the request is an ordinary one and the guardian pin decides,
   * which refuses someone who is not the guardian.
   */
  test("ignores a scope header without the bridge proof", async () => {
    const { res, server } = await open(
      watch(),
      "/v1/watch/stream",
      attestedHeaders({}, { bridgeProof: false }),
      "?mimeType=audio/pcm",
    );

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("ignores a scope header on a gateway with no tunnel", async () => {
    const { res, server } = await open(
      createWatchStreamWebsocketHandler(makeConfig()),
      "/v1/watch/stream",
      attestedHeaders(),
    );

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("answers a plain request with 426", async () => {
    const headers = attestedHeaders();
    headers.delete("upgrade");
    const { res } = await open(watch(), "/v1/watch/stream", headers);

    expect(res!.status).toBe(426);
  });

  describe("with aexy-live-view off", () => {
    beforeEach(() => {
      liveViewEnabled = false;
    });

    /** Upstream: velay says who they are, the pin says they are not the guardian. */
    test("refuses an attested viewer who is not the guardian, as upstream", async () => {
      const { res, server } = await open(
        watch(),
        "/v1/watch/stream",
        attestedHeaders(),
        "?mimeType=audio/pcm",
      );

      expect(res!.status).toBe(403);
      expect(server.upgrade).not.toHaveBeenCalled();
    });

    test("still admits the guardian's narration session", async () => {
      const { res, server } = await open(
        watch(),
        "/v1/watch/stream",
        new Headers({ upgrade: "websocket" }),
        `?token=${mintEdgeToken(GUARDIAN_PRINCIPAL)}&mimeType=audio/pcm`,
      );

      expect(res).toBeUndefined();
      expect(upgradedData<{ wsType: string }>(server).wsType).toBe(
        "watch-stream",
      );
    });
  });

  test("leaves the guardian's narration session alone when no scope is attested", async () => {
    const { server } = await open(
      watch(),
      "/v1/watch/stream",
      new Headers({ upgrade: "websocket" }),
      `?token=${mintEdgeToken(GUARDIAN_PRINCIPAL)}&mimeType=audio/pcm`,
    );

    expect(upgradedData<{ wsType: string }>(server).wsType).toBe(
      "watch-stream",
    );
  });
});

describe("live desktop stream upgrade", () => {
  const desktop = () => createDesktopStreamWebsocketHandler(TUNNEL_CONFIG());

  test("admits an attested control-scope viewer", async () => {
    const { server } = await open(
      desktop(),
      "/v1/desktop/stream",
      attestedHeaders({ "x-velay-stream-scope": "control" }),
    );

    expect(upgradedData<LiveStreamSocketData>(server)).toMatchObject({
      wsType: "live-desktop-stream",
      attestation: { scope: "control", userId: VIEWER_ID },
    });
  });

  test.each(["watch", "chat"])(
    "closes a %s-scope viewer with 4003",
    async (scope) => {
      const { res, server } = await open(
        desktop(),
        "/v1/desktop/stream",
        attestedHeaders({
          "x-velay-stream-scope": scope,
          "x-velay-conversation-id": "conv-1",
        }),
      );

      expect(res).toBeUndefined();
      const data = upgradedData<LiveStreamSocketData>(server);
      expect(data.attestation).toBeNull();
      expect(data.refusal).toEqual({
        code: 4003,
        reason: "Desktop needs control scope",
      });
    },
  );

  test("with aexy-live-view off, refuses an attested non-guardian as upstream", async () => {
    liveViewEnabled = false;
    const { res, server } = await open(
      desktop(),
      "/v1/desktop/stream",
      attestedHeaders({ "x-velay-stream-scope": "control" }),
    );

    expect(res!.status).toBe(403);
    expect(server.upgrade).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pump: what reaches the daemon, and how a slow viewer is treated
// ---------------------------------------------------------------------------

describe("live stream pump", () => {
  let runtime: FakeRuntime;
  afterEach(() => {
    runtime?.server.stop(true);
  });

  const attestation = {
    userId: VIEWER_ID,
    orgId: "org-1",
    scope: "chat" as const,
    viewerRole: "member" as const,
    liveSessionId: "33333333-3333-3333-3333-333333333333",
    aexyDeveloperId: "44444444-4444-4444-4444-444444444444",
    displayName: encodeURIComponent("Priya Shāh"),
    conversationId: "conv-7",
  };

  function viewer(
    wsType: LiveStreamSocketData["wsType"],
    sendStatus?: number,
    data: Partial<LiveStreamSocketData> = {},
  ) {
    return createFakeDownstreamWs<LiveStreamSocketData>(
      {
        wsType,
        config: makeConfig({
          assistantRuntimeBaseUrl: `http://127.0.0.1:${runtime.server.port}`,
        }),
        attestation,
        ...data,
      },
      { sendStatus },
    );
  }

  test("dials the daemon's watch stream with the attested viewer (C1.4) and the service token only", async () => {
    runtime = startFakeRuntime();
    const handlers = getLiveWatchStreamWebsocketHandlers();

    handlers.open(viewer("live-watch-stream") as never);
    await runtime.connected;

    const url = runtime.upgradeUrl()!;
    expect(url.pathname).toBe("/v1/watch/stream");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
    const headers = runtime.upgradeHeaders()!;
    expect(headers.get("x-vellum-viewer-id")).toBe(VIEWER_ID);
    expect(headers.get("x-vellum-viewer-role")).toBe("member");
    expect(headers.get("x-vellum-stream-scope")).toBe("chat");
    expect(headers.get("x-vellum-live-session-id")).toBe(
      attestation.liveSessionId,
    );
    expect(headers.get("x-vellum-aexy-developer-id")).toBe(
      attestation.aexyDeveloperId,
    );
    expect(headers.get("x-vellum-display-name")).toBe(attestation.displayName);
    expect(headers.get("x-vellum-conversation-id")).toBe("conv-7");
  });

  test("omits the conversation header when the token named none", async () => {
    runtime = startFakeRuntime();
    const handlers = getLiveWatchStreamWebsocketHandlers();
    const { conversationId: _omit, ...watchOnly } = attestation;

    handlers.open(
      viewer("live-watch-stream", undefined, {
        attestation: { ...watchOnly, scope: "watch" },
      }) as never,
    );
    await runtime.connected;

    expect(runtime.upgradeHeaders()!.has("x-vellum-conversation-id")).toBe(
      false,
    );
  });

  test("dials the daemon's desktop stream with the attested viewer", async () => {
    runtime = startFakeRuntime();
    const handlers = getLiveDesktopStreamWebsocketHandlers();

    handlers.open(viewer("live-desktop-stream") as never);
    await runtime.connected;

    expect(runtime.upgradeUrl()!.pathname).toBe("/v1/desktop/stream");
    expect(runtime.upgradeHeaders()!.get("x-vellum-viewer-id")).toBe(VIEWER_ID);
  });

  /**
   * The daemon already sends each viewer only its latest frame, so a frame
   * dropped past backpressure is one the next replaces. Closing for it would
   * turn every busy moment into a reconnect.
   */
  test("keeps a watch viewer connected through a dropped frame", async () => {
    runtime = startFakeRuntime('{"type":"frame"}');
    const handlers = getLiveWatchStreamWebsocketHandlers();
    const ws = viewer("live-watch-stream", 0);

    handlers.open(ws as never);
    await waitFor(() => ws.sent.length > 0);
    await settle();

    expect(ws.closes).toEqual([]);
  });

  /** RFB cannot resync, so the desktop keeps upstream's drop-closes rule. */
  test("closes a desktop viewer on a dropped frame", async () => {
    runtime = startFakeRuntime(new TextEncoder().encode("RFB 003.008\n"));
    const handlers = getLiveDesktopStreamWebsocketHandlers();
    const ws = viewer("live-desktop-stream", 0);

    handlers.open(ws as never);
    await waitFor(() => ws.closes.length > 0);

    expect(ws.closes[0]).toEqual({ code: 1011, reason: "Viewer too slow" });
  });

  test("closes a refused socket with its code and never dials the daemon", async () => {
    runtime = startFakeRuntime();
    const handlers = getLiveDesktopStreamWebsocketHandlers();
    const ws = viewer("live-desktop-stream", undefined, {
      attestation: null,
      refusal: { code: 4003, reason: "Desktop needs control scope" },
    });

    handlers.open(ws as never);
    handlers.message(ws as never, "hello");
    await settle();

    expect(ws.closes).toEqual([
      { code: 4003, reason: "Desktop needs control scope" },
    ]);
    expect(ws.data.upstream).toBeUndefined();
    expect(runtime.upgradeUrl()).toBeUndefined();
  });

  test("relays the daemon's close code verbatim (4013: someone else holds control)", async () => {
    runtime = startFakeRuntime();
    const handlers = getLiveDesktopStreamWebsocketHandlers();
    const ws = viewer("live-desktop-stream");

    handlers.open(ws as never);
    const upstream = await runtime.connected;
    upstream.close(4013, "control held");
    await waitFor(() => ws.closes.length > 0);

    expect(ws.closes[0]).toEqual({ code: 4013, reason: "control held" });
  });
});
