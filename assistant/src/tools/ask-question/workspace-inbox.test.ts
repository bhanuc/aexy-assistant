import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import type { ToolContext } from "../types.js";

// Hoisted before the tool's static imports, as every mock in this package is.
let inboxCalls: any[] = [];
let inboxResult: any = { outcome: "unavailable", reason: "not connected" };

mock.module("./workspace-inbox.js", () => ({
  parkInWorkspaceInbox: (options: any) => {
    inboxCalls.push(options);
    return Promise.resolve(inboxResult);
  },
  canReachWorkspaceInbox: () => Promise.resolve(true),
}));

mock.module("../../permissions/question-prompter.js", () => ({
  QuestionPrompter: class {
    prompt() {
      return Promise.resolve({ overall: "completed", entries: [] });
    }
  },
}));

const { askQuestionTool } = await import("./ask-question-tool.js");

const INPUT = {
  questions: [
    {
      question: "Which reconciliation method should Q3 be filed under?",
      options: [
        { id: "ledger", label: "Method A — 4,182,900" },
        { id: "memo", label: "Method B — 3,010,400" },
      ],
    },
  ],
};

/**
 * A scheduled turn on a deployment with no channel that renders option cards.
 * The common case, and the one `park` used to do nothing useful for.
 */
function unattendedNoChannel(): ToolContext {
  return {
    conversationId: "c1",
    toolUseId: "toolu_abc123",
    isInteractive: false,
    trustClass: "guardian",
    supportsGuardianQuestionCards: false,
    supportsDynamicUi: false,
  } as unknown as ToolContext;
}

describe("park via the workspace inbox", () => {
  beforeEach(() => {
    inboxCalls = [];
    inboxResult = { outcome: "unavailable", reason: "not connected" };
    setConfig("conversations", { unattendedQuestions: "park" });
  });

  test("a question with no channel goes to the workspace instead of bouncing", async () => {
    inboxResult = {
      outcome: "answered",
      responses: [{ questionId: "q1", decision: "option", optionId: "memo" }],
    };

    const result = await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(inboxCalls).toHaveLength(1);
    expect(result.isError).toBe(false);
    // The label, not the option id: an id means nothing to the model.
    expect(result.content).toContain("Method B — 3,010,400");
  });

  test("the request id is the tool_use id, so a retry lands on one question", async () => {
    inboxResult = { outcome: "answered", responses: [] };

    await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(inboxCalls[0].requestId).toBe("toolu_abc123");
    // Four hours, not the interactive half-hour: somebody may be asleep.
    expect(inboxCalls[0].timeoutMs).toBe(14_400_000);
    // The ids the daemon would have assigned, so the answer comes back keyed
    // the way the rest of this file expects.
    expect(inboxCalls[0].questionIds).toEqual(["q1"]);
  });

  test("a skipped question is carried through as a skip, not as a gap", async () => {
    inboxResult = {
      outcome: "answered",
      responses: [{ questionId: "q1", decision: "skipped" }],
    };

    const result = await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("chose not to answer");
  });

  test("free text comes back verbatim", async () => {
    inboxResult = {
      outcome: "answered",
      responses: [
        {
          questionId: "q1",
          decision: "free_text",
          text: "Neither — 3,118,000.",
        },
      ],
    };

    const result = await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(result.content).toContain("Neither — 3,118,000.");
  });

  test("a question nobody answered stops the run and forbids guessing", async () => {
    inboxResult = { outcome: "expired" };

    const result = await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("nobody answered");
    // The instruction that makes this different from the old `proceed`.
    expect(result.content).toContain("do not pick one of the options yourself");
  });

  test("still waiting is an error too, not a licence to continue", async () => {
    inboxResult = { outcome: "timeout" };

    const result = await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("do not pick one of the options yourself");
  });

  test("an unreachable inbox falls back to the refusal, never to proceeding", async () => {
    inboxResult = { outcome: "unavailable", reason: "no platform url" };

    const result = await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unattendedQuestions=park");
    // The question travels with the refusal, so the failed run says what it
    // needed to know.
    expect(result.content).toContain("Which reconciliation method");
  });

  test("fail does not consult the workspace at all", async () => {
    setConfig("conversations", { unattendedQuestions: "fail" });

    const result = await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(inboxCalls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unattendedQuestions=fail");
  });

  test("proceed does not consult the workspace either", async () => {
    setConfig("conversations", { unattendedQuestions: "proceed" });

    const result = await askQuestionTool.execute(INPUT, unattendedNoChannel());

    expect(inboxCalls).toHaveLength(0);
    expect(result.isError).toBe(false);
  });
});
