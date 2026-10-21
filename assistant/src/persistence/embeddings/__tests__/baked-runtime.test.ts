import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { workerComputeEnv } from "../../../util/worker-compute.js";
import {
  BAKED_RUNTIME_DIR_ENV,
  generateRerankWorkerScript,
  generateWorkerScript,
  getBakedRuntimeDir,
  getEmbeddingRuntimeDir,
  getModelCacheDir,
  RUNTIME_VERSION,
} from "../embedding-runtime-manager.js";

const dirs: string[] = [];
const saved = {
  baked: process.env[BAKED_RUNTIME_DIR_ENV],
  inter: process.env.VELLUM_ONNX_INTER_OP_THREADS,
};

function makeBakedDir(version = RUNTIME_VERSION): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-runtime-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "version.json"),
    JSON.stringify({ runtimeVersion: version }),
  );
  writeFileSync(join(dir, "embed-worker.mjs"), "");
  writeFileSync(join(dir, "rerank-worker.mjs"), "");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const [key, value] of [
    [BAKED_RUNTIME_DIR_ENV, saved.baked],
    ["VELLUM_ONNX_INTER_OP_THREADS", saved.inter],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("baked embedding runtime", () => {
  test("is used when the env var points at a directory matching this build", () => {
    const dir = makeBakedDir();
    process.env[BAKED_RUNTIME_DIR_ENV] = dir;
    expect(getBakedRuntimeDir()).toBe(dir);
    expect(getEmbeddingRuntimeDir()).toBe(dir);
  });

  test("is ignored when its version does not match the code", () => {
    process.env[BAKED_RUNTIME_DIR_ENV] = makeBakedDir("ort-0.0.0_stale");
    expect(getBakedRuntimeDir()).toBeUndefined();
    expect(getEmbeddingRuntimeDir()).not.toBe(
      process.env[BAKED_RUNTIME_DIR_ENV],
    );
  });

  test("serves a baked model from the image and everything else from the workspace", () => {
    const dir = makeBakedDir();
    mkdirSync(join(dir, "model-cache", "Xenova", "bge-small-en-v1.5"), {
      recursive: true,
    });
    process.env[BAKED_RUNTIME_DIR_ENV] = dir;
    expect(getModelCacheDir("Xenova/bge-small-en-v1.5")).toBe(
      join(dir, "model-cache"),
    );
    expect(getModelCacheDir("Xenova/some-reranker")).not.toStartWith(dir);
  });
});

describe("worker thread and dtype configuration", () => {
  test("embed worker reads dtype (default fp32) and inter-op threads from the environment", () => {
    const script = generateWorkerScript();
    expect(script).toContain("process.env.VELLUM_EMBEDDING_DTYPE || 'fp32'");
    expect(script).toContain("interOpNumThreads");
    expect(generateRerankWorkerScript()).toContain("interOpNumThreads");
  });

  test("inter-op threads default to 1 and can be overridden", () => {
    delete process.env.VELLUM_ONNX_INTER_OP_THREADS;
    expect(workerComputeEnv().VELLUM_ONNX_INTER_OP_THREADS).toBe("1");
    process.env.VELLUM_ONNX_INTER_OP_THREADS = "2";
    expect(workerComputeEnv().VELLUM_ONNX_INTER_OP_THREADS).toBe("2");
  });
});

// Runs the real worker when a runtime is baked here (the image build and
// scripts/bake-embedding-runtime.ts both do this); skipped otherwise.
const bakedForReal = getBakedRuntimeDir();
describe.skipIf(
  !bakedForReal || !existsSync(join(bakedForReal, "model-cache")),
)("baked runtime end to end", () => {
  test("embeds text longer than 512 tokens without error (tokenizer truncates)", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "--smol",
        join(bakedForReal!, "embed-worker.mjs"),
        "Xenova/bge-small-en-v1.5",
        join(bakedForReal!, "model-cache"),
      ],
      env: { ...process.env, VELLUM_EMBEDDING_DTYPE: "q8" },
      stdin: "pipe",
      stdout: "pipe",
    });
    const lines = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n")) {
        const { value, done } = await lines.read();
        if (done) {
          throw new Error("worker exited");
        }
        buffer += value;
      }
      const idx = buffer.indexOf("\n");
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      return JSON.parse(line);
    };
    try {
      expect((await next()).type).toBe("ready");
      proc.stdin.write(
        JSON.stringify({ id: 1, texts: ["word ".repeat(5000)] }) + "\n",
      );
      proc.stdin.flush();
      const res = await next();
      expect(res.vectors[0]).toHaveLength(384);
    } finally {
      proc.kill();
    }
  }, 60_000);
});
