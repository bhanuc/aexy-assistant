/**
 * Reading a deliverable from the sandbox, and the ways the obvious version
 * (check a path, then read the path) goes wrong: the path is swapped between
 * the two.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";

mock.module("../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: false,
    platformBaseUrl: "",
    assistantApiKey: "",
  }),
}));

const { readDeliverable, mentionedFiles } = await import("./attachments.js");

const root = realpathSync(mkdtempSync(join(tmpdir(), "attach-")));
const ws = join(root, "ws");
const outside = join(root, "outside");
mkdirSync(ws);
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "top secret");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readDeliverable", () => {
  test("reads a regular file inside the workspace", async () => {
    writeFileSync(join(ws, "a.md"), "hello");
    const result = await readDeliverable("a.md", ws);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.bytes.toString()).toBe("hello");
      expect(result.file.fileName).toBe("a.md");
      expect(result.file.realPath).toBe(join(ws, "a.md"));
    }
  });

  test("a file swapped for a symlink after the check is refused, not followed", async () => {
    writeFileSync(join(ws, "swap.md"), "innocent");
    const result = await readDeliverable("swap.md", ws, {
      afterCheck: () => {
        unlinkSync(join(ws, "swap.md"));
        symlinkSync(join(outside, "secret.txt"), join(ws, "swap.md"));
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("changed while it was being attached");
    }
  });

  test.skipIf(!existsSync("/proc/self/fd"))(
    "a directory swapped for a link after the check is refused",
    async () => {
      mkdirSync(join(ws, "sub"));
      writeFileSync(join(ws, "sub", "f.txt"), "innocent");
      writeFileSync(join(outside, "f.txt"), "top secret");
      const result = await readDeliverable("sub/f.txt", ws, {
        afterCheck: () => {
          renameSync(join(ws, "sub"), join(ws, "sub-old"));
          symlinkSync(outside, join(ws, "sub"));
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("changed while it was being attached");
      }
    },
  );

  test("an empty file is refused", async () => {
    writeFileSync(join(ws, "empty.md"), "");
    const result = await readDeliverable("empty.md", ws);
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("empty");
  });

  test("a directory is refused", async () => {
    mkdirSync(join(ws, "dir"));
    const result = await readDeliverable("dir", ws);
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("directory");
  });

  test("a FIFO is refused without hanging", async () => {
    execFileSync("mkfifo", [join(ws, "pipe")]);
    const result = await readDeliverable("pipe", ws);
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("not a regular file");
  });

  test("a symlink out of the workspace is refused", async () => {
    symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
    const result = await readDeliverable("link.txt", ws);
    expect(result.ok).toBe(false);
  });
});

describe("mentionedFiles", () => {
  test("ignores URLs, finds extended extensions and non-Latin names", () => {
    expect(
      mentionedFiles(
        "See https://x.io/a/report.pdf, and отчёт.md, sheet.xls, deck.pptx, a.jpeg, t.tsv",
      ),
    ).toEqual(["отчёт.md", "sheet.xls", "deck.pptx", "a.jpeg", "t.tsv"]);
  });
});
