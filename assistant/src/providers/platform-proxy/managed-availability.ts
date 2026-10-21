/**
 * Process-wide memory of managed-proxy providers the platform has said it does
 * not have a key for.
 *
 * The control plane answers a proxied call for a provider it holds no key for
 * with HTTP 503 and `{"code":"provider_unreachable","detail":"this provider is
 * not configured on this deployment"}` (crates/control-plane runtime_proxy).
 * That is a property of the deployment, not of the request: retrying it every
 * few seconds from a background job only spams both logs. The first such answer
 * marks the provider unavailable for {@link MANAGED_UNAVAILABLE_BACKOFF_MS};
 * callers that choose between backends skip it until the window ends, after
 * which one request probes it again.
 */

import { getLogger } from "../../util/logger.js";

const log = getLogger("managed-provider-availability");

/** How long a provider the platform reports as unconfigured stays skipped. */
export const MANAGED_UNAVAILABLE_BACKOFF_MS = 60 * 60 * 1000;

/** Statuses the proxy uses for "not configured" (503 today; 501/404 tolerated). */
const NOT_CONFIGURED_STATUSES = new Set([404, 501, 503]);

/** Matches the proxy's detail text and the generic "no key configured" wording. */
const NOT_CONFIGURED_PATTERN =
  /not configured on this deployment|no key configured|provider is not configured/i;

/**
 * Thrown by a managed-proxy client when the platform reports the provider is
 * not configured. Background jobs treat it as "come back later", not as a
 * failure to retry on the normal schedule.
 */
export class ManagedProviderNotConfiguredError extends Error {
  readonly provider: string;
  readonly status: number;
  constructor(provider: string, status: number) {
    super(
      `Managed ${provider} proxy is not configured on this deployment (${status})`,
    );
    this.name = "ManagedProviderNotConfiguredError";
    this.provider = provider;
    this.status = status;
  }
}

const unavailableUntil = new Map<string, number>();

/**
 * True when a proxy response (status + body text) says the provider has no key
 * on this deployment. The body is `{code, detail}`; the detail text is matched
 * rather than the code alone because `provider_unreachable` is also used for
 * "the provider could not be reached", which is transient.
 */
export function isManagedNotConfiguredResponse(
  status: number,
  body: string,
): boolean {
  if (!NOT_CONFIGURED_STATUSES.has(status)) {
    return false;
  }
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") {
      detail = parsed.detail;
    }
  } catch {
    // Not JSON; match against the raw text.
  }
  return NOT_CONFIGURED_PATTERN.test(detail);
}

/** Mark `provider` unavailable for the backoff window; logs once per window. */
export function markManagedProviderUnavailable(
  provider: string,
  status: number,
  now: number = Date.now(),
): void {
  const alreadyDown = (unavailableUntil.get(provider) ?? 0) > now;
  unavailableUntil.set(provider, now + MANAGED_UNAVAILABLE_BACKOFF_MS);
  if (!alreadyDown) {
    log.warn(
      { provider, status, backoffMs: MANAGED_UNAVAILABLE_BACKOFF_MS },
      `Managed ${provider} is not configured on this platform deployment; skipping it for ${MANAGED_UNAVAILABLE_BACKOFF_MS / 60_000} minutes`,
    );
  }
}

/** True while the platform's "not configured" answer is still being honoured. */
export function isManagedProviderUnavailable(
  provider: string,
  now: number = Date.now(),
): boolean {
  const until = unavailableUntil.get(provider);
  if (until === undefined) {
    return false;
  }
  if (until <= now) {
    unavailableUntil.delete(provider);
    log.info({ provider }, "Managed provider backoff elapsed; probing again");
    return false;
  }
  return true;
}

/** Milliseconds left in the provider's backoff window, 0 when available. */
export function managedProviderBackoffRemainingMs(
  provider: string,
  now: number = Date.now(),
): number {
  return Math.max(0, (unavailableUntil.get(provider) ?? 0) - now);
}

/** @internal Test-only: forget all marks. */
export function _resetManagedProviderAvailability(): void {
  unavailableUntil.clear();
}
