import { describe, expect, test } from "bun:test";

import { waitFor } from "../../__tests__/helpers/wait-for.js";
import type { CdpTransportEvent } from "../../tools/browser/cdp-client/cdp-inspect/ws-transport.js";
import type { AgentBrowserTarget } from "../agent-browser-target.js";
import {
  choosePage,
  DesktopScreencaster,
  jpegSize,
  type ScreencastFrame,
} from "../screencast.js";

function target(id: string, url = `https://${id}.example/`) {
  return {
    id,
    type: "page",
    title: `Title ${id}`,
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

/** A 1280x800 baseline JPEG header: enough for the SOF0 parser. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0x01,
  0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

class FakeConnection {
  readonly sent: { method: string; params?: Record<string, unknown> }[] = [];
  private listener: ((e: CdpTransportEvent) => void) | null = null;
  disposed = false;
  constructor(readonly url: string) {}
  async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sent.push({ method, params });
    if (method === "Page.captureScreenshot") {
      return { data: JPEG.toString("base64") } as T;
    }
    return {} as T;
  }
  addEventListener(listener: (e: CdpTransportEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  dispose() {
    this.disposed = true;
  }
  paint(sessionId: number) {
    this.listener?.({
      method: "Page.screencastFrame",
      params: {
        data: JPEG.toString("base64"),
        sessionId,
        metadata: { deviceWidth: 1440, deviceHeight: 900, timestamp: 1 },
      },
    });
  }
  methods() {
    return this.sent.map((s) => s.method);
  }
}

function setup(initial: ReturnType<typeof target>[]) {
  let targets = initial;
  let agent: AgentBrowserTarget | null = null;
  let agentListener: (() => void) | null = null;
  const connections: FakeConnection[] = [];
  const frames: ScreencastFrame[] = [];
  let noTarget = 0;
  const caster = new DesktopScreencaster(
    {
      onFrame: (f) => frames.push(f),
      onNoTarget: () => {
        noTarget += 1;
      },
    },
    {
      listTargets: async () => targets,
      connect: async (url) => {
        const c = new FakeConnection(url);
        connections.push(c);
        return c;
      },
      agentTarget: () => agent,
      onAgentTargetChange: (listener) => {
        agentListener = listener;
        return () => {
          agentListener = null;
        };
      },
      pollMs: 60_000,
    },
  );
  return {
    caster,
    connections,
    frames,
    get noTarget() {
      return noTarget;
    },
    setTargets: (next: ReturnType<typeof target>[]) => {
      targets = next;
    },
    moveAgent: (t: ReturnType<typeof target>) => {
      agent = t;
      agentListener?.();
    },
  };
}

describe("screencasting the agent's page", () => {
  test("starts the cast with the contract's parameters and acks each frame", async () => {
    const h = setup([target("a")]);
    h.caster.setMaxFps(10);
    h.caster.start();
    await waitFor(() => h.connections.length === 1);
    const c = h.connections[0]!;
    await waitFor(() => c.methods().includes("Page.startScreencast"));
    expect(c.sent[0]).toEqual({
      method: "Page.startScreencast",
      params: {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      },
    });
    c.paint(11);
    await waitFor(() => c.methods().includes("Page.screencastFrameAck"));
    expect(c.sent.at(-1)).toEqual({
      method: "Page.screencastFrameAck",
      params: { sessionId: 11 },
    });
    // The picture's own size, not the page's CSS viewport.
    expect(h.frames[0]).toMatchObject({
      width: 1280,
      height: 800,
      url: "https://a.example/",
      title: "Title a",
    });
    h.caster.stop();
    expect(c.methods()).toContain("Page.stopScreencast");
    expect(c.disposed).toBe(true);
  });

  test("follows the agent to another tab", async () => {
    const h = setup([target("a"), target("b")]);
    h.caster.start();
    await waitFor(() => h.connections.length === 1);
    expect(h.connections[0]!.url).toContain("/a");
    h.moveAgent(target("b"));
    await waitFor(() => h.connections.length === 2);
    expect(h.connections[1]!.url).toContain("/b");
    expect(h.connections[0]!.disposed).toBe(true);
    h.caster.stop();
  });

  test("reports no browser once, until a page appears", async () => {
    const h = setup([]);
    h.caster.start();
    await waitFor(() => h.noTarget === 1);
    h.caster.stop();
  });

  test("a still is taken on the agent's page", async () => {
    const h = setup([target("a")]);
    const shot = await h.caster.captureScreenshot();
    expect(shot?.byteLength).toBe(JPEG.byteLength);
    expect(h.connections[0]!.disposed).toBe(true);
  });
});

describe("choosing the page", () => {
  test("prefers the agent's target while it exists", () => {
    const pages = [target("a"), target("b")];
    expect(choosePage(pages, target("b"))?.id).toBe("b");
    expect(choosePage(pages, target("gone"))?.id).toBe("a");
    expect(
      choosePage([{ ...target("w"), type: "service_worker" }], null),
    ).toBeNull();
  });

  test("reads a JPEG's size from its start-of-frame marker", () => {
    expect(jpegSize(JPEG)).toEqual({ w: 1280, h: 800 });
    expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
