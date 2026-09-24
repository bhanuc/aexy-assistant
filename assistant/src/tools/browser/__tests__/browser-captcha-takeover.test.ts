/**
 * What `browser_navigate` does with a CAPTCHA under the Aexy live view: it
 * asks a person to take over the desktop (D5) instead of waiting on a URL
 * change, and after the hand-back it looks at the page again rather than
 * taking the hand-back as proof.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createMockLoggerModule } from "../../../__tests__/helpers/mock-logger.js";
import type { TakeoverResult } from "../../../live/takeover.js";
import type { ToolContext } from "../../types.js";
import type { CdpClientKind } from "../cdp-client/types.js";

// ---------------------------------------------------------------------------
// Controllable page + handoff state
// ---------------------------------------------------------------------------

/** Whether the page currently shows a CAPTCHA. */
let captchaPresent = true;
/** What the takeover reports back. */
let takeoverResult: TakeoverResult = {
  outcome: "handed_back",
  takeoverId: "t-1",
  result: "done",
  note: "Solved it",
  by: "Priya Shah",
  leaseExpired: false,
};
/** Whether the (simulated) person actually cleared the challenge. */
let takeoverClearsCaptcha = false;

const requestLiveTakeover = mock(async (_request: unknown) => {
  if (takeoverClearsCaptcha) {
    captchaPresent = false;
  }
  return takeoverResult;
});
const startHandoff = mock(async () => "handed_over");

function makeFakeCdpClient(kind: CdpClientKind, conversationId: string) {
  return {
    kind,
    conversationId,
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression === "document.location.href") {
          return { result: { value: "https://portal.example/login" } };
        }
        if (expression === "document.title") {
          return { result: { value: "Just a moment..." } };
        }
        if (expression.startsWith("({ readyState:")) {
          return {
            result: {
              value: {
                readyState: "complete",
                href: "https://portal.example/login",
              },
            },
          };
        }
        return { result: { value: null } };
      }
      if (method === "Accessibility.getFullAXTree") {
        return { nodes: [] };
      }
      return {};
    },
    dispose: () => {},
  };
}

// ---------------------------------------------------------------------------
// Module mocks (must be declared before dynamic import)
// ---------------------------------------------------------------------------

// The detectors are mocked rather than driven through DOM probes: what is
// under test is the branch the caller takes, not the detector's selectors.
mock.module("../auth-detector.js", () => ({
  detectCaptchaChallenge: async () =>
    captchaPresent
      ? { type: "captcha", fields: [], url: "https://portal.example/login" }
      : null,
  detectAuthChallenge: async () => null,
  formatAuthChallenge: () => "",
}));

mock.module("../browser-handoff.js", () => ({ startHandoff }));

mock.module("../../../live/live-view-feature.js", () => ({
  AEXY_LIVE_VIEW_FLAG: "aexy-live-view",
  DESKTOP_CDP_HOST: "127.0.0.1",
  DESKTOP_CDP_PORT: 9222,
  isLiveViewEnabled: () => true,
}));

mock.module("../../../live/live-control-runtime.js", () => ({
  requestLiveTakeover,
}));

mock.module("../browser-screencast.js", () => ({
  ensureScreencast: async () => {},
  getSender: () => () => {},
  stopAllScreencasts: async () => {},
  stopBrowserScreencast: async () => {},
}));

mock.module("../cdp-client/factory.js", () => ({
  getCdpClient: (ctx: ToolContext) =>
    makeFakeCdpClient("cdp-inspect", ctx.conversationId),
  buildCandidateList: () => [],
  isDesktopAutoCooldownActive: () => false,
}));

mock.module("../browser-manager.js", () => ({
  browserManager: {
    getPreferredBackendKind: () => "cdp-inspect" as CdpClientKind,
    setPreferredBackendKind: () => {},
    clearPreferredBackendKind: () => {},
    storeSnapshotBackendNodeMap: () => {},
    clearSnapshotBackendNodeMap: () => {},
    resolveSnapshotBackendNodeId: () => undefined,
    isInteractive: () => false,
    supportsRouteInterception: false,
    positionWindowSidebar: async () => {},
  },
}));

mock.module("../../../daemon/host-browser-proxy.js", () => ({
  HostBrowserProxy: {
    get instance() {
      return {
        isAvailable: () => false,
        hasExtensionClient: () => false,
        waitForExtensionClient: async () => false,
        request: () => Promise.reject(new Error("no extension")),
      };
    },
  },
}));

mock.module("../runtime-check.js", () => ({
  checkBrowserRuntime: async () => ({
    playwrightAvailable: true,
    chromiumInstalled: true,
    chromiumPath: "/tmp/chromium",
    error: null,
  }),
}));

mock.module("../../../util/logger.js", () => createMockLoggerModule());

const { executeBrowserNavigate } = await import("../browser-execution.js");

function makeContext(): ToolContext {
  return {
    conversationId: "c1",
    workingDir: "/tmp",
    trustClass: "guardian",
    signal: new AbortController().signal,
  } as unknown as ToolContext;
}

async function navigate(): Promise<string> {
  const result = await executeBrowserNavigate(
    { url: "https://portal.example/login" },
    makeContext(),
  );
  return String(result.content);
}

const MANUAL = "requires human verification";
const TIMEOUT_MS = 20_000;

describe("browser_navigate after a CAPTCHA under the live view", () => {
  beforeEach(() => {
    captchaPresent = true;
    takeoverClearsCaptcha = false;
    takeoverResult = {
      outcome: "handed_back",
      takeoverId: "t-1",
      result: "done",
      note: "Solved it",
      by: "Priya Shah",
      leaseExpired: false,
    };
    requestLiveTakeover.mockClear();
    startHandoff.mockClear();
  });

  test(
    "asks for a takeover with the page, never the URL-change handoff",
    async () => {
      takeoverClearsCaptcha = true;
      const content = await navigate();
      expect(startHandoff).not.toHaveBeenCalled();
      expect(requestLiveTakeover).toHaveBeenCalledTimes(1);
      const request = requestLiveTakeover.mock.calls[0]![0] as any;
      expect(request.reason).toBe("CAPTCHA on portal.example");
      expect(request.page).toEqual({
        url: "https://portal.example/login",
        title: "Just a moment...",
      });
      expect(content).toContain(
        "Priya Shah handed back control (done): Solved it",
      );
      expect(content).toContain("The CAPTCHA is no longer on the page.");
      expect(content).not.toContain(MANUAL);
    },
    TIMEOUT_MS,
  );

  test(
    "a hand-back with the challenge still up is reported as still up",
    async () => {
      const content = await navigate();
      expect(content).toContain("handed back control (done)");
      expect(content).toContain(MANUAL);
    },
    TIMEOUT_MS,
  );

  test(
    "nobody coming by the deadline is said plainly",
    async () => {
      takeoverResult = { outcome: "expired", takeoverId: "t-1" };
      const content = await navigate();
      expect(content).toContain("Nobody took over before the deadline.");
      expect(content).toContain(MANUAL);
    },
    TIMEOUT_MS,
  );
});
