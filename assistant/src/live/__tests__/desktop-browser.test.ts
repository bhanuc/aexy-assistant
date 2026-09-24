import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetDesktopBrowserForTests,
  DesktopBrowserUnavailableError,
  ensureDesktopBrowserForAgent,
  holdDesktopForClaim,
} from "../desktop-browser.js";

function fakeManager() {
  const calls: string[] = [];
  return {
    calls,
    manager: {
      ensureDesktopRunning: async () => {
        calls.push("ensure");
      },
      touch: () => calls.push("touch"),
      hold: (key: string) => calls.push(`hold:${key}`),
      release: (key: string) => calls.push(`release:${key}`),
    },
  };
}

describe("making sure the agent has a desktop Chrome", () => {
  beforeEach(() => _resetDesktopBrowserForTests());

  test("installs, starts, arms the linger, then waits for DevTools", async () => {
    const { calls, manager } = fakeManager();
    let probes = 0;
    await ensureDesktopBrowserForAgent({
      manager,
      ensureInstalled: async () => {
        calls.push("install");
      },
      probeCdp: async () => ++probes >= 3,
    });
    expect(calls).toEqual(["install", "ensure", "touch"]);
    expect(probes).toBe(3);
  });

  test("concurrent callers share one start", async () => {
    const { calls, manager } = fakeManager();
    const deps = {
      manager,
      ensureInstalled: async () => {},
      probeCdp: async () => true,
    };
    await Promise.all([
      ensureDesktopBrowserForAgent(deps),
      ensureDesktopBrowserForAgent(deps),
    ]);
    expect(calls.filter((c) => c === "ensure")).toHaveLength(1);
  });

  test("a desktop that will not start is a typed failure", async () => {
    const { manager } = fakeManager();
    manager.ensureDesktopRunning = async () => {
      throw new Error("Xtigervnc missing");
    };
    await expect(
      ensureDesktopBrowserForAgent({
        manager,
        ensureInstalled: async () => {},
        probeCdp: async () => true,
      }),
    ).rejects.toBeInstanceOf(DesktopBrowserUnavailableError);
  });

  test("a Chrome that never opens its port gives up at the deadline", async () => {
    const { manager } = fakeManager();
    await expect(
      ensureDesktopBrowserForAgent({
        manager,
        ensureInstalled: async () => {},
        probeCdp: async () => false,
        readyDeadlineMs: 50,
      }),
    ).rejects.toThrow("DevTools port 9222");
  });

  test("a claim holds the desktop until it ends", () => {
    const { calls, manager } = fakeManager();
    const release = holdDesktopForClaim("claim-7", { manager });
    expect(calls).toEqual(["hold:workspace-task:claim-7"]);
    release();
    expect(calls).toEqual([
      "hold:workspace-task:claim-7",
      "release:workspace-task:claim-7",
    ]);
  });
});
