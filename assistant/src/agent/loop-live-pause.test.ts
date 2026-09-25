/**
 * Aexy live view (fork): a person's pause holds the real agent loop at its
 * next step boundary — the tool in flight finishes, the next model call or
 * tool batch waits — and resume lets it go on. Mocks only the provider.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { createMockProvider } from "../__tests__/helpers/mock-provider.js";
import { _resetLiveControlStateForTests } from "../live/control-state.js";
import { installLiveControl, LiveControl } from "../live/live-control.js";
import type { ProviderResponse } from "../providers/types.js";
import { AgentLoop } from "./loop.js";

const toolUse: ProviderResponse = {
  content: [{ type: "tool_use", id: "call-1", name: "slow_tool", input: {} }],
  model: "mock-model",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "tool_use",
};
const endTurn: ProviderResponse = {
  content: [{ type: "text", text: "done" }],
  model: "mock-model",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
};

const PRIYA = {
  aexy_developer_id: "dev-priya",
  display_name: "Priya Shah",
  role: "member",
};

function control(): LiveControl {
  const c = new LiveControl({
    deliver: async () => {},
    abortTurn: () => false,
    activeTask: () => null,
    releaseActiveTask: async () => {},
    resolveTarget: () => "live-pause-1",
    captureScreenshot: async () => null,
  });
  installLiveControl(c);
  return c;
}

afterEach(() => {
  installLiveControl(null);
  _resetLiveControlStateForTests();
});

describe("AgentLoop — live pause", () => {
  test("a pause taken mid-tool holds the next model call until resume", async () => {
    const live = control();
    const { provider, calls } = createMockProvider([toolUse, endTurn]);
    const order: string[] = [];
    const loop = new AgentLoop({
      provider,
      systemPrompt: "sys",
      conversationId: "live-pause-1",
      tools: [
        {
          name: "slow_tool",
          description: "",
          input_schema: { type: "object" },
        },
      ],
      toolExecutor: async () => {
        order.push("tool");
        // The person presses pause while this step is running.
        await live.handle({ command: "pause", actor: PRIYA });
        return { content: "ok", isError: false };
      },
    });

    const run = loop.run({
      requestId: "req-live-pause",
      onEvent: () => {},
      callSite: "mainAgent",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    await Bun.sleep(50);
    // The tool finished; the second model call is waiting.
    expect(order).toEqual(["tool"]);
    expect(calls).toHaveLength(1);

    await live.handle({ command: "resume", actor: PRIYA });
    await run;
    expect(calls).toHaveLength(2);
  });

  test("a stop while paused ends the turn instead of waiting forever", async () => {
    const live = control();
    await live.handle({ command: "pause", actor: PRIYA });
    const { provider } = createMockProvider([endTurn]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "sys",
      conversationId: "live-pause-1",
      tools: [],
      toolExecutor: async () => ({ content: "", isError: false }),
    });
    const abort = new AbortController();
    const run = loop.run({
      requestId: "req-live-stop",
      onEvent: () => {},
      callSite: "mainAgent",
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      signal: abort.signal,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    await Bun.sleep(20);
    abort.abort();
    const result = await run;
    expect(result.history).toHaveLength(1);
  });
});
