/**
 * Bakes the local embedding runtime into a directory at image build time.
 *
 *   bun run scripts/bake-embedding-runtime.ts /opt/vellum-embedding
 *
 * 1. Installs the pinned, integrity-checked onnxruntime-node / transformers
 *    packages and the worker scripts (the same install the daemon would
 *    otherwise do at runtime from the workspace volume).
 * 2. Downloads the quantized (int8) bge-small ONNX model at a pinned Hugging
 *    Face revision, verifying each file's sha256, into the layout
 *    transformers.js reads from `env.cacheDir`.
 * 3. Starts the real embed worker against that directory and embeds a text
 *    longer than the model's 512-token limit, asserting a 384-dim vector. A
 *    missing native binary, a bad model file or a platform onnxruntime cannot
 *    load fails the build here instead of in a pod.
 *
 * Exits non-zero on any failure.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  EMBEDDING_DTYPE_ENV,
  EmbeddingRuntimeManager,
} from "../src/persistence/embeddings/embedding-runtime-manager.js";

const MODEL = "Xenova/bge-small-en-v1.5";
const REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
const DTYPE = "q8";
const EXPECTED_DIM = 384;

/** Files transformers.js loads for `feature-extraction` at dtype q8. */
const FILES: Array<{ path: string; sha256: string }> = [
  {
    path: "config.json",
    sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
  },
  {
    path: "tokenizer.json",
    sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
  },
  {
    path: "tokenizer_config.json",
    sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  },
  {
    path: "onnx/model_quantized.onnx",
    sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
  },
];

async function fetchPinned(root: string, file: (typeof FILES)[number]) {
  const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${file.path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== file.sha256) {
    throw new Error(
      `sha256 mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`,
    );
  }
  const target = join(root, "model-cache", MODEL, file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  console.log(`  ${file.path} ok (${bytes.length} bytes)`);
}

async function verifyWorker(dir: string): Promise<void> {
  const manager = new EmbeddingRuntimeManager(dir);
  const bun = manager.getBunPath();
  if (!bun) {
    throw new Error("no bun binary to run the embed worker");
  }
  const proc = Bun.spawn({
    cmd: [
      bun,
      "--smol",
      manager.getWorkerPath(),
      MODEL,
      join(dir, "model-cache"),
    ],
    cwd: dir,
    env: { ...process.env, [EMBEDDING_DTYPE_ENV]: DTYPE },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buffer = "";
  const nextLine = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        return JSON.parse(line);
      }
      const { done, value } = await reader.read();
      if (done) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`embed worker exited early: ${stderr.trim()}`);
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };
  try {
    const ready = await nextLine();
    if (ready.type !== "ready") {
      throw new Error(`embed worker failed to load the model: ${ready.error}`);
    }
    // Well over 512 tokens: the tokenizer must truncate rather than fail.
    const long = "memory ".repeat(2000);
    proc.stdin.write(
      JSON.stringify({ id: 1, texts: ["hello world", long] }) + "\n",
    );
    proc.stdin.flush();
    const response = await nextLine();
    const vectors = response.vectors as number[][] | undefined;
    if (
      !vectors ||
      vectors.length !== 2 ||
      vectors.some((v) => v.length !== EXPECTED_DIM)
    ) {
      throw new Error(
        `unexpected embed response: ${JSON.stringify(response).slice(0, 300)}`,
      );
    }
    console.log(`  worker embedded 2 texts at ${EXPECTED_DIM} dims`);
  } finally {
    proc.kill();
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    throw new Error("usage: bake-embedding-runtime.ts <target-dir>");
  }
  console.log(`Installing embedding runtime into ${dir}`);
  await new EmbeddingRuntimeManager(dir).ensureInstalled();
  console.log(`Downloading ${MODEL}@${REVISION} (${DTYPE})`);
  for (const file of FILES) {
    await fetchPinned(dir, file);
  }
  console.log("Verifying the worker loads the model and embeds");
  await verifyWorker(dir);
}

main().catch((err) => {
  console.error(`bake-embedding-runtime failed: ${err}`);
  process.exit(1);
});
