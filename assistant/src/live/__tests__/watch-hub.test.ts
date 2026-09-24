/**
 * The watch stream's promises (C2): who sees what, one screencast however
 * many watchers, and a slow viewer that skips frames rather than queueing
 * them.
 */

import { describe, expect, test } from "bun:test";

import type { AssistantEventEnvelope } from "../../api/index.js";
import type { LiveControlSnapshot } from "../control-state.js";
import type { ScreencasterEvents, ScreencastFrame } from "../screencast.js";
import {
  LiveWatchHub,
  parseWatchViewer,
  type WatchSocket,
  type WatchViewer,
} from "../watch-hub.js";

class FakeSocket implements WatchSocket {
  readonly text: Record<string, unknown>[] = [];
  readonly binary: Uint8Array[] = [];
  /** Every frame in order, text parsed, binary as a marker. */
  readonly all: unknown[] = [];
  buffered = 0;
  closed: { code?: number; reason?: string } | null = null;

  send(data: string | Uint8Array): number {
    if (typeof data === "string") {
      const parsed = JSON.parse(data);
      this.text.push(parsed);
      this.all.push(parsed);
    } else {
      this.binary.push(data);
      this.all.push({ binary: data.byteLength });
    }
    return 1;
  }
  getBufferedAmount(): number {
    return this.buffered;
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  ofType(type: string): Record<string, unknown>[] {
    return this.text.filter((m) => m.type === type);
  }
}

function viewer(overrides: Partial<WatchViewer> = {}): WatchViewer {
  return {
    id: "user-1",
    role: "member",
    scope: "watch",
    name: "Priya Shah",
    liveSessionId: "live-1",
    aexyDeveloperId: "dev-1",
    conversationId: null,
    ...overrides,
  };
}

function frame(n: number): ScreencastFrame {
  return {
    jpeg: new Uint8Array(n),
    width: 1280,
    height: 800,
    url: "https://venues.example/checkout",
    title: "Checkout",
    ts: new Date(1_700_000_000_000 + n).toISOString(),
  };
}

function envelope(
  message: Record<string, unknown>,
  conversationId?: string,
): AssistantEventEnvelope {
  return {
    id: crypto.randomUUID(),
    conversationId,
    emittedAt: "2026-09-24T10:00:00.000Z",
    message,
  } as unknown as AssistantEventEnvelope;
}

function setup(options: { follow?: string | null } = {}) {
  let publish: ((event: AssistantEventEnvelope) => void) | null = null;
  let subscriptions = 0;
  let disposed = 0;
  let casterEvents: ScreencasterEvents | null = null;
  const caster = {
    running: false,
    starts: 0,
    stops: 0,
    fps: 0,
    get isRunning() {
      return this.running;
    },
    start() {
      this.running = true;
      this.starts += 1;
    },
    stop() {
      this.running = false;
      this.stops += 1;
    },
    setMaxFps(fps: number) {
      this.fps = fps;
    },
    captureScreenshot: async () => new Uint8Array([0xff, 0xd8]),
  };
  let control: LiveControlSnapshot = {
    paused: false,
    pausedBy: null,
    holder: null,
    takeover: null,
    conversationId: null,
  };
  let controlListener: ((s: LiveControlSnapshot) => void) | null = null;
  let follow: string | null =
    "follow" in options ? (options.follow ?? null) : "conv-task";
  const holds: string[] = [];
  let activity = 0;
  const hub = new LiveWatchHub({
    subscribeEvents: (callback) => {
      subscriptions += 1;
      publish = callback;
      return {
        dispose: () => {
          disposed += 1;
          publish = null;
        },
      };
    },
    createScreencaster: (events) => {
      casterEvents = events;
      return caster;
    },
    followConversation: () => follow,
    desktopState: () => "ready",
    holdDesktop: (key) => holds.push(`hold:${key}`),
    releaseDesktop: (key) => holds.push(`release:${key}`),
    controlSnapshot: () => control,
    onControlChange: (listener) => {
      controlListener = listener;
      return () => {
        controlListener = null;
      };
    },
    recordActivity: async () => {
      activity += 1;
    },
    activityIntervalMs: 60_000,
    frameBacklogBytes: 1000,
  });
  return {
    hub,
    caster,
    holds,
    publish: (event: AssistantEventEnvelope) => publish?.(event),
    emitFrame: (f: ScreencastFrame) => casterEvents?.onFrame(f),
    emitNoTarget: () => casterEvents?.onNoTarget(),
    setControl: (next: LiveControlSnapshot) => {
      control = next;
      controlListener?.(next);
    },
    setFollow: (id: string | null) => {
      follow = id;
    },
    get subscriptions() {
      return subscriptions;
    },
    get disposed() {
      return disposed;
    },
    get activity() {
      return activity;
    },
  };
}

describe("reading the attested viewer", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name];

  test("takes identity, role and scope from the gateway's headers", () => {
    expect(
      parseWatchViewer(
        headers({
          "x-vellum-viewer-id": "u-1",
          "x-vellum-viewer-role": "manager",
          "x-vellum-stream-scope": "control",
          "x-vellum-live-session-id": "ls-1",
          "x-vellum-aexy-developer-id": "d-1",
          "x-vellum-display-name": encodeURIComponent("Arjun Mehta"),
        }),
      ),
    ).toEqual({
      id: "u-1",
      role: "manager",
      scope: "control",
      name: "Arjun Mehta",
      liveSessionId: "ls-1",
      aexyDeveloperId: "d-1",
      conversationId: null,
    });
  });

  test("refuses a missing or unknown role or scope rather than guessing", () => {
    expect(
      parseWatchViewer(
        headers({
          "x-vellum-viewer-id": "u",
          "x-vellum-stream-scope": "watch",
        }),
      ),
    ).toBeNull();
    expect(
      parseWatchViewer(
        headers({
          "x-vellum-viewer-id": "u",
          "x-vellum-viewer-role": "guardian",
          "x-vellum-stream-scope": "watch",
        }),
      ),
    ).toBeNull();
  });

  test("a chat scope must name its conversation", () => {
    expect(
      parseWatchViewer(
        headers({
          "x-vellum-viewer-id": "u",
          "x-vellum-viewer-role": "member",
          "x-vellum-stream-scope": "chat",
        }),
      ),
    ).toBeNull();
  });
});

describe("the watch hub", () => {
  test("says hello with the followed conversation, the desktop and the control state", () => {
    const h = setup();
    const socket = new FakeSocket();
    h.hub.connect(socket, viewer());
    expect(socket.text[0]).toEqual({
      type: "hello",
      protocol: 1,
      viewer: {
        id: "user-1",
        role: "member",
        scope: "watch",
        liveSessionId: "live-1",
      },
      conversationId: "conv-task",
      desktop: { state: "ready", width: 1440, height: 900 },
      control: { paused: false, pausedBy: null, holder: null },
    });
    expect(socket.ofType("presence")).toEqual([
      {
        type: "presence",
        viewers: [
          { id: "user-1", name: "Priya Shah", role: "member", scope: "watch" },
        ],
      },
    ]);
  });

  test("the token's conversation wins over the followed one", () => {
    const h = setup();
    const socket = new FakeSocket();
    h.hub.connect(socket, viewer({ conversationId: "conv-own" }));
    expect(socket.text[0]!.conversationId).toBe("conv-own");
  });

  test("sends only the watched conversation's events, thinking only to owners, managers and admins", () => {
    const h = setup();
    const member = new FakeSocket();
    const owner = new FakeSocket();
    h.hub.connect(member, viewer());
    h.hub.connect(owner, viewer({ id: "user-2", role: "owner" }));

    h.publish(
      envelope(
        {
          type: "assistant_text_delta",
          text: "Opening",
          conversationId: "conv-task",
        },
        "conv-task",
      ),
    );
    h.publish(
      envelope(
        { type: "assistant_thinking_delta", thinking: "hmm" },
        "conv-task",
      ),
    );
    h.publish(
      envelope({ type: "assistant_text_delta", text: "x" }, "conv-other"),
    );
    h.publish(envelope({ type: "sync_changed", tags: [] }));

    expect(member.ofType("event").map((e) => (e.event as any).type)).toEqual([
      "assistant_text_delta",
    ]);
    expect(owner.ofType("event").map((e) => (e.event as any).type)).toEqual([
      "assistant_text_delta",
      "assistant_thinking_delta",
    ]);
    const first = member.ofType("event")[0]!;
    expect(first).toMatchObject({
      type: "event",
      emittedAt: "2026-09-24T10:00:00.000Z",
      conversationId: "conv-task",
    });
    expect(typeof first.seq).toBe("number");
    // One subscription to the daemon's hub, whatever the viewer count.
    expect(h.subscriptions).toBe(1);
  });

  test("tool results reach viewers without their screenshots", () => {
    const h = setup();
    const socket = new FakeSocket();
    h.hub.connect(socket, viewer());
    h.publish(
      envelope(
        {
          type: "tool_result",
          toolName: "browser_screenshot",
          result: "ok",
          imageData: "AAAA",
          imageDataList: ["BBBB"],
        },
        "conv-task",
      ),
    );
    expect(socket.ofType("event")[0]!.event).toEqual({
      type: "tool_result",
      toolName: "browser_screenshot",
      result: "ok",
    });
  });

  test("a chat viewer gets its thread's events and never frames, and cannot widen its scope", () => {
    const h = setup();
    const socket = new FakeSocket();
    h.hub.connect(
      socket,
      viewer({ scope: "chat", conversationId: "conv-chat" }),
      "conv-task",
    );
    expect(socket.text[0]!.conversationId).toBe("conv-chat");
    expect(h.caster.starts).toBe(0);
    h.emitFrame(frame(10));
    expect(socket.binary).toEqual([]);
    h.publish(
      envelope({ type: "assistant_text_delta", text: "hi" }, "conv-task"),
    );
    expect(socket.ofType("event")).toEqual([]);
  });

  test("runs one screencast while any frame viewer is connected, and stops it after the last", () => {
    const h = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const ca = h.hub.connect(a, viewer());
    const cb = h.hub.connect(b, viewer({ id: "user-2" }));
    expect(h.caster.starts).toBe(1);
    h.hub.disconnect(ca);
    expect(h.caster.stops).toBe(0);
    h.hub.disconnect(cb);
    expect(h.caster.running).toBe(false);
    expect(h.disposed).toBe(1);
    expect(h.holds).toEqual(["hold:watch-viewers", "release:watch-viewers"]);
  });

  test("a frame is a JSON header followed by exactly one binary JPEG", () => {
    const h = setup();
    const socket = new FakeSocket();
    h.hub.connect(socket, viewer());
    h.emitFrame(frame(42));
    const at = socket.all.findIndex((m: any) => m.type === "frame");
    expect(socket.all[at]).toMatchObject({
      type: "frame",
      width: 1280,
      height: 800,
      url: "https://venues.example/checkout",
      title: "Checkout",
    });
    expect(socket.all[at + 1]).toEqual({ binary: 42 });
  });

  test("a backed-up viewer skips to the newest frame and gets it on drain; others are unaffected", () => {
    const h = setup();
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    const slowConn = h.hub.connect(slow, viewer());
    h.hub.connect(fast, viewer({ id: "user-2" }));

    slow.buffered = 5000;
    h.emitFrame(frame(1));
    h.emitFrame(frame(2));
    h.emitFrame(frame(3));
    expect(slow.binary).toEqual([]);
    expect(fast.binary.map((b) => b.byteLength)).toEqual([1, 2, 3]);

    slow.buffered = 0;
    h.hub.handleDrain(slowConn);
    expect(slow.binary.map((b) => b.byteLength)).toEqual([3]);
    // Nothing left over to send twice.
    h.hub.handleDrain(slowConn);
    expect(slow.binary).toHaveLength(1);
  });

  test("a new viewer is sent the last frame at once", () => {
    const h = setup();
    h.hub.connect(new FakeSocket(), viewer());
    h.emitFrame(frame(7));
    const late = new FakeSocket();
    h.hub.connect(late, viewer({ id: "user-2" }));
    expect(late.binary.map((b) => b.byteLength)).toEqual([7]);
    expect(h.hub.getLastFrame()?.jpeg.byteLength).toBe(7);
  });

  test("says when the agent has no browser, as an error rather than a close", () => {
    const h = setup();
    const socket = new FakeSocket();
    h.hub.connect(socket, viewer());
    h.emitNoTarget();
    expect(socket.ofType("error")).toEqual([
      { type: "error", code: "4010", message: "The agent has no browser open" },
    ]);
    expect(socket.closed).toBeNull();
  });

  test("broadcasts control changes", () => {
    const h = setup();
    const socket = new FakeSocket();
    h.hub.connect(socket, viewer());
    h.setControl({
      paused: true,
      pausedBy: { id: "dev-9", name: "Arjun" },
      holder: { id: "dev-9", name: "Arjun" },
      takeover: null,
      conversationId: "conv-task",
    });
    expect(socket.ofType("control_state")).toEqual([
      {
        type: "control_state",
        paused: true,
        pausedBy: { id: "dev-9", name: "Arjun" },
        holder: { id: "dev-9", name: "Arjun" },
        takeover: null,
      },
    ]);
  });

  test("answers ping, takes the highest requested fps, and refuses control on this socket", () => {
    const h = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const ca = h.hub.connect(a, viewer());
    const cb = h.hub.connect(b, viewer({ id: "user-2" }));
    h.hub.handleMessage(ca, JSON.stringify({ type: "ping" }));
    expect(a.ofType("pong")).toHaveLength(1);
    h.hub.handleMessage(ca, JSON.stringify({ type: "quality", maxFps: 2 }));
    h.hub.handleMessage(cb, JSON.stringify({ type: "quality", maxFps: 50 }));
    expect(h.caster.fps).toBe(10);
    h.hub.handleMessage(ca, JSON.stringify({ type: "pause" }));
    expect(a.ofType("error")[0]).toMatchObject({ code: "unsupported" });
  });

  test("keeps the pod awake while anyone watches", () => {
    const h = setup();
    const conn = h.hub.connect(new FakeSocket(), viewer());
    expect(h.activity).toBe(1);
    h.hub.disconnect(conn);
    h.hub.connect(new FakeSocket(), viewer());
    expect(h.activity).toBe(2);
  });

  test("moves followers onto a new claim's conversation with a fresh hello", () => {
    const h = setup({ follow: null });
    const follower = new FakeSocket();
    const pinned = new FakeSocket();
    h.hub.connect(follower, viewer());
    h.hub.connect(pinned, viewer({ id: "user-2", conversationId: "conv-own" }));
    h.setFollow("conv-new");
    h.hub.refreshFollowTarget();
    expect(follower.ofType("hello").map((m) => m.conversationId)).toEqual([
      null,
      "conv-new",
    ]);
    expect(pinned.ofType("hello")).toHaveLength(1);
  });
});
