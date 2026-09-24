import { beforeEach, describe, expect, test } from "bun:test";

import type { ScreencastFrame } from "../../live/screencast.js";
import {
  _resetWatchSnapshotForTests,
  handleWatchSnapshot,
} from "../../runtime/routes/live-routes.js";

const NOW = Date.parse("2026-09-24T10:00:10.000Z");

function frame(ts: string, n = 3): ScreencastFrame {
  return {
    jpeg: new Uint8Array(n),
    width: 1280,
    height: 800,
    url: "https://venues.example/a b",
    title: "t",
    ts,
  };
}

describe("GET /v1/watch/snapshot", () => {
  beforeEach(() => _resetWatchSnapshotForTests());

  test("serves a fresh cast frame with its time and url", async () => {
    const res = await handleWatchSnapshot({
      enabled: () => true,
      lastFrame: () => frame("2026-09-24T10:00:09.000Z"),
      desktopReady: () => true,
      captureStill: async () => {
        throw new Error("should not capture");
      },
      now: () => NOW,
    });
    expect(res.status).toBeUndefined();
    expect(res.headers).toEqual({
      "content-type": "image/jpeg",
      "cache-control": "no-store",
      "x-frame-ts": "2026-09-24T10:00:09.000Z",
      "x-frame-url": "https://venues.example/a%20b",
    });
  });

  test("takes a still when nobody is casting, but only of a desktop already up", async () => {
    let captured = 0;
    const deps = {
      enabled: () => true,
      lastFrame: () => null,
      captureStill: async () => {
        captured += 1;
        return frame("2026-09-24T10:00:10.000Z", 9);
      },
      now: () => NOW,
    };
    const off = await handleWatchSnapshot({
      ...deps,
      desktopReady: () => false,
    });
    expect(off.status).toBe(204);
    expect(captured).toBe(0);

    const on = await handleWatchSnapshot({ ...deps, desktopReady: () => true });
    expect(captured).toBe(1);
    expect(on.headers["x-frame-ts"]).toBe("2026-09-24T10:00:10.000Z");
  });

  test("is not found with the live view off", async () => {
    await expect(handleWatchSnapshot({ enabled: () => false })).rejects.toThrow(
      "not available",
    );
  });
});
