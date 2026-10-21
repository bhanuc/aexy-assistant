import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetManagedProviderAvailability,
  isManagedNotConfiguredResponse,
  isManagedProviderUnavailable,
  MANAGED_UNAVAILABLE_BACKOFF_MS,
  managedProviderBackoffRemainingMs,
  markManagedProviderUnavailable,
} from "./managed-availability.js";

afterEach(() => _resetManagedProviderAvailability());

describe("isManagedNotConfiguredResponse", () => {
  const body = JSON.stringify({
    code: "provider_unreachable",
    detail: "this provider is not configured on this deployment",
  });

  test("matches the control plane's not-configured body on 503, 501 and 404", () => {
    expect(isManagedNotConfiguredResponse(503, body)).toBe(true);
    expect(isManagedNotConfiguredResponse(501, body)).toBe(true);
    expect(isManagedNotConfiguredResponse(404, body)).toBe(true);
  });

  test("matches a plain-text 'no key configured' body", () => {
    expect(
      isManagedNotConfiguredResponse(
        503,
        "no key configured for this provider",
      ),
    ).toBe(true);
  });

  test("ignores transient provider_unreachable details and other statuses", () => {
    const transient = JSON.stringify({
      code: "provider_unreachable",
      detail: "the provider could not be reached",
    });
    expect(isManagedNotConfiguredResponse(503, transient)).toBe(false);
    expect(isManagedNotConfiguredResponse(502, body)).toBe(false);
    expect(isManagedNotConfiguredResponse(403, body)).toBe(false);
  });
});

describe("managed provider backoff", () => {
  test("is unavailable for the window, then recovers", () => {
    const t0 = 1_000_000;
    expect(isManagedProviderUnavailable("gemini", t0)).toBe(false);
    markManagedProviderUnavailable("gemini", 503, t0);
    expect(isManagedProviderUnavailable("gemini", t0 + 1)).toBe(true);
    expect(managedProviderBackoffRemainingMs("gemini", t0 + 1000)).toBe(
      MANAGED_UNAVAILABLE_BACKOFF_MS - 1000,
    );
    expect(
      isManagedProviderUnavailable(
        "gemini",
        t0 + MANAGED_UNAVAILABLE_BACKOFF_MS,
      ),
    ).toBe(false);
    expect(
      managedProviderBackoffRemainingMs(
        "gemini",
        t0 + MANAGED_UNAVAILABLE_BACKOFF_MS,
      ),
    ).toBe(0);
  });

  test("is tracked per provider", () => {
    markManagedProviderUnavailable("gemini", 503, 5);
    expect(isManagedProviderUnavailable("openai", 6)).toBe(false);
  });
});
