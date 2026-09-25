import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import {
  desktopChromePath,
  DesktopDependencyInstaller,
  type DesktopSetupStatus,
} from "./desktop-dependencies.js";

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

function setup() {
  let ready = false;
  let supported = true;
  let finish!: () => void;
  let fail!: (err: Error) => void;
  let progress!: (stage: NonNullable<DesktopSetupStatus["stage"]>) => void;
  const notify = mock(async () => {});
  const install = mock((onStage: typeof progress) => {
    progress = onStage;
    return new Promise<void>((resolve, reject) => {
      finish = () => {
        ready = true;
        resolve();
      };
      fail = reject;
    });
  });
  const installer = new DesktopDependencyInstaller({
    supported: () => supported,
    ready: () => ready,
    install,
    notify,
  });
  return {
    installer,
    install,
    notify,
    finish: () => finish(),
    fail: () => fail(new Error("download failed")),
    progress: () => progress("chrome"),
    restoreComponents: () => {
      ready = true;
    },
    removeComponents: () => {
      ready = false;
    },
    unsupported: () => {
      supported = false;
    },
  };
}

describe("desktop dependency installation", () => {
  test("status is read only and repeated starts share one install", async () => {
    const f = setup();
    expect(f.installer.getStatus().state).toBe("required");
    expect(f.install).not.toHaveBeenCalled();
    expect(f.installer.start().state).toBe("installing");
    f.installer.start();
    await flush();
    expect(f.install).toHaveBeenCalledTimes(1);
    f.progress();
    expect(f.installer.getStatus()).toEqual({
      state: "installing",
      stage: "chrome",
    });
    f.finish();
    await flush();
    expect(f.installer.getStatus().state).toBe("ready");
    f.installer.start();
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(3);
    f.removeComponents();
    expect(f.installer.getStatus().state).toBe("required");
  });

  test("a failed install releases the job and retries without starting a desktop", async () => {
    const f = setup();
    f.installer.start();
    await flush();
    f.restoreComponents();
    f.fail();
    await flush();
    expect(f.installer.getStatus().state).toBe("failed");
    f.installer.start();
    await flush();
    expect(f.install).toHaveBeenCalledTimes(2);
    f.finish();
    await flush();
    expect(f.installer.getStatus().state).toBe("ready");
  });

  test("unsupported environments cannot trigger installation", () => {
    const f = setup();
    f.unsupported();
    expect(f.installer.start().state).toBe("unsupported");
    expect(f.install).not.toHaveBeenCalled();
  });
});

describe("a Chrome baked into the image", () => {
  test("is preferred once its ready marker exists, and ignored before", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-desktop-"));
    try {
      const external = desktopChromePath(root);
      expect(external.startsWith(root)).toBe(false);

      const baked = join(
        root,
        "chrome-153.0.8010.36-1",
        "opt/google/chrome/chrome",
      );
      mkdirSync(dirname(baked), { recursive: true });
      writeFileSync(baked, "");
      // A binary without the marker is an interrupted bake, not a Chrome.
      expect(desktopChromePath(root)).toBe(external);

      writeFileSync(baked + ".ready", "");
      expect(desktopChromePath(root)).toBe(baked);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
