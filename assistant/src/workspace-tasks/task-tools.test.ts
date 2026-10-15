/**
 * The three tools a working turn ends with.
 *
 * The shape being asserted is that none of them takes a task id: they act on
 * the claim this process holds. A model that could name the card could act on
 * one it was never given.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";

let submitResult: any = { outcome: "ok", value: {} };
let releaseResult: any = { outcome: "ok", value: {} };
let progressResult: any = { outcome: "ok", value: {} };
const calls: any[] = [];
let uploadSeq = 0;
let uploadResult: (fileName: string) => any = (fileName) => ({
  outcome: "ok",
  value: {
    id: `att-${++uploadSeq}`,
    file_name: fileName,
    content_type: null,
    file_size: 1,
    url: "/dl",
  },
});

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
  submitTask: (
    taskId: string,
    summary: string,
    _signal?: AbortSignal,
    attachmentIds?: string[],
  ) => {
    calls.push({ kind: "submit", taskId, summary, attachmentIds });
    return Promise.resolve(submitResult);
  },
  releaseTask: (taskId: string, reason: string) => {
    calls.push({ kind: "release", taskId, reason });
    return Promise.resolve(releaseResult);
  },
  reportTaskProgress: (
    taskId: string,
    note: string,
    _spend?: number,
    _signal?: AbortSignal,
    attachmentIds?: string[],
  ) => {
    calls.push({ kind: "progress", taskId, note, attachmentIds });
    return Promise.resolve(progressResult);
  },
  MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024,
  uploadTaskAttachment: (
    taskId: string,
    bytes: Buffer,
    fileName: string,
    note?: string,
  ) => {
    calls.push({
      kind: "upload",
      taskId,
      fileName,
      bytes: bytes.toString(),
      note,
    });
    return Promise.resolve(uploadResult(fileName));
  },
}));

const {
  submitTaskTool,
  releaseTaskTool,
  reportTaskProgressTool,
  attachTaskFileTool,
} = await import("./task-tools.js");
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
      attachTaskFileTool,
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

describe("deliverables", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deliv-")));
  const ws = join(root, "ws");
  const outside = join(root, "outside");
  const ctx = { workingDir: ws, conversationId: "c" } as any;

  mkdirSync(join(ws, "data"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(ws, "data", "MAP.md"), "# map\n");
  writeFileSync(join(outside, "secret.txt"), "nope");
  symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
  symlinkSync(outside, join(ws, "outdir"));
  mkdirSync(join(ws, "data", "aexy-competitors"), { recursive: true });
  writeFileSync(
    join(ws, "data", "aexy-competitors", "COMPETITORS.md"),
    "# c\n",
  );
  writeFileSync(join(ws, "data", "SECOND.md"), "# second\n");
  writeFileSync(join(ws, "package.json"), "{}");
  writeFileSync(join(ws, "empty.md"), "");

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    calls.length = 0;
    uploadSeq = 0;
    submitResult = { outcome: "ok", value: {} };
    progressResult = { outcome: "ok", value: {} };
    resetActiveTaskForTest();
    setActiveTask({ task: TASK, claim: CLAIM, settled: null });
  });

  test("attach_task_file uploads a relative path resolved against the workspace", async () => {
    const result = await attachTaskFileTool.execute(
      { path: "data/MAP.md", note: "competitors" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("att-1");
    expect(result.content).toContain("MAP.md");
    expect(calls[0]).toEqual({
      kind: "upload",
      taskId: "task-1",
      fileName: "MAP.md",
      bytes: "# map\n",
      note: "competitors",
    });
  });

  test("absolute paths inside the workspace work", async () => {
    const result = await attachTaskFileTool.execute(
      { path: join(ws, "data", "MAP.md") },
      ctx,
    );
    expect(result.isError).toBe(false);
  });

  test("paths outside the workspace are refused, not uploaded", async () => {
    for (const path of [
      join(outside, "secret.txt"),
      "../outside/secret.txt",
      "link.txt", // symlink out
      "outdir/secret.txt", // symlinked directory out
    ]) {
      const result = await attachTaskFileTool.execute({ path }, ctx);
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("directories and missing files are refused", async () => {
    const dir = await attachTaskFileTool.execute({ path: "data" }, ctx);
    expect(dir.isError).toBe(true);
    expect(dir.content).toContain("directory");
    const missing = await attachTaskFileTool.execute({ path: "nope.md" }, ctx);
    expect(missing.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a file over 25 MB is refused before uploading", async () => {
    const big = join(ws, "big.zip");
    writeFileSync(big, "");
    const { truncateSync } = await import("node:fs");
    truncateSync(big, 25 * 1024 * 1024 + 1);
    const result = await attachTaskFileTool.execute({ path: "big.zip" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("25");
    expect(calls).toHaveLength(0);
  });

  test("an upload the workspace refuses is reported", async () => {
    uploadResult = () => ({
      outcome: "refused",
      reason: "too_many_attachments",
    });
    const result = await attachTaskFileTool.execute(
      { path: "data/MAP.md" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("too_many_attachments");
    uploadResult = (fileName) => ({
      outcome: "ok",
      value: {
        id: `att-${++uploadSeq}`,
        file_name: fileName,
        content_type: null,
        file_size: 1,
        url: "/dl",
      },
    });
  });

  test("submit with attachments uploads first, then submits their ids", async () => {
    const result = await submitTaskTool.execute(
      { summary: "Map done, see attached.", attachments: ["data/MAP.md"] },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.kind)).toEqual(["upload", "submit"]);
    expect(calls[1].attachmentIds).toEqual(["att-1"]);
    expect(getActiveTask()?.settled).toBe("submitted");
  });

  test("a failed upload stops the submit", async () => {
    const result = await submitTaskTool.execute(
      { summary: "done", attachments: ["../outside/secret.txt"] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.kind === "submit")).toBe(false);
    expect(getActiveTask()?.settled).toBeNull();
  });

  test("progress with attachments links the uploaded ids", async () => {
    await reportTaskProgressTool.execute(
      { note: "Draft ready", attachments: ["data/MAP.md"] },
      ctx,
    );
    expect(calls[1]).toMatchObject({
      kind: "progress",
      attachmentIds: ["att-1"],
    });
  });

  test("a summary naming a file with nothing attached is bounced", async () => {
    const result = await submitTaskTool.execute(
      { summary: "Wrote data/aexy-competitors/COMPETITORS.md with the map." },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("COMPETITORS.md");
    expect(result.content).toContain("confirm_no_attachments");
    expect(calls).toHaveLength(0);
    expect(getActiveTask()?.settled).toBeNull();
  });

  test("confirm_no_attachments lets the same submit through", async () => {
    const result = await submitTaskTool.execute({
      summary: "Wrote notes.md locally; it is scratch, not a deliverable.",
      confirm_no_attachments: true,
    });
    expect(result.isError).toBe(false);
    expect(calls[0]).toMatchObject({ kind: "submit" });
  });

  test("the guard stays quiet once something was attached during the claim", async () => {
    await attachTaskFileTool.execute({ path: "data/MAP.md" }, ctx);
    const result = await submitTaskTool.execute({
      summary: "Done; the map is data/MAP.md.",
    });
    expect(result.isError).toBe(false);
  });

  test("one named file uploaded and another not still blocks", async () => {
    await attachTaskFileTool.execute({ path: "data/MAP.md" }, ctx);
    const result = await submitTaskTool.execute(
      { summary: "See data/MAP.md and data/SECOND.md." },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("data/SECOND.md");
    expect(result.content).not.toContain('"data/MAP.md"');
  });

  test("project plumbing named in passing is not a deliverable", async () => {
    const result = await submitTaskTool.execute(
      { summary: "Updated package.json." },
      ctx,
    );
    expect(result.isError).toBe(false);
  });

  test("a URL's file name is not a mention", async () => {
    const result = await submitTaskTool.execute(
      { summary: "Source: https://example.com/data/SECOND.md for context." },
      ctx,
    );
    expect(result.isError).toBe(false);
  });

  test("a non-Latin file name is detected", async () => {
    writeFileSync(join(ws, "отчёт.md"), "# r\n");
    const result = await submitTaskTool.execute(
      { summary: "Итог в отчёт.md." },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("отчёт.md");
  });

  test("a name that does not exist is not a missing deliverable", async () => {
    const result = await submitTaskTool.execute(
      { summary: "Compare with ghost.md from last week." },
      ctx,
    );
    expect(result.isError).toBe(false);
  });

  test("an empty file is refused without calling the workspace", async () => {
    const result = await attachTaskFileTool.execute({ path: "empty.md" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("empty");
    expect(calls).toHaveLength(0);
  });

  test("the same file attached twice is uploaded once", async () => {
    await attachTaskFileTool.execute({ path: "data/MAP.md" }, ctx);
    const again = await attachTaskFileTool.execute(
      { path: "data/MAP.md" },
      ctx,
    );
    expect(again.isError).toBe(false);
    expect(again.content).toContain("att-1");
    expect(calls.filter((c) => c.kind === "upload")).toHaveLength(1);
  });

  test("a partial failure names what already went up, and a retry sends only the rest", async () => {
    uploadResult = (fileName) =>
      fileName === "SECOND.md"
        ? { outcome: "unavailable", reason: "the workspace answered 503" }
        : {
            outcome: "ok",
            value: {
              id: `att-${++uploadSeq}`,
              file_name: fileName,
              content_type: null,
              file_size: 1,
              url: "/dl",
            },
          };
    const first = await submitTaskTool.execute(
      {
        summary: "Both attached.",
        attachments: ["data/MAP.md", "data/SECOND.md"],
      },
      ctx,
    );
    expect(first.isError).toBe(true);
    expect(first.content).toContain("MAP.md (att-1)");
    expect(first.content).toContain("may already be attached");
    expect(calls.some((c) => c.kind === "submit")).toBe(false);

    uploadResult = (fileName) => ({
      outcome: "ok",
      value: {
        id: `att-${++uploadSeq}`,
        file_name: fileName,
        content_type: null,
        file_size: 1,
        url: "/dl",
      },
    });
    const retry = await submitTaskTool.execute(
      {
        summary: "Both attached.",
        attachments: ["data/MAP.md", "data/SECOND.md"],
      },
      ctx,
    );
    expect(retry.isError).toBe(false);
    expect(
      calls.filter((c) => c.kind === "upload" && c.fileName === "MAP.md"),
    ).toHaveLength(1);
  });

  test("submit attachments take new files only; attach_task_file takes any", async () => {
    const { utimesSync } = await import("node:fs");
    writeFileSync(join(ws, "old.md"), "# old\n");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(ws, "old.md"), past, past);
    writeFileSync(join(ws, "fresh.md"), "# fresh\n");
    setActiveTask({
      task: TASK,
      claim: CLAIM,
      settled: null,
      startedAt: Date.now() - 1_000,
    });
    const fresh = await submitTaskTool.execute(
      { summary: "Done.", attachments: ["fresh.md"] },
      ctx,
    );
    expect(fresh.isError).toBe(false);

    setActiveTask({
      task: TASK,
      claim: CLAIM,
      settled: null,
      startedAt: Date.now() - 1_000,
    });
    const old = await submitTaskTool.execute(
      { summary: "Done.", attachments: ["old.md"] },
      ctx,
    );
    expect(old.isError).toBe(true);
    expect(old.content).toContain("attach_task_file");
    expect(getActiveTask()?.settled).toBeNull();

    const viaTool = await attachTaskFileTool.execute({ path: "old.md" }, ctx);
    expect(viaTool.isError).toBe(false);
  });

  test("attach_task_file is a medium-risk tool", () => {
    expect(attachTaskFileTool.defaultRiskLevel).toBe(RiskLevel.Medium);
  });

  test("a summary with no file name is not guarded", async () => {
    const result = await submitTaskTool.execute({
      summary: "Fixed the bug, e.g. the retry loop. See node.js docs? no.",
    });
    expect(result.isError).toBe(false);
  });
});
