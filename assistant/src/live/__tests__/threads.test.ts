/**
 * C6: the chat threads index reads whose a thread is from its conversation
 * key, which survives a restart; the gateway's own record does not.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { resetDbForTesting } from "../../__tests__/db-test-helpers.js";
import { getOrCreateConversation } from "../../persistence/conversation-key-store.js";
import { initializeDb } from "../../persistence/db-init.js";
import { handleLiveThreads } from "../../runtime/routes/live-routes.js";
import { listChatThreads, threadOwnerFromKey } from "../threads.js";

await initializeDb();
afterAll(() => resetDbForTesting());

const guardians = getOrCreateConversation("owner-thread").conversationId;
const arjuns = getOrCreateConversation(
  "aexy-user:threads-arjun:t1",
).conversationId;
const priyas = getOrCreateConversation(
  "aexy-user:threads-priya:t1",
).conversationId;

const ids = (threads: { conversation_id: string }[]) =>
  threads.map((t) => t.conversation_id).sort();

describe("the chat threads index", () => {
  test("gives each person their own and the guardian what nobody else started", () => {
    expect(ids(listChatThreads({ platformUserId: "threads-arjun" }))).toEqual([
      arjuns,
    ]);
    const guardian = listChatThreads("guardian").map((t) => t.conversation_id);
    expect(guardian).toContain(guardians);
    expect(guardian).not.toContain(arjuns);
    expect(guardian).not.toContain(priyas);
  });

  test("names who started each when asked for all", () => {
    const all = new Map(
      listChatThreads("all").map((t) => [
        t.conversation_id,
        t.platform_user_id,
      ]),
    );
    expect(all.get(arjuns)).toBe("threads-arjun");
    expect(all.get(priyas)).toBe("threads-priya");
    expect(all.get(guardians)).toBeNull();
  });

  test("reads the owner only from a person's key", () => {
    expect(threadOwnerFromKey("aexy-user:threads-arjun:abc")).toBe(
      "threads-arjun",
    );
    expect(threadOwnerFromKey("aexy-user::abc")).toBeNull();
    expect(threadOwnerFromKey("some-client-key")).toBeNull();
  });

  test("the route needs to be told whose, and is not there with the view off", async () => {
    const on = { enabled: () => true };
    expect(() => handleLiveThreads(undefined, on)).toThrow();
    const res = handleLiveThreads("threads-priya", on);
    expect(res.status).toBe(200);
    expect(
      (JSON.parse(String(res.body)) as { conversation_id: string }[]).map(
        (t) => t.conversation_id,
      ),
    ).toEqual([priyas]);
    expect(() => handleLiveThreads("all", { enabled: () => false })).toThrow(
      "not available",
    );
  });
});
