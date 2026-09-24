/**
 * The Aexy live view shares `/v1/watch/stream` with upstream's narration
 * capture; the gateway's attested scope header is what tells them apart.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { RuntimeHttpServer } from "../http-server.js";
import {
  mintGatewayToken,
  requireHttpAuth,
  upgradeHeaders,
  waitForClose,
} from "./runtime-ws-test-utils.js";

const VIEWER = {
  "x-vellum-viewer-id": "user-1",
  "x-vellum-viewer-role": "member",
  "x-vellum-stream-scope": "watch",
  "x-vellum-live-session-id": "ls-1",
  "x-vellum-aexy-developer-id": "dev-1",
  "x-vellum-display-name": encodeURIComponent("Priya Shah"),
  "x-vellum-conversation-id": "conv-1",
};

function open(baseUrl: string, headers: Record<string, string>): WebSocket {
  return new WebSocket(
    `ws://${baseUrl}/v1/watch/stream?token=${encodeURIComponent(mintGatewayToken())}`,
    { headers } as unknown as string[],
  );
}

function firstMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), 3000);
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)));
    });
  });
}

describe("RuntimeHttpServer /v1/watch/stream for the live view", () => {
  let server: RuntimeHttpServer;
  let baseUrl: string;
  let restoreAuthEnv: () => void;
  const originalContainerized = process.env.IS_CONTAINERIZED;

  beforeEach(async () => {
    restoreAuthEnv = requireHttpAuth();
    const port = 21700 + Math.floor(Math.random() * 250);
    server = new RuntimeHttpServer({ port, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `127.0.0.1:${server.actualPort}`;
  });

  afterEach(async () => {
    await server.stop();
    restoreAuthEnv();
    if (originalContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = originalContainerized;
    }
    setOverridesForTesting({});
  });

  test("without the scope header the path is still upstream's narration capture", async () => {
    const res = await fetch(
      `http://${baseUrl}/v1/watch/stream?token=${mintGatewayToken()}`,
      { headers: upgradeHeaders },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("mimeType");
  });

  test("with the live view off the socket is closed 4008", async () => {
    const closed = await waitForClose(open(baseUrl, VIEWER));
    expect(closed.code).toBe(4008);
  });

  test("an unattested viewer is closed 4003", async () => {
    process.env.IS_CONTAINERIZED = "true";
    setOverridesForTesting({
      "assistant-desktop": true,
      "aexy-live-view": true,
    });
    const closed = await waitForClose(
      open(baseUrl, { "x-vellum-stream-scope": "watch" }),
    );
    expect(closed.code).toBe(4003);
  });

  test("an attested viewer is admitted and greeted", async () => {
    process.env.IS_CONTAINERIZED = "true";
    setOverridesForTesting({
      "assistant-desktop": true,
      "aexy-live-view": true,
    });
    const ws = open(baseUrl, VIEWER);
    const hello = await firstMessage(ws);
    expect(hello).toMatchObject({
      type: "hello",
      protocol: 1,
      viewer: {
        id: "user-1",
        role: "member",
        scope: "watch",
        liveSessionId: "ls-1",
      },
      conversationId: "conv-1",
    });
    ws.close();
  });
});
