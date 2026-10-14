/**
 * How a working turn says what became of the card.
 *
 * Three tools, and the shape of them is the point: none takes a task id. They
 * act on the claim this process holds, because a model that could name the
 * card could act on one it was never given. The runner puts the claim in
 * place before the turn starts and takes it away after.
 *
 * `submit_task` and `release_task` are the two ways a turn is allowed to end.
 * A turn that ends without either is a turn that decided nothing, and the
 * runner gives the card back rather than leaving it held — see `runner.ts`.
 */

import { z } from "zod";

import { RiskLevel } from "../permissions/types.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../tools/shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../tools/types.js";
import { getActiveTask, markSettled } from "./active-task.js";
import { attachFile, attachFiles, mentionedFile } from "./attachments.js";
import { releaseTask, reportTaskProgress, submitTask } from "./client.js";

const NO_TASK =
  "You are not working on a workspace task right now, so there is nothing " +
  "to report against.";

const attachmentsField = z
  .array(z.string().min(1))
  .max(20)
  .optional()
  .describe(
    "Paths of files you produced for this card (relative to your workspace, " +
      "or absolute inside it). Each is uploaded to the card first; a file " +
      "in your sandbox is not a deliverable until it is attached.",
  );

const progressSchema = z.looseObject({
  note: z
    .string()
    .min(1)
    .max(5000)
    .describe(
      "What you have done or found, in a sentence or two. This goes into " +
        "the card's activity feed where the person who assigned it will " +
        "read it, so write it for them rather than for yourself.",
    ),
  attachments: attachmentsField,
});

const attachSchema = z.looseObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The file to attach: a path inside your workspace, relative to it or " +
        "absolute. One file; directories are refused. 25 MB at most.",
    ),
  note: z
    .string()
    .max(2000)
    .optional()
    .describe("Optional one-line description of what the file is."),
});

const submitSchema = z.looseObject({
  summary: z
    .string()
    .min(1)
    .max(5000)
    .describe(
      "What you did, what you changed, and anything the reviewer needs to " +
        "check. The card goes to a review column rather than to done — a " +
        "person verifies this before it counts as finished — so say what " +
        "would let them verify it quickly.",
    ),
  attachments: attachmentsField,
  confirm_no_attachments: z
    .boolean()
    .optional()
    .describe(
      "Set true only when your summary names a file you deliberately are " +
        "not attaching, and the summary says why.",
    ),
});

const releaseSchema = z.looseObject({
  reason: z
    .string()
    .min(1)
    .max(5000)
    .describe(
      "Why you could not do it. Be specific: this is the only record of " +
        "what blocked the work, and the person who picks the card up next " +
        "starts from it.",
    ),
});

export const reportTaskProgressTool = {
  name: "report_task_progress",
  description:
    "Leave a progress note on the workspace task you are working on. It " +
    "appears in the card's activity feed, attributed to you. Use it when " +
    "you learn something worth a person knowing before you finish, or when " +
    "a long step is about to start. It does not finish the task.",
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: toToolInputSchema(progressSchema),

  async execute(
    input: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = progressSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("report_task_progress", parsed.error);
    }
    const active = getActiveTask();
    if (!active) {
      return { content: NO_TASK, isError: true };
    }
    let attachmentIds: string[] | undefined;
    if (parsed.data.attachments?.length) {
      const uploaded = await attachFiles(
        active,
        parsed.data.attachments,
        context?.workingDir,
      );
      if (!uploaded.ok) {
        return { content: uploaded.error, isError: true };
      }
      attachmentIds = uploaded.ids;
    }
    const result = await reportTaskProgress(
      active.claim.task_id,
      parsed.data.note,
      undefined,
      undefined,
      attachmentIds,
    );
    if (result.outcome === "ok") {
      return { content: "Noted on the card.", isError: false };
    }
    // A refusal here means the claim is gone — stopped, or out of time. Say
    // so plainly: the turn should stop rather than carry on working a card
    // it no longer holds.
    return {
      content:
        result.outcome === "refused"
          ? `You no longer hold this task: ${result.reason} Stop work on it.`
          : `The note could not be sent: ${result.reason}`,
      isError: true,
    };
  },
} satisfies ToolDefinition;

export const submitTaskTool = {
  name: "submit_task",
  description:
    "Hand in the workspace task you are working on. The card moves to a " +
    "review column and a person checks it — it does not become done just " +
    "because you say so. Call this once, when the work is actually " +
    "finished. If you could not finish it, call release_task instead.",
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: toToolInputSchema(submitSchema),

  async execute(
    input: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = submitSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("submit_task", parsed.error);
    }
    const active = getActiveTask();
    if (!active) {
      return { content: NO_TASK, isError: true };
    }
    let attachmentIds: string[] | undefined;
    if (parsed.data.attachments?.length) {
      const uploaded = await attachFiles(
        active,
        parsed.data.attachments,
        context?.workingDir,
      );
      if (!uploaded.ok) {
        // Nothing is submitted: a hand-in without its files is the thing
        // this guards against.
        return { content: uploaded.error, isError: true };
      }
      attachmentIds = uploaded.ids;
    }
    const mentioned = mentionedFile(parsed.data.summary);
    if (
      mentioned &&
      !active.uploads?.length &&
      !parsed.data.confirm_no_attachments
    ) {
      return {
        content:
          `Your summary mentions "${mentioned}" but nothing was attached to ` +
          "this card. A file in your sandbox is not a deliverable; nobody " +
          "can open it. Attach it (attach_task_file, or the attachments " +
          "field here) and submit again — or, if you really are not " +
          "delivering a file, say why in the summary and submit with " +
          "confirm_no_attachments: true. Nothing was submitted.",
        isError: true,
      };
    }
    const result = await submitTask(
      active.claim.task_id,
      parsed.data.summary,
      undefined,
      attachmentIds,
    );
    if (result.outcome === "ok") {
      markSettled("submitted");
      return {
        content:
          "Handed in. The card is in the review column and somebody will " +
          "check it. You are done with this task.",
        isError: false,
      };
    }
    return {
      content:
        result.outcome === "refused"
          ? `This task could not be handed in: ${result.reason}`
          : `The workspace could not be reached: ${result.reason}`,
      isError: true,
    };
  },
} satisfies ToolDefinition;

export const attachTaskFileTool = {
  name: "attach_task_file",
  description:
    "Upload a file from your workspace to the workspace task you are working " +
    "on, so the person who assigned it can open it. A file in your sandbox " +
    "is not a deliverable until it is attached. Use it for every report, " +
    "document, spreadsheet or image you produced for this card. Returns the " +
    "attachment id.",
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: toToolInputSchema(attachSchema),

  async execute(
    input: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = attachSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("attach_task_file", parsed.error);
    }
    const active = getActiveTask();
    if (!active) {
      return { content: NO_TASK, isError: true };
    }
    const outcome = await attachFile(
      active,
      parsed.data.path,
      parsed.data.note,
      context?.workingDir,
    );
    if (!outcome.ok) {
      return { content: outcome.error, isError: true };
    }
    return {
      content:
        `Attached ${outcome.attachment.file_name} to the card ` +
        `(attachment id ${outcome.attachment.id}).`,
      isError: false,
    };
  },
} satisfies ToolDefinition;

export const releaseTaskTool = {
  name: "release_task",
  description:
    "Give the workspace task back, because you cannot do it. Use this when " +
    "you are blocked in a way no amount of further work resolves — a " +
    "missing credential, a site that will not let you in, a task that " +
    "turns out to need a person. Say why: it is the only record of what " +
    "blocked it.",
  category: "interaction",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: toToolInputSchema(releaseSchema),

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = releaseSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("release_task", parsed.error);
    }
    const active = getActiveTask();
    if (!active) {
      return { content: NO_TASK, isError: true };
    }
    const result = await releaseTask(active.claim.task_id, parsed.data.reason);
    if (result.outcome === "ok") {
      markSettled("released");
      return {
        content:
          "Given back. The card has returned to its previous column with " +
          "your reason on it. You are done with this task.",
        isError: false,
      };
    }
    return {
      content:
        result.outcome === "refused"
          ? `This task could not be given back: ${result.reason}`
          : `The workspace could not be reached: ${result.reason}`,
      isError: true,
    };
  },
} satisfies ToolDefinition;

/** The tools a working turn is given, and nothing else new. */
export const WORKSPACE_TASK_TOOLS = [
  reportTaskProgressTool,
  attachTaskFileTool,
  submitTaskTool,
  releaseTaskTool,
] as const;
