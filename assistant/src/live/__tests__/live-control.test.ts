/**
 * What each C4 command does to the running agent, and the lease rule (C3).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetLiveControlStateForTests,
  getLiveControlSnapshot,
} from "../control-state.js";
import {
  DRIVING_REFUSAL,
  installLiveControl,
  LiveControl,
  liveToolRefusal,
  waitWhileLivePaused,
} from "../live-control.js";

const PRIYA = {
  aexy_developer_id: "dev-priya",
  display_name: "Priya Shah",
  role: "member",
};
const ARJUN = {
  aexy_developer_id: "dev-arjun",
  display_name: "Arjun Mehta",
  role: "manager",
};

function setup(
  options: { task?: { taskId: string; conversationId?: string } | null } = {},
) {
  const delivered: { conversationId: string; text: string; image: unknown }[] =
    [];
  const aborted: string[] = [];
  const releasedTasks: string[] = [];
  let running = true;
  let task = options.task === undefined ? null : options.task;
  const control = new LiveControl({
    deliver: async (conversationId, text, image) => {
      delivered.push({ conversationId, text, image: image ?? null });
    },
    abortTurn: (conversationId) => {
      if (!running) {
        return false;
      }
      aborted.push(conversationId);
      return true;
    },
    activeTask: () => task,
    releaseActiveTask: async (reason) => {
      releasedTasks.push(reason);
      task = null;
    },
    resolveTarget: () => "conv-task",
    captureScreenshot: async () => new Uint8Array([0xff, 0xd8, 0xff]),
    leaseIdleMs: 30,
  });
  installLiveControl(control);
  current = control;
  return {
    control,
    delivered,
    aborted,
    releasedTasks,
    setRunning: (value: boolean) => {
      running = value;
    },
  };
}

let current: LiveControl | null = null;

describe("live control", () => {
  beforeEach(() => {
    current?.dispose();
    current = null;
    _resetLiveControlStateForTests();
    installLiveControl(null);
  });

  test("pause holds the next step until resume, and says who paused", async () => {
    const h = setup();
    const paused = await h.control.handle({ command: "pause", actor: PRIYA });
    expect(paused).toEqual({
      status: 200,
      body: {
        ok: true,
        state: {
          paused: true,
          pausedBy: { id: "dev-priya", name: "Priya Shah" },
          holder: null,
          conversationId: "conv-task",
        },
      },
    });

    let stepped = false;
    const step = waitWhileLivePaused("conv-task").then(() => {
      stepped = true;
    });
    await Bun.sleep(5);
    expect(stepped).toBe(false);
    // Another conversation on the pod is not paused.
    await waitWhileLivePaused("conv-other");

    await h.control.handle({ command: "resume", actor: ARJUN });
    await step;
    expect(stepped).toBe(true);
    expect(getLiveControlSnapshot().paused).toBe(false);
  });

  test("an abort ends a paused wait, so a stopped turn is not held open", async () => {
    const h = setup();
    await h.control.handle({ command: "pause", actor: PRIYA });
    const abort = new AbortController();
    const step = waitWhileLivePaused("conv-task", abort.signal);
    abort.abort();
    await step;
  });

  test("instruct is attributed and delivered to the running conversation", async () => {
    const h = setup({ task: { taskId: "task-1", conversationId: "conv-9" } });
    const res = await h.control.handle({
      command: "instruct",
      actor: ARJUN,
      text: "  use the second venue  ",
    });
    expect(res.status).toBe(200);
    expect(h.delivered).toEqual([
      {
        conversationId: "conv-9",
        text: "Instruction from Arjun Mehta (manager): use the second venue",
        image: null,
      },
    ]);
  });

  test("instruct without text is refused", async () => {
    const h = setup();
    const res = await h.control.handle({ command: "instruct", actor: ARJUN });
    expect(res.status).toBe(422);
    expect(h.delivered).toEqual([]);
  });

  test("stop gives the card back with who stopped it, then aborts the turn", async () => {
    const h = setup({ task: { taskId: "task-1", conversationId: "conv-9" } });
    await h.control.handle({ command: "pause", actor: PRIYA });
    const res = await h.control.handle({ command: "stop", actor: PRIYA });
    expect(res.status).toBe(200);
    expect(h.releasedTasks).toEqual(["Stopped by Priya Shah"]);
    expect(h.aborted).toEqual(["conv-9"]);
    // Nothing left paused to strand the next turn.
    expect(getLiveControlSnapshot().paused).toBe(false);
  });

  test("stop with nothing running is no_active_run", async () => {
    const h = setup();
    h.setRunning(false);
    const res = await h.control.handle({ command: "stop", actor: PRIYA });
    expect(res).toEqual({
      status: 409,
      body: { ok: false, code: "no_active_run" },
    });
  });

  test("acquire pauses, grants one lease, and locks the browser tools", async () => {
    const h = setup();
    const res = await h.control.handle({
      command: "acquire_control",
      actor: PRIYA,
    });
    expect(res.body.state).toMatchObject({
      paused: true,
      holder: { id: "dev-priya", name: "Priya Shah" },
    });
    expect(liveToolRefusal("browser_click", "conv-task")).toBe(DRIVING_REFUSAL);
    expect(liveToolRefusal("computer_use_click", "conv-task")).toBe(
      DRIVING_REFUSAL,
    );
    expect(liveToolRefusal("bash", "conv-task")).toBeNull();

    const second = await h.control.handle({
      command: "acquire_control",
      actor: ARJUN,
    });
    expect(second).toEqual({
      status: 409,
      body: {
        ok: false,
        code: "control_held",
        holder: { id: "dev-priya", name: "Priya Shah" },
      },
    });
    // Resuming under a lease would let the agent act beside the driver.
    const resume = await h.control.handle({ command: "resume", actor: ARJUN });
    expect(resume.status).toBe(409);
  });

  test("only the holder may open the desktop", async () => {
    const h = setup();
    expect(h.control.mayOpenDesktop("dev-priya")).toBe(false);
    await h.control.handle({ command: "acquire_control", actor: PRIYA });
    expect(h.control.mayOpenDesktop("dev-priya")).toBe(true);
    expect(h.control.mayOpenDesktop("dev-arjun")).toBe(false);
    expect(h.control.mayOpenDesktop(null)).toBe(false);
  });

  test("hand-back resumes and tells the agent, with a fresh screenshot and a warning", async () => {
    const h = setup();
    await h.control.handle({ command: "acquire_control", actor: PRIYA });
    const res = await h.control.handle({
      command: "release_control",
      actor: PRIYA,
      outcome: "done",
      note: "Solved the CAPTCHA",
    });
    expect(res.status).toBe(200);
    expect(res.body.signinCandidates).toEqual([]);
    expect(getLiveControlSnapshot()).toMatchObject({
      paused: false,
      holder: null,
    });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.text).toStartWith(
      "Priya Shah handed back control (done): Solved the CAPTCHA",
    );
    expect(h.delivered[0]!.text).toContain("not evidence");
    expect(h.delivered[0]!.image).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(liveToolRefusal("browser_click", "conv-task")).toBeNull();
  });

  test("a member cannot end somebody else's lease; a manager can", async () => {
    const h = setup();
    await h.control.handle({ command: "acquire_control", actor: ARJUN });
    const refused = await h.control.handle({
      command: "release_control",
      actor: PRIYA,
    });
    expect(refused.status).toBe(409);
    await h.control.handle({ command: "release_control", actor: ARJUN });
    await h.control.handle({ command: "acquire_control", actor: PRIYA });
    const overridden = await h.control.handle({
      command: "release_control",
      actor: ARJUN,
      outcome: "cannot",
    });
    expect(overridden.status).toBe(200);
    expect(getLiveControlSnapshot().holder).toBeNull();
  });

  test("the lease ends after its idle time with the desktop socket closed, not while it is open", async () => {
    const h = setup();
    await h.control.handle({ command: "acquire_control", actor: PRIYA });
    h.control.noteDesktopSocket(true);
    await Bun.sleep(60);
    expect(getLiveControlSnapshot().holder).not.toBeNull();

    // Closing the socket is not a hand-back; the clock starts instead.
    h.control.noteDesktopSocket(false);
    expect(getLiveControlSnapshot().holder).not.toBeNull();
    await Bun.sleep(60);
    expect(getLiveControlSnapshot()).toMatchObject({
      holder: null,
      paused: false,
    });
    expect(h.delivered[0]!.text).toContain("(cannot)");
    expect(h.delivered[0]!.text).toContain("lease expired");
  });

  test("a hand-back naming the agent's takeover wakes it instead of queueing a message", async () => {
    const h = setup();
    h.control.openTakeover("take-1", "CAPTCHA on venues.example");
    expect(getLiveControlSnapshot().takeover).toEqual({
      id: "take-1",
      reason: "CAPTCHA on venues.example",
    });
    const waiting = h.control.awaitTakeover("take-1", 5_000);
    await h.control.handle({ command: "acquire_control", actor: PRIYA });
    await h.control.handle({
      command: "release_control",
      actor: PRIYA,
      takeover_id: "take-1",
      outcome: "done",
      note: "Pressed Continue",
    });
    expect(await waiting).toEqual({
      outcome: "done",
      note: "Pressed Continue",
      by: "Priya Shah",
      reason: "released",
    });
    expect(h.delivered).toEqual([]);
    expect(getLiveControlSnapshot().takeover).toBeNull();
  });

  test("a takeover nobody answers ends at its deadline", async () => {
    const h = setup();
    expect(await h.control.awaitTakeover("take-2", 10)).toBeNull();
  });

  test("sign-in decisions are not implemented; unknown commands and actors are refused", async () => {
    const h = setup();
    expect(
      await h.control.handle({ command: "signin_decision", actor: PRIYA }),
    ).toMatchObject({ status: 501, body: { code: "not_implemented" } });
    expect(
      (await h.control.handle({ command: "dance", actor: PRIYA })).status,
    ).toBe(422);
    expect(
      (
        await h.control.handle({
          command: "pause",
          actor: { aexy_developer_id: "x", role: "guardian" },
        })
      ).status,
    ).toBe(422);
  });

  test("with nothing installed the gates are no-ops", async () => {
    installLiveControl(null);
    await waitWhileLivePaused("conv-task");
    expect(liveToolRefusal("browser_click", "conv-task")).toBeNull();
  });
});
