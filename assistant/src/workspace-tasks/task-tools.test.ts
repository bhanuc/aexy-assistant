/**
 * The three tools a working turn ends with.
 *
 * The shape being asserted is that none of them takes a task id: they act on
 * the claim this process holds. A model that could name the card could act on
 * one it was never given.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let submitResult: any = { outcome: "ok", value: {} };
let releaseResult: any = { outcome: "ok", value: {} };
let progressResult: any = { outcome: "ok", value: {} };
const calls: any[] = [];

// Every export the module has, not just the three these tools use: bun's
// module mocks are process-wide, so a partial mock here would break any other
// test file in the same run that imports the rest.
mock.module("./client.js", () => ({
  canReachWorkspaceTasks: () => Promise.resolve(true),
  readTaskQueue: () =>
    Promise.resolve({
      outcome: "ok",
      value: { developer_id: "dev-1", assistant_name: "Vega", tasks: [] },
    }),
  claimTask: () => Promise.resolve({ outcome: "refused", reason: "not here" }),
  heartbeatTask: () => Promise.resolve({ outcome: "ok", value: {} }),
  submitTask: (taskId: string, summary: string) => {
    calls.push({ kind: "submit", taskId, summary });
    return Promise.resolve(submitResult);
  },
  releaseTask: (taskId: string, reason: string) => {
    calls.push({ kind: "release", taskId, reason });
    return Promise.resolve(releaseResult);
  },
  reportTaskProgress: (taskId: string, note: string) => {
    calls.push({ kind: "progress", taskId, note });
    return Promise.resolve(progressResult);
  },
}));

const { submitTaskTool, releaseTaskTool, reportTaskProgressTool } =
  await import("./task-tools.js");
const { setActiveTask, getActiveTask, resetActiveTaskForTest } =
  await import("./active-task.js");

const CLAIM = { id: "claim-1", task_id: "task-1" } as any;
const TASK = { id: "task-1", title: "File the return" } as any;

describe("workspace task tools", () => {
  beforeEach(() => {
    calls.length = 0;
    submitResult = { outcome: "ok", value: {} };
    releaseResult = { outcome: "ok", value: {} };
    progressResult = { outcome: "ok", value: {} };
    resetActiveTaskForTest();
  });

  test("none of them takes a task id", () => {
    for (const tool of [
      submitTaskTool,
      releaseTaskTool,
      reportTaskProgressTool,
    ]) {
      const properties = (tool.input_schema as any).properties ?? {};
      expect(Object.keys(properties)).not.toContain("task_id");
      expect(Object.keys(properties)).not.toContain("taskId");
    }
  });

  test("outside a task they refuse with a sentence rather than acting", async () => {
    const result = await submitTaskTool.execute({ summary: "done" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not working on a workspace task");
    expect(calls).toHaveLength(0);
  });

  test("submitting acts on the claim this process holds", async () => {
    setActiveTask({ task: TASK, claim: CLAIM, settled: null });
    const result = await submitTaskTool.execute({ summary: "Filed it." });
    expect(result.isError).toBe(false);
    expect(calls[0]).toMatchObject({ kind: "submit", taskId: "task-1" });
    // The runner reads this to know the turn settled itself.
    expect(getActiveTask()?.settled).toBe("submitted");
  });

  test("submitting says a person still has to check", async () => {
    setActiveTask({ task: TASK, claim: CLAIM, settled: null });
    const result = await submitTaskTool.execute({ summary: "Filed it." });
    expect(result.content).toContain("review");
  });

  test("releasing records the reason and settles the turn", async () => {
    setActiveTask({ task: TASK, claim: CLAIM, settled: null });
    const result = await releaseTaskTool.execute({
      reason: "The portal wants a certificate I do not have.",
    });
    expect(result.isError).toBe(false);
    expect(calls[0]).toMatchObject({ kind: "release" });
    expect(getActiveTask()?.settled).toBe("released");
  });

  test("a refused note tells the turn to stop rather than to retry", async () => {
    setActiveTask({ task: TASK, claim: CLAIM, settled: null });
    progressResult = { outcome: "refused", reason: "You do not hold this." };
    const result = await reportTaskProgressTool.execute({ note: "Working." });
    expect(result.isError).toBe(true);
    // This is a person's stop button arriving.
    expect(result.content).toContain("Stop work on it");
  });

  test("a failed submit does not pretend the turn settled", async () => {
    setActiveTask({ task: TASK, claim: CLAIM, settled: null });
    submitResult = { outcome: "refused", reason: "Your claim is gone." };
    const result = await submitTaskTool.execute({ summary: "Filed it." });
    expect(result.isError).toBe(true);
    // Otherwise the runner would leave a card nobody handed in.
    expect(getActiveTask()?.settled).toBeNull();
  });

  test("an empty summary is refused before it reaches the workspace", async () => {
    setActiveTask({ task: TASK, claim: CLAIM, settled: null });
    const result = await submitTaskTool.execute({ summary: "" });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
