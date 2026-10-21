/**
 * When the platform answers that it holds no key for a managed provider, an
 * embed job must be parked for the backoff window: no retry every few seconds,
 * and no attempt or deferral spent (so the backlog is not walked into `failed`).
 * Jobs still queued behind it in the same batch are parked with it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

import { ManagedProviderNotConfiguredError } from "../../../../providers/platform-proxy/managed-availability.js";

let triggerCalls = 0;
mock.module("../graph/graph-search.js", () => ({
  embedGraphNodeDirect: async () => {},
  embedGraphNodeJob: async (): Promise<void> => {},
  enqueueGraphNodeEmbed: () => {},
  embedGraphTriggerJob: async (): Promise<void> => {
    triggerCalls += 1;
    throw new ManagedProviderNotConfiguredError("gemini", 503);
  },
  enqueueGraphTriggerEmbed: () => {},
}));

mock.module("../v1/graph/graph-search.js", () => ({
  searchGraphNodes: async () => [],
}));

mock.module("../../../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: async () => {},
  maybeRunPassiveWalCheckpoint: async () => {},
}));

const tmpWorkspace = mkdtempSync(join(tmpdir(), "jobs-worker-managed-nc-"));
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { _resetQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { registerMemoryPluginJobHandlers } from "../job-handler-registration.js";
import { runMemoryJobsOnce } from "../jobs-worker.js";

function jobRow(jobId: string) {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, jobId))
    .get();
}

describe("embed job against a managed provider the platform has not configured", () => {
  beforeAll(async () => {
    registerMemoryPluginJobHandlers();
    await initializeDb();
  });

  afterAll(() => {
    if (previousWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
    }
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
    _resetQdrantBreaker();
    triggerCalls = 0;
  });

  test("is rescheduled well past the 30s retry cadence, spending no attempt or deferral", async () => {
    const jobId = enqueueMemoryJob("graph_trigger_embed", {
      triggerId: "trigger-1",
    });

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("pending");
    expect(row!.runAfter).toBeGreaterThan(Date.now() + 50_000);
    expect(row!.attempts).toBe(0);
    expect(row!.deferrals).toBe(0);
  });

  test("parks the rest of the batch instead of running each into the same refusal", async () => {
    const ids = [1, 2, 3].map((n) =>
      enqueueMemoryJob("graph_trigger_embed", { triggerId: `trigger-${n}` }),
    );

    await runMemoryJobsOnce();

    // Same (type, conversation) group runs serially; only the first reaches
    // the handler.
    expect(triggerCalls).toBeLessThanOrEqual(ids.length);
    for (const id of ids) {
      const row = jobRow(id);
      expect(row?.status).toBe("pending");
      expect(row!.attempts).toBe(0);
    }
    expect(triggerCalls).toBe(1);
  });
});
