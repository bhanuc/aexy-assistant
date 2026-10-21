import { VellumPlatformClient } from "../../platform/client.js";

/**
 * Managed web search, served by the Aexy platform control plane at
 * `POST /v1/managed/search`. The platform holds the provider key and answers
 * a narrow `{q, count, country}` request; it does not relay arbitrary
 * provider paths or headers, so there is no request envelope here.
 */
export const MANAGED_SEARCH_PATH = "/v1/managed/search";

export interface ManagedSearchRequest {
  q: string;
  count?: number;
  /** Two-letter country code. */
  country?: string;
}

export interface ManagedSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export type ManagedSearchResult =
  | {
      ok: true;
      query: string;
      provider: string;
      results: ManagedSearchResultItem[];
    }
  | {
      ok: false;
      kind: "unavailable";
      message: string;
    }
  | {
      ok: false;
      kind: "platform-error";
      status: number;
      /** The platform's error detail, when it sent one. */
      detail: string | undefined;
      message: string;
    }
  | {
      ok: false;
      kind: "invalid-response";
      message: string;
    };

/**
 * Whether managed search can be dialed at all: a platform client exists
 * (platform features enabled and credentials present). Callers use this to
 * choose between managed search and the BYOK chain before attempting a call.
 */
export async function managedSearchAvailable(): Promise<boolean> {
  const client = await VellumPlatformClient.create();
  return client !== null;
}

export async function callManagedSearch(
  request: ManagedSearchRequest,
  signal?: AbortSignal,
): Promise<ManagedSearchResult> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    return {
      ok: false,
      kind: "unavailable",
      message: "Managed web search is unavailable in this environment.",
    };
  }

  const body: Record<string, unknown> = { q: request.q };
  if (request.count !== undefined) {
    body.count = request.count;
  }
  if (request.country) {
    body.country = request.country;
  }

  const response = await client.fetch(MANAGED_SEARCH_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const parsed = await readResponseBody(response);

  if (!response.ok) {
    const detail = extractErrorDetail(parsed);
    return {
      ok: false,
      kind: "platform-error",
      status: response.status,
      detail,
      message: detail
        ? `Managed web search returned status ${response.status}: ${detail}`
        : `Managed web search returned status ${response.status}.`,
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    return {
      ok: false,
      kind: "invalid-response",
      message: "Managed web search returned an invalid response.",
    };
  }

  const results: ManagedSearchResultItem[] = [];
  for (const item of parsed.results) {
    if (!isRecord(item) || typeof item.url !== "string") {
      continue;
    }
    results.push({
      title: typeof item.title === "string" ? item.title : "",
      url: item.url,
      snippet: typeof item.snippet === "string" ? item.snippet : "",
    });
  }

  return {
    ok: true,
    query: typeof parsed.query === "string" ? parsed.query : request.q,
    provider: typeof parsed.provider === "string" ? parsed.provider : "brave",
    results,
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The platform's ErrorBody carries the human text under `error`/`message`/
 * `detail` depending on the route; a nested `{error: {message}}` is handled
 * too.
 */
function extractErrorDetail(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body || undefined;
  }
  if (!isRecord(body)) {
    return undefined;
  }
  for (const key of ["detail", "message", "error"]) {
    const value = body[key];
    if (typeof value === "string" && value) {
      return value;
    }
    if (isRecord(value) && typeof value.message === "string" && value.message) {
      return value.message;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
