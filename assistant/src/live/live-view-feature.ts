/**
 * The Aexy live view: people watching an assistant's browser while it works,
 * and taking the wheel when it needs hands.
 *
 * Everything under `src/live/` is fork code and switches on together, behind
 * two flags. `assistant-desktop` is upstream's: a containerized pod may run an
 * X desktop at all. `aexy-live-view` is ours: the browser tool drives *that*
 * desktop's Chrome instead of a headless one nobody can see, and the watch
 * stream, snapshot and control routes are served. With either off, every path
 * here is inert and upstream behaviour is untouched.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import { isAssistantDesktopEnabled } from "../desktop/desktop-feature.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("live-view");

export const AEXY_LIVE_VIEW_FLAG = "aexy-live-view" as const;

/**
 * Where the desktop Chrome answers DevTools. Loopback only: the cdp-inspect
 * discovery refuses any other host, and nothing outside the pod may reach it.
 */
export const DESKTOP_CDP_HOST = "127.0.0.1";
export const DESKTOP_CDP_PORT = 9222;

/** Whether the live view is on for this daemon. */
export function isLiveViewEnabled(
  config?: AssistantConfig,
  containerized: boolean = getIsContainerized(),
): boolean {
  try {
    const resolved = config ?? getConfig();
    return (
      isAssistantDesktopEnabled(resolved, containerized) &&
      isAssistantFeatureFlagEnabled(AEXY_LIVE_VIEW_FLAG, resolved)
    );
  } catch (err) {
    // A config that cannot be read right now is not a reason to change
    // which browser the agent drives mid-turn; fail to upstream behaviour.
    log.warn({ err }, "Failed to read config for the live view gate");
    return false;
  }
}
