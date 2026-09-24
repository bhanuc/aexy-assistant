/**
 * `/v1/watch/stream` for the Aexy live view (contract C2): many people
 * watching one agent, on one socket each, carrying the agent's own event
 * timeline and JPEG frames of the page it is on.
 *
 * **Who is watching comes from the gateway, not the client.** The tunnel
 * attests the person and the gateway forwards it as `x-vellum-viewer-*`
 * headers on its own service-token dial (C1.4); nothing a browser sends can
 * set them. The role decides what a viewer is sent — full thinking only for
 * `owner|manager|admin` — and the scope whether they get pictures at all
 * (`chat` gets events only).
 *
 * **One event subscription and one screencast, however many viewers.** The
 * hub subscribes to the daemon's event hub once, as a process subscriber, and
 * fans each event out; the screencast runs only while at least one
 * frame-receiving viewer is connected. A viewer whose socket is backed up
 * skips frames instead of queueing them: it keeps only the newest and gets it
 * when the socket drains, so a slow phone never delays anyone else or grows a
 * backlog in the pod.
 *
 * **Watching keeps the pod awake.** While anyone is connected the platform's
 * record-activity is called (throttled to 30 s) so the idle sleeper does not
 * take the pod away under them.
 */

import type { AssistantEventEnvelope } from "../api/index.js";
import {
  type DesktopState,
  getDesktopSessionManager,
} from "../desktop/desktop-session-manager.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { onActiveTaskChange } from "../workspace-tasks/active-task.js";
import {
  getLiveControlSnapshot,
  type LiveControlSnapshot,
  onLiveControlChange,
} from "./control-state.js";
import { recordWatchActivity } from "./platform-activity.js";
import {
  DEFAULT_MAX_FPS,
  DesktopScreencaster,
  type ScreencasterEvents,
  type ScreencastFrame,
} from "./screencast.js";
import { resolveWatchFollowTarget } from "./watch-target.js";

const log = getLogger("live-watch");

export const WATCH_PROTOCOL = 1;

/** C2 close codes (the error-frame ones are sent as `error`, not a close). */
export const WATCH_CLOSE = {
  forbidden: 4003,
  disabled: 4008,
  noBrowser: 4010,
} as const;

/** Past this many unsent bytes a viewer is "backed up" and skips frames. */
const FRAME_BACKLOG_BYTES = 256 * 1024;
const ACTIVITY_INTERVAL_MS = 30_000;
/** Matches the desktop's X geometry (`desktop-session-manager.ts`). */
const DESKTOP_WIDTH = 1440;
const DESKTOP_HEIGHT = 900;
const DESKTOP_HOLD_KEY = "watch-viewers";

export type ViewerRole = "owner" | "manager" | "admin" | "member";
export type StreamScope = "watch" | "control" | "chat";

const ROLES: ReadonlySet<string> = new Set([
  "owner",
  "manager",
  "admin",
  "member",
]);
const SCOPES: ReadonlySet<string> = new Set(["watch", "control", "chat"]);
const THINKING_ROLES: ReadonlySet<ViewerRole> = new Set([
  "owner",
  "manager",
  "admin",
]);

/** The person on the other end of one socket, as the gateway attested them. */
export interface WatchViewer {
  /** Platform user id (`x-velay-user-id`). */
  readonly id: string;
  readonly role: ViewerRole;
  readonly scope: StreamScope;
  readonly name: string;
  readonly liveSessionId: string | null;
  readonly aexyDeveloperId: string | null;
  /** The token's conversation, when it named one. */
  readonly conversationId: string | null;
}

/**
 * Read the C1.4 viewer headers. `null` when they are absent or malformed —
 * the caller closes with 4003 rather than guessing a role.
 */
export function parseWatchViewer(
  get: (name: string) => string | null | undefined,
): WatchViewer | null {
  const id = get("x-vellum-viewer-id")?.trim();
  const role = get("x-vellum-viewer-role")?.trim();
  const scope = get("x-vellum-stream-scope")?.trim();
  if (!id || !role || !ROLES.has(role) || !scope || !SCOPES.has(scope)) {
    return null;
  }
  const conversationId = get("x-vellum-conversation-id")?.trim() || null;
  if (scope === "chat" && !conversationId) {
    return null;
  }
  return {
    id,
    role: role as ViewerRole,
    scope: scope as StreamScope,
    name: decodeDisplayName(get("x-vellum-display-name")) ?? id,
    liveSessionId: get("x-vellum-live-session-id")?.trim() || null,
    aexyDeveloperId: get("x-vellum-aexy-developer-id")?.trim() || null,
    conversationId,
  };
}

function decodeDisplayName(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    return decodeURIComponent(raw).trim() || null;
  } catch {
    return raw.trim() || null;
  }
}

/** The slice of Bun's `ServerWebSocket` the hub drives, so tests can fake it. */
export interface WatchSocket {
  /** Bytes accepted, `-1` when queued under backpressure, `0` when dropped. */
  send(data: string | Uint8Array): number;
  getBufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

export class WatchConnection {
  private seq = 0;
  /** The newest frame this viewer has not been sent, when backed up. */
  pendingFrame: ScreencastFrame | null = null;
  maxFps = DEFAULT_MAX_FPS;
  closed = false;

  constructor(
    readonly socket: WatchSocket,
    readonly viewer: WatchViewer,
    /** What this viewer's events are filtered to; `null` for none yet. */
    public conversationId: string | null,
    /** False when the token fixed the conversation. */
    readonly follows: boolean,
  ) {}

  get receivesFrames(): boolean {
    return this.viewer.scope !== "chat";
  }

  get seesThinking(): boolean {
    return THINKING_ROLES.has(this.viewer.role);
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  sendJson(message: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }
}

type Screencaster = Pick<
  DesktopScreencaster,
  "start" | "stop" | "setMaxFps" | "isRunning" | "captureScreenshot"
>;

export interface WatchHubDeps {
  readonly subscribeEvents?: (
    callback: (event: AssistantEventEnvelope) => void,
  ) => { dispose(): void };
  readonly createScreencaster?: (events: ScreencasterEvents) => Screencaster;
  /** The conversation a viewer without one on its token follows. */
  readonly followConversation?: () => string | null;
  readonly desktopState?: () => DesktopState;
  readonly holdDesktop?: (key: string) => void;
  readonly releaseDesktop?: (key: string) => void;
  readonly controlSnapshot?: () => LiveControlSnapshot;
  readonly onControlChange?: (
    listener: (snapshot: LiveControlSnapshot) => void,
  ) => () => void;
  readonly recordActivity?: () => Promise<void>;
  readonly activityIntervalMs?: number;
  readonly frameBacklogBytes?: number;
}

export class LiveWatchHub {
  private readonly connections = new Set<WatchConnection>();
  private subscription: { dispose(): void } | null = null;
  private screencaster: Screencaster | null = null;
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private unwatchControl: (() => void) | null = null;
  private lastFrame: ScreencastFrame | null = null;
  private browserMissing = false;

  private readonly subscribeEvents: NonNullable<
    WatchHubDeps["subscribeEvents"]
  >;
  private readonly createScreencaster: NonNullable<
    WatchHubDeps["createScreencaster"]
  >;
  private readonly followConversation: () => string | null;
  private readonly desktopState: () => DesktopState;
  private readonly holdDesktop: (key: string) => void;
  private readonly releaseDesktop: (key: string) => void;
  private readonly controlSnapshot: () => LiveControlSnapshot;
  private readonly onControlChange: NonNullable<
    WatchHubDeps["onControlChange"]
  >;
  private readonly recordActivity: () => Promise<void>;
  private readonly activityIntervalMs: number;
  private readonly frameBacklogBytes: number;

  constructor(deps: WatchHubDeps = {}) {
    this.subscribeEvents =
      deps.subscribeEvents ??
      ((callback) =>
        assistantEventHub.subscribe({ type: "process", callback }));
    this.createScreencaster =
      deps.createScreencaster ?? ((events) => new DesktopScreencaster(events));
    this.followConversation = deps.followConversation ?? (() => null);
    this.desktopState =
      deps.desktopState ?? (() => getDesktopSessionManager().getState());
    this.holdDesktop =
      deps.holdDesktop ?? ((key) => getDesktopSessionManager().hold(key));
    this.releaseDesktop =
      deps.releaseDesktop ?? ((key) => getDesktopSessionManager().release(key));
    this.controlSnapshot = deps.controlSnapshot ?? getLiveControlSnapshot;
    this.onControlChange = deps.onControlChange ?? onLiveControlChange;
    this.recordActivity = deps.recordActivity ?? (() => recordWatchActivity());
    this.activityIntervalMs = deps.activityIntervalMs ?? ACTIVITY_INTERVAL_MS;
    this.frameBacklogBytes = deps.frameBacklogBytes ?? FRAME_BACKLOG_BYTES;
  }

  get viewerCount(): number {
    return this.connections.size;
  }

  /** The newest frame any viewer was offered, for `/v1/watch/snapshot`. */
  getLastFrame(): ScreencastFrame | null {
    return this.lastFrame;
  }

  /** A fresh still of the agent's page, for the hand-back message. */
  async captureScreenshot(): Promise<Uint8Array | null> {
    const caster =
      this.screencaster ??
      this.createScreencaster({ onFrame: () => {}, onNoTarget: () => {} });
    return caster.captureScreenshot();
  }

  /**
   * Admit one socket. `requestedConversationId` is the `conversationId`
   * query parameter, which is honoured only when it matches a chat token's.
   */
  connect(
    socket: WatchSocket,
    viewer: WatchViewer,
    requestedConversationId?: string | null,
  ): WatchConnection {
    let conversationId: string | null;
    let follows: boolean;
    if (viewer.scope === "chat") {
      // A chat viewer sees its own thread and nothing else. The query can
      // only restate the token, never widen it.
      conversationId = viewer.conversationId;
      follows = false;
      if (
        requestedConversationId &&
        requestedConversationId !== viewer.conversationId
      ) {
        log.info(
          { viewer: viewer.id },
          "Ignoring a watch conversationId that differs from the chat token's",
        );
      }
    } else if (viewer.conversationId) {
      conversationId = viewer.conversationId;
      follows = false;
    } else {
      conversationId = this.followConversation();
      follows = true;
    }
    const conn = new WatchConnection(socket, viewer, conversationId, follows);
    const first = this.connections.size === 0;
    this.connections.add(conn);
    if (first) {
      this.start();
    }
    this.sendHello(conn);
    if (conn.receivesFrames) {
      this.ensureScreencast();
      if (this.lastFrame) {
        this.offerFrame(conn, this.lastFrame);
      } else if (this.browserMissing) {
        this.sendNoBrowser(conn);
      }
    }
    this.broadcastPresence();
    log.info(
      {
        viewer: viewer.id,
        role: viewer.role,
        scope: viewer.scope,
        conversationId,
        viewers: this.connections.size,
      },
      "Watch viewer connected",
    );
    return conn;
  }

  disconnect(conn: WatchConnection): void {
    if (!this.connections.delete(conn)) {
      return;
    }
    conn.closed = true;
    conn.pendingFrame = null;
    if (!this.hasFrameViewers()) {
      this.screencaster?.stop();
    } else {
      this.applyFps();
    }
    if (this.connections.size === 0) {
      this.stop();
    }
    this.broadcastPresence();
    log.info(
      { viewer: conn.viewer.id, viewers: this.connections.size },
      "Watch viewer disconnected",
    );
  }

  handleMessage(conn: WatchConnection, raw: string | Uint8Array): void {
    if (typeof raw !== "string") {
      return;
    }
    let message: { type?: unknown; maxFps?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      conn.sendJson({
        type: "error",
        code: "bad_message",
        message: "Frames must be JSON",
      });
      return;
    }
    if (message.type === "ping") {
      conn.sendJson({ type: "pong" });
      return;
    }
    if (message.type === "quality") {
      const fps = Number(message.maxFps);
      if (!Number.isFinite(fps)) {
        return;
      }
      conn.maxFps = Math.min(10, Math.max(1, Math.round(fps)));
      this.applyFps();
      return;
    }
    // Control goes through Aexy (C4), never this socket.
    conn.sendJson({
      type: "error",
      code: "unsupported",
      message: "This socket accepts ping and quality only",
    });
  }

  /** The socket drained: hand it the newest frame it skipped, if any. */
  handleDrain(conn: WatchConnection): void {
    const pending = conn.pendingFrame;
    if (pending && !conn.closed) {
      conn.pendingFrame = null;
      this.offerFrame(conn, pending);
    }
  }

  /**
   * The conversation followers watch may have changed (a claim started a
   * turn). Followers that move are sent a fresh `hello` naming it.
   */
  refreshFollowTarget(): void {
    if (this.connections.size === 0) {
      return;
    }
    const target = this.followConversation();
    for (const conn of this.connections) {
      if (conn.follows && conn.conversationId !== target) {
        conn.conversationId = target;
        this.sendHello(conn);
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  private start(): void {
    this.subscription = this.subscribeEvents((event) => this.onEvent(event));
    this.unwatchControl = this.onControlChange((snapshot) =>
      this.broadcastControl(snapshot),
    );
    try {
      this.holdDesktop(DESKTOP_HOLD_KEY);
    } catch (err) {
      log.debug({ err }, "Could not hold the desktop for watchers");
    }
    void this.recordActivity();
    this.activityTimer = setInterval(
      () => void this.recordActivity(),
      this.activityIntervalMs,
    );
    this.activityTimer.unref?.();
  }

  private stop(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.unwatchControl?.();
    this.unwatchControl = null;
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
    this.screencaster?.stop();
    try {
      this.releaseDesktop(DESKTOP_HOLD_KEY);
    } catch (err) {
      log.debug({ err }, "Could not release the watchers' desktop hold");
    }
  }

  private ensureScreencast(): void {
    this.screencaster ??= this.createScreencaster({
      onFrame: (frame) => this.onFrame(frame),
      onNoTarget: () => this.onNoTarget(),
    });
    this.applyFps();
    if (!this.screencaster.isRunning) {
      this.screencaster.start();
    }
  }

  private applyFps(): void {
    let fps = 0;
    for (const conn of this.connections) {
      if (conn.receivesFrames) {
        fps = Math.max(fps, conn.maxFps);
      }
    }
    this.screencaster?.setMaxFps(fps || DEFAULT_MAX_FPS);
  }

  private hasFrameViewers(): boolean {
    for (const conn of this.connections) {
      if (conn.receivesFrames) {
        return true;
      }
    }
    return false;
  }

  private onEvent(envelope: AssistantEventEnvelope): void {
    const message = envelope.message as { type?: string } & Record<
      string,
      unknown
    >;
    const conversationId =
      envelope.conversationId ??
      (typeof message.conversationId === "string"
        ? message.conversationId
        : undefined);
    if (!conversationId) {
      // Unscoped broadcasts (sync invalidations, settings) are not the run.
      return;
    }
    const isThinking = message.type === "assistant_thinking_delta";
    let stripped: Record<string, unknown> | null = null;
    for (const conn of this.connections) {
      if (conn.conversationId !== conversationId) {
        continue;
      }
      if (isThinking && !conn.seesThinking) {
        continue;
      }
      stripped ??= stripImages(message);
      conn.sendJson({
        type: "event",
        seq: conn.nextSeq(),
        emittedAt: envelope.emittedAt,
        conversationId,
        event: stripped,
      });
    }
  }

  private onFrame(frame: ScreencastFrame): void {
    this.lastFrame = frame;
    this.browserMissing = false;
    for (const conn of this.connections) {
      if (conn.receivesFrames) {
        this.offerFrame(conn, frame);
      }
    }
  }

  private onNoTarget(): void {
    this.browserMissing = true;
    for (const conn of this.connections) {
      if (conn.receivesFrames) {
        this.sendNoBrowser(conn);
      }
    }
  }

  private sendNoBrowser(conn: WatchConnection): void {
    conn.sendJson({
      type: "error",
      code: String(WATCH_CLOSE.noBrowser),
      message: "The agent has no browser open",
    });
  }

  /** Latest-frame-wins: a backed-up viewer keeps only the newest. */
  private offerFrame(conn: WatchConnection, frame: ScreencastFrame): void {
    if (conn.closed) {
      return;
    }
    if (conn.socket.getBufferedAmount() > this.frameBacklogBytes) {
      conn.pendingFrame = frame;
      return;
    }
    conn.pendingFrame = null;
    conn.sendJson({
      type: "frame",
      seq: conn.nextSeq(),
      ts: frame.ts,
      width: frame.width,
      height: frame.height,
      url: frame.url,
      title: frame.title,
    });
    conn.socket.send(frame.jpeg);
  }

  private sendHello(conn: WatchConnection): void {
    const control = this.controlSnapshot();
    conn.sendJson({
      type: "hello",
      protocol: WATCH_PROTOCOL,
      viewer: {
        id: conn.viewer.id,
        role: conn.viewer.role,
        scope: conn.viewer.scope,
        liveSessionId: conn.viewer.liveSessionId,
      },
      conversationId: conn.conversationId,
      desktop: {
        state: this.desktopState(),
        width: DESKTOP_WIDTH,
        height: DESKTOP_HEIGHT,
      },
      control: {
        paused: control.paused,
        pausedBy: control.pausedBy,
        holder: control.holder,
      },
    });
  }

  private broadcastPresence(): void {
    const viewers = [...this.connections].map((c) => ({
      id: c.viewer.id,
      name: c.viewer.name,
      role: c.viewer.role,
      scope: c.viewer.scope,
    }));
    for (const conn of this.connections) {
      conn.sendJson({ type: "presence", viewers });
    }
  }

  private broadcastControl(snapshot: LiveControlSnapshot): void {
    const message = controlStateMessage(snapshot);
    for (const conn of this.connections) {
      conn.sendJson(message);
    }
  }
}

export function controlStateMessage(
  snapshot: LiveControlSnapshot,
): Record<string, unknown> {
  return {
    type: "control_state",
    paused: snapshot.paused,
    pausedBy: snapshot.pausedBy,
    holder: snapshot.holder,
    takeover: snapshot.takeover,
  };
}

/** Frames carry the picture; a tool result's screenshot would double it. */
function stripImages(
  message: Record<string, unknown>,
): Record<string, unknown> {
  if (
    message.type !== "tool_result" ||
    (!("imageData" in message) && !("imageDataList" in message))
  ) {
    return message;
  }
  const {
    imageData: _imageData,
    imageDataList: _imageDataList,
    ...rest
  } = message;
  return rest;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let sharedHub: LiveWatchHub | null = null;

export function getLiveWatchHub(): LiveWatchHub {
  if (!sharedHub) {
    const hub = new LiveWatchHub({
      followConversation: resolveWatchFollowTarget,
    });
    // A claim that starts its turn while people watch moves them onto it.
    onActiveTaskChange(() => hub.refreshFollowTarget());
    sharedHub = hub;
  }
  return sharedHub;
}

/** @internal Test helper. */
export function _resetLiveWatchHubForTests(): void {
  sharedHub = null;
}
