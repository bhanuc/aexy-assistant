/**
 * C3: under the live view only the control-lease holder gets the desktop.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { _resetLiveControlStateForTests } from "../../live/control-state.js";
import { getLiveControl } from "../../live/live-control-runtime.js";
import { RuntimeHttpServer } from "../http-server.js";
import {
  mintGatewayToken,
  requireHttpAuth,
  waitForClose,
} from "./runtime-ws-test-utils.js";

function openDesktop(
  baseUrl: string,
  headers: Record<string, string>,
): WebSocket {
  return new WebSocket(
    `ws://${baseUrl}/v1/desktop/stream?token=${encodeURIComponent(mintGatewayToken())}`,
    { headers } as unknown as string[],
  );
}

describe("RuntimeHttpServer /v1/desktop/stream under the live view", () => {
  let server: RuntimeHttpServer;
  let baseUrl: string;
  let restoreAuthEnv: () => void;
  const originalContainerized = process.env.IS_CONTAINERIZED;

  beforeEach(async () => {
    restoreAuthEnv = requireHttpAuth();
    process.env.IS_CONTAINERIZED = "true";
    setOverridesForTesting({
      "assistant-desktop": true,
      "aexy-live-view": true,
    });
    _resetLiveControlStateForTests();
    const port = 22000 + Math.floor(Math.random() * 250);
    server = new RuntimeHttpServer({ port, hostname: "127.0.0.1" });
    await server.start();
    baseUrl = `127.0.0.1:${server.actualPort}`;
  });

  afterEach(async () => {
    getLiveControl().dispose();
    _resetLiveControlStateForTests();
    await server.stop();
    restoreAuthEnv();
    if (originalContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = originalContainerized;
    }
    setOverridesForTesting({});
  });

  test("a watch-scoped session cannot drive", async () => {
    const closed = await waitForClose(
      openDesktop(baseUrl, {
        "x-vellum-stream-scope": "watch",
        "x-vellum-aexy-developer-id": "dev-priya",
      }),
    );
    expect(closed.code).toBe(4003);
  });

  test("with no lease held nobody from a live session gets the desktop", async () => {
    const closed = await waitForClose(
      openDesktop(baseUrl, {
        "x-vellum-stream-scope": "control",
        "x-vellum-aexy-developer-id": "dev-priya",
      }),
    );
    expect(closed.code).toBe(4013);
  });

  test("only the holder gets past the lease; anyone else is 4013", async () => {
    await getLiveControl().handle({
      command: "acquire_control",
      actor: {
        aexy_developer_id: "dev-priya",
        display_name: "Priya",
        role: "member",
      },
    });
    const other = await waitForClose(
      openDesktop(baseUrl, {
        "x-vellum-stream-scope": "control",
        "x-vellum-aexy-developer-id": "dev-arjun",
      }),
    );
    expect(other.code).toBe(4013);
    // The guardian's own path is held to the lease too while one exists.
    const guardian = await waitForClose(openDesktop(baseUrl, {}));
    expect(guardian.code).toBe(4013);

    // The holder is let through to the desktop itself, which this test
    // machine cannot start — any ending but the lease's.
    const holder = await waitForClose(
      openDesktop(baseUrl, {
        "x-vellum-stream-scope": "control",
        "x-vellum-aexy-developer-id": "dev-priya",
      }),
      15_000,
    );
    expect(holder.code).not.toBe(4013);
  });
});
