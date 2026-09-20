/**
 * What `browser_navigate` says after a CAPTCHA handoff.
 *
 * The handoff returns on a navigation, on a five-minute timeout, or
 * immediately when nobody was watching, and those are indistinguishable from
 * the caller. Reporting "CAPTCHA solved by user" on the strength of the call
 * returning sends the model on to read a challenge page as though it were the
 * destination — so the claim has to be checked against the page, not assumed.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createMockLoggerModule } from "../../../__tests__/helpers/mock-logger.js";
import type { ToolContext } from "../../types.js";
import type { HandoffOutcome } from "../browser-handoff.js";
import type { CdpClientKind } from "../cdp-client/types.js";

// ---------------------------------------------------------------------------
// Controllable page + handoff state
// ---------------------------------------------------------------------------

/** Whether the page currently shows a CAPTCHA. */
let captchaPresent = true;
/** What the handoff reports back. */
let handoffOutcome: HandoffOutcome = "handed_over";
/** Whether the (simulated) user actually cleared the challenge. */
let handoffClearsCaptcha = false;

const startHandoff = mock(async (): Promise<HandoffOutcome> => {
  if (handoffClearsCaptcha) {
    captchaPresent = false;
  }
  return handoffOutcome;
});

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

mock.module("../browser-screencast.js", () => ({
  ensureScreencast: async () => {},
  getSender: () => () => {},
  stopAllScreencasts: async () => {},
  stopBrowserScreencast: async () => {},
}));

mock.module("../cdp-client/factory.js", () => ({
  getCdpClient: (ctx: ToolContext) =>
    makeFakeCdpClient("local", ctx.conversationId),
  buildCandidateList: () => [],
  isDesktopAutoCooldownActive: () => false,
}));

mock.module("../browser-manager.js", () => ({
  browserManager: {
    getPreferredBackendKind: () => "local" as CdpClientKind,
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

const SOLVED = "CAPTCHA solved by user";
const MANUAL = "requires human verification";

// The page keeps its CAPTCHA through the five one-second re-checks that
// precede a handoff, so these cases cannot run inside the default timeout.
const TIMEOUT_MS = 20_000;

describe("browser_navigate after a CAPTCHA handoff", () => {
  beforeEach(() => {
    captchaPresent = true;
    handoffOutcome = "handed_over";
    handoffClearsCaptcha = false;
    startHandoff.mockClear();
  });

  test(
    "does not claim a solve when nobody was there to hand control to",
    async () => {
      // The regression: startHandoff returns at once with no viewer, and the
      // caller used to describe the page as though the challenge were behind
      // it.
      handoffOutcome = "no_viewer";
      const content = await navigate();

      expect(content).not.toContain(SOLVED);
      expect(content).toContain(MANUAL);
    },
    TIMEOUT_MS,
  );

  test(
    "does not claim a solve when control came back with the challenge still up",
    async () => {
      // What a five-minute timeout, or a user who gave up, looks like.
      handoffOutcome = "handed_over";
      handoffClearsCaptcha = false;
      const content = await navigate();

      expect(startHandoff).toHaveBeenCalled();
      expect(content).not.toContain(SOLVED);
      expect(content).toContain(MANUAL);
    },
    TIMEOUT_MS,
  );

  test(
    "reports the solve when the challenge is actually gone",
    async () => {
      handoffOutcome = "handed_over";
      handoffClearsCaptcha = true;
      const content = await navigate();

      expect(content).toContain(SOLVED);
      expect(content).not.toContain(MANUAL);
    },
    TIMEOUT_MS,
  );
});
