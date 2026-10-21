import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MockPlatformClient {
  fetch: ReturnType<typeof mock>;
}

let mockClient: MockPlatformClient | null = null;

mock.module("../../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockClient,
  },
}));

import {
  callManagedSearch,
  managedSearchAvailable,
} from "../managed-search-proxy.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("callManagedSearch", () => {
  beforeEach(() => {
    mockClient = {
      fetch: mock(async () =>
        jsonResponse({ query: "q", provider: "brave", results: [] }),
      ),
    };
  });

  afterEach(() => {
    mockClient = null;
  });

  test("posts to /v1/managed/search through the platform client (auth is the client's)", async () => {
    await callManagedSearch({ q: "hello" });

    expect(mockClient!.fetch).toHaveBeenCalledTimes(1);
    expect(mockClient!.fetch.mock.calls[0][0]).toBe("/v1/managed/search");
    const init = mockClient!.fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  test("sends only q when count and country are absent", async () => {
    await callManagedSearch({ q: "hello" });
    const init = mockClient!.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ q: "hello" });
  });

  test("passes count and country through", async () => {
    await callManagedSearch({ q: "hello", count: 5, country: "GB" });
    const init = mockClient!.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      q: "hello",
      count: 5,
      country: "GB",
    });
  });

  test("passes the abort signal through", async () => {
    const controller = new AbortController();
    await callManagedSearch({ q: "hello" }, controller.signal);
    const init = mockClient!.fetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  test("maps results to title/url/snippet", async () => {
    mockClient!.fetch = mock(async () =>
      jsonResponse({
        query: "hello",
        provider: "brave",
        results: [
          { title: "A", url: "https://a.example", snippet: "about a" },
          { url: "https://b.example" },
          { title: "no url" },
        ],
      }),
    );

    const result = await callManagedSearch({ q: "hello" });

    expect(result).toEqual({
      ok: true,
      query: "hello",
      provider: "brave",
      results: [
        { title: "A", url: "https://a.example", snippet: "about a" },
        { title: "", url: "https://b.example", snippet: "" },
      ],
    });
  });

  test("maps a platform error body to its detail", async () => {
    mockClient!.fetch = mock(async () =>
      jsonResponse(
        {
          code: "unavailable",
          detail: "search is not configured on this deployment",
        },
        503,
      ),
    );

    const result = await callManagedSearch({ q: "hello" });

    expect(result).toEqual({
      ok: false,
      kind: "platform-error",
      status: 503,
      detail: "search is not configured on this deployment",
      message:
        "Managed web search returned status 503: search is not configured on this deployment",
    });
  });

  test("a non-JSON error body still yields a platform error", async () => {
    mockClient!.fetch = mock(
      async () => new Response("bad gateway", { status: 502 }),
    );
    const result = await callManagedSearch({ q: "hello" });
    expect(result).toMatchObject({
      ok: false,
      kind: "platform-error",
      status: 502,
      detail: "bad gateway",
    });
  });

  test("returns unavailable when there is no platform client", async () => {
    mockClient = null;
    const result = await callManagedSearch({ q: "hello" });
    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      message: "Managed web search is unavailable in this environment.",
    });
  });

  test("returns invalid-response when results is missing", async () => {
    mockClient!.fetch = mock(async () => jsonResponse({ ok: true }));
    const result = await callManagedSearch({ q: "hello" });
    expect(result).toEqual({
      ok: false,
      kind: "invalid-response",
      message: "Managed web search returned an invalid response.",
    });
  });
});

describe("managedSearchAvailable", () => {
  test("is true with a platform client and false without", async () => {
    mockClient = { fetch: mock(async () => jsonResponse({})) };
    expect(await managedSearchAvailable()).toBe(true);
    mockClient = null;
    expect(await managedSearchAvailable()).toBe(false);
  });
});
