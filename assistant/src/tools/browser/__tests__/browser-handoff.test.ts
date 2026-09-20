/**
 * `startHandoff` reports what it actually did.
 *
 * It returns immediately when nothing is watching the conversation's browser,
 * and a caller that could not tell that apart from a completed handoff would
 * go on to describe the page as though a human had just dealt with whatever
 * was blocking it.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createMockLoggerModule } from "../../../__tests__/helpers/mock-logger.js";

let screencastActive = false;
let bringToFrontFails = false;

const setInteractiveMode = mock((_conversationId: string, _on: boolean) => {});
const waitForHandoffComplete = mock(async (_conversationId: string) => {});
const bringToFront = mock(async () => {});

mock.module("../browser-screencast.js", () => ({
  isScreencastActive: (_conversationId: string) => screencastActive,
}));

mock.module("../browser-manager.js", () => ({
  browserManager: {
    getOrCreateSessionPage: async () => {
      if (bringToFrontFails) {
        throw new Error("no page");
      }
      return { bringToFront };
    },
    setInteractiveMode,
    waitForHandoffComplete,
  },
}));

mock.module("../../../util/logger.js", () => createMockLoggerModule());

const { startHandoff } = await import("../browser-handoff.js");

const OPTIONS = {
  reason: "captcha" as const,
  message: "Please solve the CAPTCHA.",
  bringToFront: true,
};

describe("startHandoff", () => {
  beforeEach(() => {
    screencastActive = false;
    bringToFrontFails = false;
    setInteractiveMode.mockClear();
    waitForHandoffComplete.mockClear();
    bringToFront.mockClear();
  });

  test("reports no_viewer when nothing is watching, and waits for nobody", async () => {
    expect(await startHandoff("c1", OPTIONS)).toBe("no_viewer");
    // The session is never put into interactive mode and no time is spent
    // waiting: there is no one to hand control to.
    expect(setInteractiveMode).not.toHaveBeenCalled();
    expect(waitForHandoffComplete).not.toHaveBeenCalled();
  });

  test("reports handed_over once control has been offered and returned", async () => {
    screencastActive = true;
    expect(await startHandoff("c1", OPTIONS)).toBe("handed_over");
    expect(setInteractiveMode).toHaveBeenCalledWith("c1", true);
    expect(waitForHandoffComplete).toHaveBeenCalledWith("c1");
  });

  test("a window that will not come to the front does not change the outcome", async () => {
    // Fronting is a courtesy. Failing it must not be reported as a handoff
    // that did not happen, nor stop one that can.
    screencastActive = true;
    bringToFrontFails = true;
    expect(await startHandoff("c1", OPTIONS)).toBe("handed_over");
    expect(waitForHandoffComplete).toHaveBeenCalledWith("c1");
  });
});
