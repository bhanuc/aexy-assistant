import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: true,
    platformBaseUrl: "https://platform.example",
    assistantApiKey: "ask_test",
  }),
}));

const { claimTask, heartbeatTask } = await import("./client.js");

describe("reporting the working conversation (C8)", () => {
  const originalFetch = globalThis.fetch;
  const bodies: { url: string; body: unknown }[] = [];

  beforeEach(() => {
    bodies.length = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify({ id: "claim-1" }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("claim and heartbeat carry conversation_id once there is one", async () => {
    await claimTask("task-1", undefined, "conv-1");
    await heartbeatTask("task-1", undefined, "conv-1");
    expect(bodies).toEqual([
      {
        url: "https://platform.example/v1/tasks/task-1/claim",
        body: { conversation_id: "conv-1" },
      },
      {
        url: "https://platform.example/v1/tasks/task-1/heartbeat",
        body: { conversation_id: "conv-1" },
      },
    ]);
  });

  test("and send an empty body before there is one", async () => {
    await claimTask("task-1");
    await heartbeatTask("task-1");
    expect(bodies.map((b) => b.body)).toEqual([{}, {}]);
  });
});
