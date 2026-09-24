import { describe, test, expect, mock } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import {
  DAEMON_IDENTITY_HEADER_NAMES,
  stripLiveViewIdentityHeaderRecord,
} from "../live-view/identity-headers.js";
import { makeConfig } from "./runtime-stream-test-utils.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let captured: Headers | undefined;
mock.module("../fetch.js", () => ({
  fetchImpl: (async (_input, init) => {
    captured = init?.headers as Headers;
    return new Response("{}", { status: 200 });
  }) satisfies FetchFn,
}));

const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

/** A caller trying to pass for someone the gateway attested. */
const SPOOFED: Record<string, string> = {
  "x-vellum-viewer-id": "someone-else",
  "x-vellum-viewer-role": "owner",
  "x-vellum-stream-scope": "control",
  "x-vellum-live-session-id": "forged",
  "x-vellum-aexy-developer-id": "forged",
  "x-vellum-display-name": "Owner",
  "x-vellum-acting-user-id": "someone-else",
  "x-vellum-acting-user-name": "Owner",
  "x-vellum-acting-user-role": "owner",
  "x-vellum-acting-aexy-developer-id": "forged",
};

/**
 * The daemon believes these headers because only the gateway can reach it,
 * so the runtime proxies must drop any copy a client sends. They do so with
 * the flag off too: the header means "the gateway attested this" on every
 * build or on none.
 */
describe("live-view identity headers from clients", () => {
  test("the runtime proxy drops every one before forwarding", async () => {
    const token = mintToken({
      aud: "vellum-gateway",
      sub: "actor:test-assistant:test-user",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });
    await createRuntimeProxyHandler(makeConfig() as GatewayConfig)(
      new Request("http://localhost:7830/v1/messages", {
        headers: {
          authorization: `Bearer ${token}`,
          "x-vellum-conversation-id": "conv-1",
          ...SPOOFED,
        },
      }),
    );

    for (const name of Object.keys(SPOOFED)) {
      expect(captured!.has(name)).toBe(false);
    }
    // An ordinary client header of the same family is left alone.
    expect(captured!.get("x-vellum-conversation-id")).toBe("conv-1");
  });

  test("the IPC proxy's header record loses every one", () => {
    const headers = { ...SPOOFED, "x-vellum-client-id": "c1" };

    stripLiveViewIdentityHeaderRecord(headers);

    expect(headers).toEqual({ "x-vellum-client-id": "c1" });
  });

  test("the strip list covers every header the gateway attests", () => {
    expect([...DAEMON_IDENTITY_HEADER_NAMES].sort()).toEqual(
      Object.keys(SPOOFED).sort(),
    );
  });
});
