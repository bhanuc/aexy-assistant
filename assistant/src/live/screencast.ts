/**
 * JPEG frames of the page the agent is on, for the watch stream (plan D2).
 *
 * CDP `Page.startScreencast` on the agent's current tab, over a DevTools
 * connection of our own: the agent's cdp-inspect sessions come and go per
 * tool call, and a watcher's picture must not depend on either. Chrome only
 * paints a frame when the page changes and sends the next one only after the
 * last is acknowledged, so the ack is the rate limit — delaying it caps the
 * stream at the viewers' requested fps and an idle page costs nothing.
 *
 * It runs only while someone is watching; the hub starts and stops it.
 */

import {
  type DevToolsTarget,
  listDevToolsTargets,
} from "../tools/browser/cdp-client/cdp-inspect/discovery.js";
import {
  type CdpWsTransport,
  connectCdpWsTransport,
} from "../tools/browser/cdp-client/cdp-inspect/ws-transport.js";
import { getLogger } from "../util/logger.js";
import {
  type AgentBrowserTarget,
  getAgentBrowserTarget,
  onAgentBrowserTargetChange,
} from "./agent-browser-target.js";
import { DESKTOP_CDP_HOST, DESKTOP_CDP_PORT } from "./live-view-feature.js";

const log = getLogger("live-screencast");

/** C2: `format:"jpeg"`, `quality:60`, `maxWidth:1280`, `maxHeight:800`. */
export const SCREENCAST_PARAMS = {
  format: "jpeg",
  quality: 60,
  maxWidth: 1280,
  maxHeight: 800,
} as const;

export const DEFAULT_MAX_FPS = 4;
/** How often the target list is re-read for url/title and a closed tab. */
const TARGET_POLL_MS = 2_000;

export interface ScreencastFrame {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly title: string;
  /** ISO time Chrome painted it (or we received it, when Chrome omits it). */
  readonly ts: string;
}

/** The slice of a DevTools page connection this module drives. */
export type ScreencastConnection = Pick<
  CdpWsTransport,
  "send" | "addEventListener" | "dispose"
>;

export interface ScreencasterDeps {
  readonly listTargets?: () => Promise<DevToolsTarget[]>;
  readonly connect?: (wsUrl: string) => Promise<ScreencastConnection>;
  readonly agentTarget?: () => AgentBrowserTarget | null;
  readonly onAgentTargetChange?: (listener: () => void) => () => void;
  readonly pollMs?: number;
  readonly now?: () => number;
}

export interface ScreencasterEvents {
  onFrame(frame: ScreencastFrame): void;
  /** The agent has no page open to show; said once per absence. */
  onNoTarget(): void;
}

interface Attached {
  readonly target: DevToolsTarget;
  readonly connection: ScreencastConnection;
  readonly unsubscribe: () => void;
}

export class DesktopScreencaster {
  private running = false;
  private attached: Attached | null = null;
  private attaching: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unwatchAgent: (() => void) | null = null;
  private maxFps = DEFAULT_MAX_FPS;
  private lastAckAt = 0;
  private url = "";
  private title = "";
  private noTargetReported = false;

  private readonly listTargets: () => Promise<DevToolsTarget[]>;
  private readonly connect: (wsUrl: string) => Promise<ScreencastConnection>;
  private readonly agentTarget: () => AgentBrowserTarget | null;
  private readonly watchAgentTarget: (listener: () => void) => () => void;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(
    private readonly events: ScreencasterEvents,
    deps: ScreencasterDeps = {},
  ) {
    this.listTargets =
      deps.listTargets ??
      (() =>
        listDevToolsTargets({
          host: DESKTOP_CDP_HOST,
          port: DESKTOP_CDP_PORT,
          timeoutMs: 1_000,
        }));
    this.connect =
      deps.connect ??
      ((wsUrl) => connectCdpWsTransport(wsUrl, { connectTimeoutMs: 3_000 }));
    this.agentTarget = deps.agentTarget ?? getAgentBrowserTarget;
    this.watchAgentTarget =
      deps.onAgentTargetChange ??
      ((listener) => onAgentBrowserTargetChange(() => listener()));
    this.pollMs = deps.pollMs ?? TARGET_POLL_MS;
    this.now = deps.now ?? Date.now;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The page currently being cast, for the snapshot headers. */
  get currentPage(): { url: string; title: string } | null {
    return this.attached ? { url: this.url, title: this.title } : null;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.noTargetReported = false;
    this.unwatchAgent = this.watchAgentTarget(() => {
      // The agent moved to another tab: follow it.
      void this.refresh(true);
    });
    this.pollTimer = setInterval(() => void this.refresh(false), this.pollMs);
    this.pollTimer.unref?.();
    void this.refresh(false);
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.unwatchAgent?.();
    this.unwatchAgent = null;
    this.detach();
  }

  setMaxFps(fps: number): void {
    this.maxFps = Math.min(10, Math.max(1, Math.round(fps)));
  }

  /**
   * A still of the page the agent is on, for the hand-back message. Uses the
   * cast's connection when there is one, otherwise a short-lived one.
   */
  async captureScreenshot(): Promise<Uint8Array | null> {
    try {
      const target = await this.pickTarget();
      if (!target) {
        return null;
      }
      const reuse = this.attached?.target.id === target.id;
      const connection = reuse
        ? this.attached!.connection
        : await this.connect(target.webSocketDebuggerUrl);
      try {
        const shot = await connection.send<{ data?: string }>(
          "Page.captureScreenshot",
          { format: "jpeg", quality: 70 },
        );
        return shot?.data ? Buffer.from(shot.data, "base64") : null;
      } finally {
        if (!reuse) {
          connection.dispose();
        }
      }
    } catch (err) {
      log.debug({ err }, "Could not capture a screenshot of the agent's page");
      return null;
    }
  }

  /**
   * Keep the cast on the right page. `force` reattaches even when the current
   * target still exists, for when the agent itself has moved.
   */
  private async refresh(force: boolean): Promise<void> {
    if (!this.running) {
      return;
    }
    if (this.attaching) {
      // One reconcile at a time. A poll that finds one running has nothing to
      // add; a forced one runs again once it lands, since the agent moved
      // after it started.
      if (!force) {
        return;
      }
      while (this.attaching) {
        await this.attaching;
      }
      if (!this.running) {
        return;
      }
    }
    this.attaching = this.reconcile().finally(() => {
      this.attaching = null;
    });
    await this.attaching;
  }

  private async reconcile(): Promise<void> {
    let targets: DevToolsTarget[];
    try {
      targets = await this.listTargets();
    } catch {
      // Chrome is not up (yet, or any more): nothing to show.
      targets = [];
    }
    if (!this.running) {
      return;
    }
    const target = choosePage(targets, this.agentTarget());
    if (!target) {
      this.detach();
      if (!this.noTargetReported) {
        this.noTargetReported = true;
        this.events.onNoTarget();
      }
      return;
    }
    this.noTargetReported = false;
    this.url = target.url;
    this.title = target.title;
    if (this.attached?.target.id === target.id) {
      return;
    }
    this.detach();
    await this.attach(target);
  }

  private async pickTarget(): Promise<DevToolsTarget | null> {
    try {
      return choosePage(await this.listTargets(), this.agentTarget());
    } catch {
      return null;
    }
  }

  private async attach(target: DevToolsTarget): Promise<void> {
    let connection: ScreencastConnection;
    try {
      connection = await this.connect(target.webSocketDebuggerUrl);
    } catch (err) {
      log.debug({ err, targetId: target.id }, "Screencast connect failed");
      return;
    }
    if (!this.running) {
      connection.dispose();
      return;
    }
    const unsubscribe = connection.addEventListener((event) => {
      if (event.method === "Page.screencastFrame") {
        this.onFrame(connection, event.params);
      }
    });
    this.attached = { target, connection, unsubscribe };
    try {
      await connection.send("Page.startScreencast", {
        ...SCREENCAST_PARAMS,
        everyNthFrame: 1,
      });
      log.debug({ targetId: target.id }, "Screencast started");
    } catch (err) {
      log.debug({ err, targetId: target.id }, "Screencast start failed");
      this.detach();
    }
  }

  private detach(): void {
    const attached = this.attached;
    this.attached = null;
    if (!attached) {
      return;
    }
    attached.unsubscribe();
    void attached.connection.send("Page.stopScreencast").catch(() => {});
    attached.connection.dispose();
  }

  private onFrame(connection: ScreencastConnection, params: unknown): void {
    const frame = params as {
      data?: string;
      sessionId?: number;
      metadata?: {
        deviceWidth?: number;
        deviceHeight?: number;
        timestamp?: number;
      };
    };
    if (typeof frame?.data !== "string" || frame.sessionId === undefined) {
      return;
    }
    const sessionId = frame.sessionId;
    // Acknowledge no sooner than the fps cap allows: Chrome holds the next
    // frame until then, which is the whole rate limit.
    const interval = 1000 / this.maxFps;
    const wait = Math.max(0, this.lastAckAt + interval - this.now());
    const ack = () => {
      this.lastAckAt = this.now();
      if (this.attached?.connection !== connection) {
        return;
      }
      void connection
        .send("Page.screencastFrameAck", { sessionId })
        .catch(() => {
          if (this.attached?.connection === connection) {
            // The page went away under the cast; find the next one.
            this.detach();
            void this.refresh(false);
          }
        });
    };
    if (wait > 0) {
      setTimeout(ack, wait);
    } else {
      ack();
    }

    const meta = frame.metadata ?? {};
    const jpeg = Buffer.from(frame.data, "base64");
    // The picture's own size, which maxWidth/maxHeight scaled; the metadata
    // carries the page's CSS viewport, which is not what a viewer draws.
    const size = jpegSize(jpeg);
    this.events.onFrame({
      jpeg,
      width: size?.w ?? Math.round(meta.deviceWidth ?? 0),
      height: size?.h ?? Math.round(meta.deviceHeight ?? 0),
      url: this.url,
      title: this.title,
      ts: new Date(
        typeof meta.timestamp === "number" ? meta.timestamp * 1000 : this.now(),
      ).toISOString(),
    });
  }
}

/**
 * The page to show: the one the agent last attached to while it still exists,
 * otherwise the first ordinary page Chrome lists.
 */
export function choosePage(
  targets: readonly DevToolsTarget[],
  agent: AgentBrowserTarget | null,
): DevToolsTarget | null {
  const pages = targets.filter((t) => t.type === "page");
  if (agent) {
    const current = pages.find((t) => t.id === agent.id);
    if (current) {
      return current;
    }
  }
  return (
    pages.find((t) => !t.url.startsWith("devtools://")) ?? pages[0] ?? null
  );
}

/** Frame dimensions from a JPEG's start-of-frame marker. */
export function jpegSize(jpeg: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      return null;
    }
    const marker = jpeg[i + 1]!;
    const length = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        h: (jpeg[i + 5]! << 8) | jpeg[i + 6]!,
        w: (jpeg[i + 7]! << 8) | jpeg[i + 8]!,
      };
    }
    i += 2 + length;
  }
  return null;
}
