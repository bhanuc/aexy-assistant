/**
 * One request from a live-view service route to the daemon, and its answer
 * back unchanged.
 *
 * Unlike the runtime proxy, nothing the caller sent rides along except the
 * body and its content type: the headers the daemon sees are the ones this
 * gateway chose (the service token and, where a route names one, the acting
 * person). The answer passes back verbatim, status, body and headers, which
 * is what C4.1 promises Aexy ("response passes back verbatim") and what lets
 * a snapshot's JPEG and `x-frame-*` headers reach a tile untouched.
 */

import {
  buildUpstreamUrl,
  createTimeoutController,
  isTimeoutError,
  stripHopByHop,
} from "@vellumai/assistant-client";

import { mintServiceToken } from "../auth/token-exchange.js";
import type { GatewayConfig } from "../config.js";
import { fetchImpl } from "../fetch.js";

export interface DaemonForward {
  method: "GET" | "POST" | "PUT";
  path: string;
  /** Query string including the leading `?`, or empty. */
  search?: string;
  body?: Uint8Array<ArrayBuffer> | string;
  contentType?: string;
  /** Extra headers, set after the defaults so a route can name the actor. */
  headers?: Record<string, string>;
  /** Daemon-audience token; defaults to the gateway service token. */
  token?: string;
}

export async function forwardToDaemon(
  config: GatewayConfig,
  forward: DaemonForward,
): Promise<Response> {
  const headers = new Headers({
    authorization: `Bearer ${forward.token ?? mintServiceToken()}`,
  });
  if (forward.body !== undefined) {
    headers.set("content-type", forward.contentType ?? "application/json");
  }
  for (const [name, value] of Object.entries(forward.headers ?? {})) {
    headers.set(name, value);
  }

  const { controller, clear } = createTimeoutController(
    config.runtimeTimeoutMs,
  );
  let response: Response;
  try {
    response = await fetchImpl(
      buildUpstreamUrl(
        config.assistantRuntimeBaseUrl,
        forward.path,
        forward.search ?? "",
      ),
      {
        method: forward.method,
        headers,
        body: forward.body,
        signal: controller.signal,
      },
    );
  } catch (err) {
    return Response.json(
      { error: isTimeoutError(err) ? "Gateway Timeout" : "Bad Gateway" },
      { status: isTimeoutError(err) ? 504 : 502 },
    );
  } finally {
    clear();
  }

  const out = stripHopByHop(new Headers(response.headers));
  if (out.has("content-encoding")) {
    // fetch has already decoded the body, so the framing no longer applies.
    out.delete("content-encoding");
    out.delete("content-length");
  }
  return new Response(response.body, { status: response.status, headers: out });
}
