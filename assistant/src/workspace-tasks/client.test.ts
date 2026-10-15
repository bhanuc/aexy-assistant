import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: true,
    platformBaseUrl: "https://platform.example",
    assistantApiKey: "ask_test",
  }),
}));

const {
  claimTask,
  heartbeatTask,
  reportTaskProgress,
  submitTask,
  uploadTaskAttachment,
} = await import("./client.js");

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

describe("uploading a deliverable", () => {
  const originalFetch = globalThis.fetch;
  let dir: string;
  let captured: { url: string; init: RequestInit } | null;
  let response: Response;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "client-upload-"));
    captured = null;
    response = new Response(
      JSON.stringify({
        id: "att-1",
        file_name: "report.md",
        content_type: "text/markdown",
        file_size: 5,
        url: "/dl/att-1",
      }),
      { status: 201 },
    );
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured = { url, init: init as RequestInit };
      return response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test("posts multipart with the file and note, authenticated, no forced content-type", async () => {
    const result = await uploadTaskAttachment(
      "task-1",
      Buffer.from("# Hi\n"),
      "report.md",
      "the map",
    );
    expect(result).toMatchObject({
      outcome: "ok",
      value: { id: "att-1", file_name: "report.md" },
    });
    expect(captured!.url).toBe(
      "https://platform.example/v1/tasks/task-1/attachments",
    );
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ask_test");
    // fetch must set the multipart boundary itself.
    expect(headers["content-type"]).toBeUndefined();
    const body = captured!.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const sent = body.get("file") as File;
    expect(sent.name).toBe("report.md");
    expect(await sent.text()).toBe("# Hi\n");
    expect(body.get("note")).toBe("the map");
  });

  test("omits the note when there is none", async () => {
    await uploadTaskAttachment("task-1", Buffer.from("x"), "a.txt");
    expect((captured!.init.body as FormData).has("note")).toBe(false);
  });

  test("a 409 with a coded detail is a refusal with the code in it", async () => {
    response = new Response(
      JSON.stringify({ detail: { code: "no_claim", message: "No claim." } }),
      { status: 409 },
    );
    expect(
      await uploadTaskAttachment("task-1", Buffer.from("x"), "a.txt"),
    ).toEqual({
      outcome: "refused",
      reason: "No claim.",
    });
  });

  test("an empty file is refused without calling the workspace", async () => {
    const result = await uploadTaskAttachment(
      "task-1",
      Buffer.alloc(0),
      "nope.txt",
    );
    expect(result.outcome).toBe("refused");
    expect(captured).toBeNull();
  });

  test("a 422 detail string is surfaced as the reason", async () => {
    response = new Response(JSON.stringify({ detail: "that file is empty" }), {
      status: 422,
    });
    expect(
      await uploadTaskAttachment("task-1", Buffer.from("x"), "a.txt"),
    ).toEqual({ outcome: "refused", reason: "that file is empty" });
  });

  test("a 429 waits Retry-After and tries again, twice at most", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return attempts < 3
        ? new Response(JSON.stringify({ detail: "slow down" }), {
            status: 429,
            headers: { "retry-after": "0" },
          })
        : new Response(JSON.stringify({ id: "att-9" }), { status: 201 });
    }) as unknown as typeof fetch;
    const ok = await uploadTaskAttachment("task-1", Buffer.from("x"), "a.txt");
    expect(ok).toMatchObject({ outcome: "ok", value: { id: "att-9" } });
    expect(attempts).toBe(3);

    attempts = -10; // never succeeds
    const refused = await uploadTaskAttachment(
      "task-1",
      Buffer.from("x"),
      "a.txt",
    );
    expect(refused).toEqual({ outcome: "refused", reason: "slow down" });
    expect(attempts).toBe(-7); // the first try plus two retries
  });

  test("submit and progress carry attachment_ids only when given", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await submitTask("task-1", "done", undefined, ["a1", "a2"]);
    await submitTask("task-1", "done");
    await reportTaskProgress("task-1", "note", undefined, undefined, ["a1"]);
    expect(bodies[0]).toEqual({
      summary: "done",
      attachment_ids: ["a1", "a2"],
    });
    expect(bodies[1]).toEqual({ summary: "done" });
    expect(bodies[2].attachment_ids).toEqual(["a1"]);
  });
});
