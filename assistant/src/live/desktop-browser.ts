/**
 * The agent's browser is the desktop's Chrome (plan D1).
 *
 * Upstream's browser tool launches its own headless Chromium beside the
 * desktop, so a person streaming the desktop watches an empty Chrome while
 * the agent works invisibly next to it. With the live view on, the tool
 * attaches to the desktop Chrome over DevTools instead (the existing
 * `cdp-inspect` backend), and this is what makes sure there is one to attach
 * to: the desktop is started the first time the tool needs it, and the tool
 * waits until Chrome is answering on its loopback DevTools port.
 *
 * Starting it is not keeping it. A one-off browser call arms the desktop's
 * ordinary linger; a workspace-task claim holds it for the claim's life (see
 * {@link holdDesktopForClaim}) so the page the agent left is still there when
 * someone opens the watch view between two steps.
 */

import { desktopDependencyInstaller } from "../desktop/desktop-dependencies.js";
import {
  type DesktopSessionManager,
  getDesktopSessionManager,
} from "../desktop/desktop-session-manager.js";
import { getLogger } from "../util/logger.js";
import { sleep } from "../util/retry.js";
import { DESKTOP_CDP_HOST, DESKTOP_CDP_PORT } from "./live-view-feature.js";

const log = getLogger("live-desktop-browser");

/** How long Chrome may take to open its DevTools port after the X server. */
const CDP_READY_DEADLINE_MS = 30_000;
const CDP_PROBE_INTERVAL_MS = 150;

export interface DesktopBrowserDeps {
  readonly manager?: Pick<
    DesktopSessionManager,
    "ensureDesktopRunning" | "touch" | "hold" | "release"
  >;
  readonly ensureInstalled?: () => Promise<void>;
  /** Whether DevTools answers on the desktop Chrome's port. */
  readonly probeCdp?: () => Promise<boolean>;
  readonly readyDeadlineMs?: number;
}

export class DesktopBrowserUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DesktopBrowserUnavailableError";
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Make sure the desktop and its Chrome are up and DevTools answers. Concurrent
 * callers share one attempt. Rejects with {@link DesktopBrowserUnavailableError}
 * when the desktop cannot be started or Chrome never opens its port.
 */
export function ensureDesktopBrowserForAgent(
  deps: DesktopBrowserDeps = {},
): Promise<void> {
  inFlight ??= startDesktopBrowser(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function startDesktopBrowser(deps: DesktopBrowserDeps): Promise<void> {
  const manager = deps.manager ?? getDesktopSessionManager();
  const ensureInstalled =
    deps.ensureInstalled ?? (() => desktopDependencyInstaller.ensureReady());
  const probe = deps.probeCdp ?? probeDesktopCdp;
  try {
    // Baked into the image, this is a readiness check; otherwise it is the
    // same shared install the desktop modal runs.
    await ensureInstalled();
    // Also relaunches a Chrome that was closed, when the tree is up.
    await manager.ensureDesktopRunning();
  } catch (err) {
    throw new DesktopBrowserUnavailableError(
      "The desktop browser could not be started",
      err,
    );
  }
  // Nothing may be holding the desktop (no claim, no viewer); without this
  // it would run until the next viewer came and went.
  manager.touch();

  // A loopback probe costs a millisecond, and a Chrome that was just
  // relaunched is not listening yet, so it is asked every time.
  const deadline = Date.now() + (deps.readyDeadlineMs ?? CDP_READY_DEADLINE_MS);
  for (;;) {
    if (await probe()) {
      return;
    }
    if (Date.now() >= deadline) {
      log.warn(
        { port: DESKTOP_CDP_PORT },
        "Desktop Chrome did not open its DevTools port in time",
      );
      throw new DesktopBrowserUnavailableError(
        `The desktop browser did not answer on DevTools port ${DESKTOP_CDP_PORT}`,
      );
    }
    await sleep(CDP_PROBE_INTERVAL_MS);
  }
}

/** Keep the desktop up for as long as a workspace-task claim is open. */
export function holdDesktopForClaim(
  claimId: string,
  deps: Pick<DesktopBrowserDeps, "manager"> = {},
): () => void {
  const manager = deps.manager ?? getDesktopSessionManager();
  const key = `workspace-task:${claimId}`;
  manager.hold(key);
  return () => manager.release(key);
}

async function probeDesktopCdp(): Promise<boolean> {
  try {
    const res = await fetch(
      `http://${DESKTOP_CDP_HOST}:${DESKTOP_CDP_PORT}/json/version`,
      { signal: AbortSignal.timeout(1_000) },
    );
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/** @internal Test helper. */
export function _resetDesktopBrowserForTests(): void {
  inFlight = null;
}
