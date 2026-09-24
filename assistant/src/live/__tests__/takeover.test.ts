/**
 * The agent asking for hands (D5): who is asked, what ends the wait, and that
 * a wait with nobody to ask never starts.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetLiveControlStateForTests,
  getLiveControlSnapshot,
} from "../control-state.js";
import { LiveControl } from "../live-control.js";
import { describeTakeover, requestTakeover } from "../takeover.js";

const PRIYA = {
  aexy_developer_id: "dev-priya",
  display_name: "Priya Shah",
  role: "member",
};

function control(): LiveControl {
  return new LiveControl({
    deliver: async () => {},
    abortTurn: () => false,
    activeTask: () => null,
    releaseActiveTask: async () => {},
    resolveTarget: () => "conv-1",
    captureScreenshot: async () => null,
    leaseIdleMs: 20,
  });
}

describe("requesting a takeover", () => {
  beforeEach(() => _resetLiveControlStateForTests());

  test("posts a takeover ask, shows it to watchers, and ends on the hand-back naming it", async () => {
    const live = control();
    const posted: unknown[] = [];
    const pending = requestTakeover(
      {
        reason: "CAPTCHA on venues.example",
        whatToDo: "Solve it",
        deadlineSeconds: 60,
        page: { url: "https://venues.example/", title: "Just a moment" },
      },
      {
        control: live,
        viewerCount: () => 0,
        newId: () => "take-1",
        post: async (ask) => {
          posted.push(ask);
          return { ok: true };
        },
        poll: async () => ({ status: "in_progress", responses: [] }),
        pollIntervalMs: 5,
      },
    );
    await Bun.sleep(10);
    expect(posted).toEqual([
      {
        takeoverId: "take-1",
        reason: "CAPTCHA on venues.example",
        whatToDo: "Solve it",
        deadlineSeconds: 60,
        page: { url: "https://venues.example/", title: "Just a moment" },
        signal: undefined,
      },
    ]);
    expect(getLiveControlSnapshot().takeover).toEqual({
      id: "take-1",
      reason: "CAPTCHA on venues.example",
    });

    await live.handle({ command: "acquire_control", actor: PRIYA });
    await live.handle({
      command: "release_control",
      actor: PRIYA,
      takeover_id: "take-1",
      outcome: "done",
      note: "Pressed Continue",
    });
    const result = await pending;
    expect(result).toEqual({
      outcome: "handed_back",
      takeoverId: "take-1",
      result: "done",
      note: "Pressed Continue",
      by: "Priya Shah",
      leaseExpired: false,
    });
    expect(describeTakeover(result)).toBe(
      "Priya Shah handed back control (done): Pressed Continue",
    );
    expect(getLiveControlSnapshot().takeover).toBeNull();
    live.dispose();
  });

  test("the workspace expiring the ask ends the wait", async () => {
    const live = control();
    const result = await requestTakeover(
      { reason: "2FA", whatToDo: "Enter the code" },
      {
        control: live,
        viewerCount: () => 0,
        newId: () => "take-2",
        post: async () => ({ ok: true }),
        poll: async () => ({ status: "expired", responses: [] }),
        pollIntervalMs: 5,
      },
    );
    expect(result).toEqual({ outcome: "expired", takeoverId: "take-2" });
    live.dispose();
  });

  test("an ask answered in the inbox without a hand-back still counts", async () => {
    const live = control();
    const result = await requestTakeover(
      { reason: "2FA", whatToDo: "Enter the code" },
      {
        control: live,
        viewerCount: () => 0,
        newId: () => "take-3",
        post: async () => ({ ok: true }),
        poll: async () => ({
          status: "answered",
          responses: [{ outcome: "cannot", note: "No phone", by: "Arjun" }],
        }),
        pollIntervalMs: 5,
      },
    );
    expect(result).toMatchObject({
      outcome: "handed_back",
      result: "cannot",
      note: "No phone",
      by: "Arjun",
    });
    live.dispose();
  });

  test("the deadline ends the wait when nobody comes", async () => {
    const live = control();
    const result = await requestTakeover(
      { reason: "CAPTCHA", whatToDo: "Solve it", deadlineSeconds: 0.03 },
      {
        control: live,
        viewerCount: () => 0,
        newId: () => "take-4",
        post: async () => ({ ok: true }),
        poll: async () => ({ status: "pending", responses: [] }),
        pollIntervalMs: 5,
      },
    );
    expect(result.outcome).toBe("expired");
    expect(describeTakeover(result)).toBe(
      "Nobody took over before the deadline.",
    );
    live.dispose();
  });

  test("nobody to ask and nobody watching: no wait at all", async () => {
    const live = control();
    const started = Date.now();
    const result = await requestTakeover(
      { reason: "CAPTCHA", whatToDo: "Solve it" },
      {
        control: live,
        viewerCount: () => 0,
        post: async () => ({ ok: false, reason: "not connected" }),
      },
    );
    expect(result).toEqual({ outcome: "unavailable", reason: "not connected" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(getLiveControlSnapshot().takeover).toBeNull();
    live.dispose();
  });

  test("an abort cancels the wait", async () => {
    const live = control();
    const abort = new AbortController();
    const pending = requestTakeover(
      { reason: "CAPTCHA", whatToDo: "Solve it", signal: abort.signal },
      {
        control: live,
        viewerCount: () => 1,
        newId: () => "take-5",
        post: async () => ({ ok: false, reason: "inbox down" }),
      },
    );
    await Bun.sleep(5);
    abort.abort();
    expect(await pending).toEqual({
      outcome: "cancelled",
      takeoverId: "take-5",
    });
    live.dispose();
  });
});
