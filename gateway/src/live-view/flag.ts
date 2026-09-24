/**
 * The fork flag every Aexy live-view divergence from upstream sits behind.
 *
 * Off (the default), the gateway behaves exactly as upstream: the guardian pin
 * is the only way onto `/v1/watch/stream` and `/v1/desktop/stream`, and the
 * `/v1/live/*` and `/v1/watch/snapshot` routes do not exist. On, the paths in
 * `docs/aexy/AGENT_LIVE_VIEW_CONTRACTS.md` (C1.4, C2.1, C4.1, C6) are served.
 */

import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";

export const LIVE_VIEW_FLAG = "aexy-live-view";

export function isLiveViewEnabled(): boolean {
  return isFeatureFlagEnabled(LIVE_VIEW_FLAG);
}
