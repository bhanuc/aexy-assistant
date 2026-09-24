/** The C8 takeover ask as it goes on the wire, and how its poll is read. */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: true,
    platformBaseUrl: "https://platform.example",
    assistantApiKey: "ask_test",
  }),
}));

const { pollTakeoverAsk, postTakeoverAsk } =
  await import("./workspace-inbox.js");

describe("takeover asks in the workspace inbox", () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method?: string; body: unknown }[] = [];
  let reply: unknown = {};

  beforeEach(() => {
    requests.length = 0;
    reply = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("asks with kind takeover, no questions, and the page", async () => {
    const posted = await postTakeoverAsk({
      takeoverId: "take-1",
      reason: "CAPTCHA on venues.example",
      whatToDo: "Solve it and press Continue",
      deadlineSeconds: 1800,
      page: { url: "https://venues.example/", title: "Just a moment" },
    });
    expect(posted).toEqual({ ok: true });
    expect(requests).toEqual([
      {
        url: "https://platform.example/v1/human-help/ask",
        method: "POST",
        body: {
          origin_ref: "take-1",
          kind: "takeover",
          context: "CAPTCHA on venues.example",
          questions: [],
          takeover: {
            reason: "CAPTCHA on venues.example",
            what_to_do: "Solve it and press Continue",
            deadline_seconds: 1800,
            page: { url: "https://venues.example/", title: "Just a moment" },
          },
        },
      },
    ]);
  });

  test("reads the hand-back Aexy records as the answer", async () => {
    reply = {
      status: "answered",
      answer: {
        responses: [{ outcome: "done", note: "ok", by: "Priya Shah" }],
      },
    };
    expect(await pollTakeoverAsk("take-1")).toEqual({
      status: "answered",
      responses: [{ outcome: "done", note: "ok", by: "Priya Shah" }],
    });
    expect(requests[0]!.url).toBe(
      "https://platform.example/v1/human-help/take-1",
    );
  });
});
