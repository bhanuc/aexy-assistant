/**
 * Under the live view the browser tool drives the desktop Chrome (plan D1),
 * and a desktop that cannot start costs visibility, not the work.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../../tools/types.js";

let liveView = true;
let ensureCalls = 0;
let ensureFails = false;
const inspectOptions: unknown[] = [];

mock.module("../live-view-feature.js", () => ({
  AEXY_LIVE_VIEW_FLAG: "aexy-live-view",
  DESKTOP_CDP_HOST: "127.0.0.1",
  DESKTOP_CDP_PORT: 9222,
  isLiveViewEnabled: () => liveView,
}));

mock.module("../desktop-browser.js", () => ({
  ensureDesktopBrowserForAgent: async () => {
    ensureCalls += 1;
    if (ensureFails) {
      throw new Error("The desktop browser could not be started");
    }
  },
  holdDesktopForClaim: () => () => {},
}));

import * as realCdpInspectClient from "../../tools/browser/cdp-client/cdp-inspect-client.js";
import * as realLocalCdpClient from "../../tools/browser/cdp-client/local-cdp-client.js";

mock.module("../../tools/browser/cdp-client/cdp-inspect-client.js", () => ({
  ...realCdpInspectClient,
  createCdpInspectClient: (conversationId: string, options: unknown) => {
    inspectOptions.push(options);
    return {
      kind: "cdp-inspect",
      conversationId,
      send: async () => ({ via: "desktop" }),
      dispose: () => {},
    };
  },
}));
mock.module("../../tools/browser/cdp-client/local-cdp-client.js", () => ({
  ...realLocalCdpClient,
  createLocalCdpClient: (conversationId: string) => ({
    kind: "local",
    conversationId,
    send: async () => ({ via: "headless" }),
    dispose: () => {},
  }),
}));

const { buildCandidateList, buildPinnedCandidateList, getCdpClient } =
  await import("../../tools/browser/cdp-client/factory.js");

function context(conversationId = "conv-live"): ToolContext {
  return { conversationId } as unknown as ToolContext;
}

describe("the browser tool under the live view", () => {
  beforeEach(() => {
    liveView = true;
    ensureCalls = 0;
    ensureFails = false;
    inspectOptions.length = 0;
  });

  test("prefers the desktop Chrome, with the headless browser behind it", () => {
    const candidates = buildCandidateList(context());
    expect(candidates.map((c) => c.kind)).toEqual(["cdp-inspect", "local"]);
    expect(candidates[0]!.reason).toContain("live view");
  });

  test("starts the desktop before the first command and talks to its loopback DevTools", async () => {
    const cdp = getCdpClient(context("conv-a"));
    try {
      const result = await cdp.send("Runtime.evaluate", { expression: "1" });
      expect(result).toEqual({ via: "desktop" });
      expect(cdp.kind).toBe("cdp-inspect");
      expect(ensureCalls).toBe(1);
      expect(inspectOptions).toEqual([{ host: "127.0.0.1", port: 9222 }]);
    } finally {
      cdp.dispose();
    }
  });

  test("a desktop that cannot start falls back to the headless browser", async () => {
    ensureFails = true;
    const cdp = getCdpClient(context("conv-b"));
    try {
      const result = await cdp.send("Runtime.evaluate", { expression: "1" });
      expect(result).toEqual({ via: "headless" });
      expect(cdp.kind).toBe("local");
    } finally {
      cdp.dispose();
    }
  });

  test("the sticky cdp-inspect memo resolves to the desktop Chrome too", () => {
    const [candidate] = buildPinnedCandidateList(context(), "cdp-inspect");
    expect(candidate!.reason).toBe("pinned mode: cdp-inspect");
    candidate!.create();
    expect(inspectOptions).toEqual([{ host: "127.0.0.1", port: 9222 }]);
  });

  test("with the live view off the list is upstream's", () => {
    liveView = false;
    expect(buildCandidateList(context()).map((c) => c.kind)).toEqual(["local"]);
  });
});
