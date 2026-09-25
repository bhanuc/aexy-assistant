/**
 * C6, daemon side, at POST /v1/messages: a turn from someone on the access
 * list is keyed by them and names them; the guardian's is untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const addMessageMock = mock(async (_conversationId: string, role: string) => ({
  id: role === "user" ? "persisted-user-id" : "persisted-assistant-id",
  deduplicated: false,
}));

const setConversationEnabledPluginsMock = mock(
  (_conversationId: string, _plugins: string[] | null) => {},
);

const keysUsed: string[] = [];
mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: (key: string) => {
    keysUsed.push(key);
    return { conversationId: "conv-c6-test" };
  },
  getConversationByKey: () => null,
}));

mock.module("../live/live-view-feature.js", () => ({
  AEXY_LIVE_VIEW_FLAG: "aexy-live-view",
  DESKTOP_CDP_HOST: "127.0.0.1",
  DESKTOP_CDP_PORT: 9222,
  isLiveViewEnabled: () => true,
}));

let belongs = false;
const realActingUser = await import("../live/acting-user.js");
mock.module("../live/acting-user.js", () => ({
  ...realActingUser,
  conversationBelongsTo: () => belongs,
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: async () => ({
    consumed: false,
    decisionApplied: false,
    type: "not_consumed",
  }),
}));

mock.module("../channels/gateway-guardian-requests.js", () => ({
  createGuardianRequest: async (params: Record<string, unknown>) => ({
    ...params,
    requestCode: "ABC123",
  }),
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: async () => undefined,
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: (conversationId: string, role: string) =>
    addMessageMock(conversationId, role),
  extractImageSourcePaths: () => undefined,
  getConversation: (id: string) =>
    id === "conv-someone-elses" ? { id, conversationType: "standard" } : null,
  getConversationOverrideProfile: () => undefined,
  getMessages: () => [],
  provenanceFromTrustContext: (ctx: unknown) =>
    ctx
      ? { provenanceTrustClass: (ctx as Record<string, unknown>).trustClass }
      : { provenanceTrustClass: "unknown" },
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  setConversationInferenceProfile: () => {},
  setConversationEnabledPlugins: (
    conversationId: string,
    plugins: string[] | null,
  ) => setConversationEnabledPluginsMock(conversationId, plugins),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  recordConversationPersistedSeq: () => {},
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
  resolveAttachmentsForPersist: () => [],
  attachmentExists: () => false,
  linkAttachmentToMessage: () => {},
  attachInlineAttachmentToMessage: () => {},
  validateAttachmentUpload: () => ({ ok: true }),
}));

mock.module("../daemon/conversation-process.js", () => ({
  buildModelInfoEvent: () => ({
    type: "model_info",
    model: "claude-opus-4-7",
    provider: "anthropic",
    configuredProviders: ["anthropic"],
  }),
  isModelSlashCommand: () => false,
  formatCompactResult: () => "",
}));

const realLocalActorIdentity =
  await import("../runtime/local-actor-identity.js");
mock.module("../runtime/local-actor-identity.js", () => ({
  ...realLocalActorIdentity,
}));

mock.module("../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
  }),
  withSourceChannel: (sourceChannel: unknown, ctx: unknown) => ({
    ...(ctx as Record<string, unknown>),
    sourceChannel,
  }),
}));

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [
    {
      channelType: "vellum",
      contactId: "guardian-contact",
      principalId: "test-user",
      address: "test-user",
      status: "active",
    },
  ],
}));

const ipcCallMock = mock(
  async (): Promise<Record<string, unknown> | undefined> => ({ ok: true }),
);
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: ipcCallMock,
}));

import { getConversationSpeaker } from "../live/acting-user.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

function makeConversation() {
  const runAgentLoop = mock(async () => undefined);
  const persistUserMessage = mock(async () => ({
    id: "persisted-user-id",
    deduplicated: false,
  }));
  const messages: unknown[] = [];
  let processing = false;
  let enabledPlugins: string[] | null = null;
  const conversation = {
    conversationId: "conv-c6-test",
    messages,
    get enabledPlugins(): string[] | null {
      return enabledPlugins;
    },
    set enabledPlugins(value: string[] | null) {
      enabledPlugins = value;
    },
    abortController: null,
    currentRequestId: undefined,
    queue: { length: 0 },
    setTrustContext: () => {},
    replayActivityState: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    ensureActorScopedHistory: async () => {},
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    // Mirrors the real Conversation.setEnabledPlugins, which persists to the
    // row via setConversationEnabledPlugins as it updates the live instance.
    setEnabledPlugins: (plugins: string[] | null) => {
      enabledPlugins = plugins;
      setConversationEnabledPluginsMock("conv-c6-test", plugins);
    },
    hasAnyPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
    persistUserMessage,
    runAgentLoop,
    setPreactivatedSkillIds: () => {},
    drainQueue: async (_reason?: string) => {},
    kickDrainQueue(
      this: { drainQueue: (reason?: string) => unknown },
      reason: string = "loop_complete",
      _origin?: string,
    ) {
      return this.drainQueue(reason);
    },
    warmPromptCache: () => {},
    getMessages: () => messages,
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    usageStats: { inputTokens: 1000, outputTokens: 500, estimatedCost: 0.05 },
  } as unknown as import("../daemon/conversation.js").Conversation;
  return { conversation, runAgentLoop };
}

function makeRequest(
  extras: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vellum-actor-principal-id": "test-user",
      "x-vellum-principal-type": "actor",
      ...headers,
    },
    body: JSON.stringify({
      conversationKey: undefined,
      content: "hello there",
      sourceChannel: "vellum",
      interface: "macos",
      ...extras,
    }),
  });
}

function makeDeps(
  conversation: import("../daemon/conversation.js").Conversation,
) {
  return {
    sendMessageDeps: {
      getOrCreateConversation: async () => conversation,
      assistantEventHub: { publish: async () => {} } as never,
      resolveAttachments: () => [],
    },
  };
}

const ARJUN = {
  "x-vellum-acting-user-id": "user-arjun",
  "x-vellum-acting-user-name": encodeURIComponent("Arjun Mehta"),
  "x-vellum-acting-user-role": "member",
  "x-vellum-acting-aexy-developer-id": "dev-arjun",
};

describe("handleSendMessage for someone on the access list", () => {
  beforeEach(() => {
    keysUsed.length = 0;
    belongs = false;
  });

  test("a new thread is keyed by the person and their turn names them", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest({}, ARJUN),
      undefined,
      202,
    );
    expect(res.status).toBe(202);
    expect(keysUsed).toHaveLength(1);
    expect(keysUsed[0]).toStartWith("aexy-user:user-arjun:");
    expect(getConversationSpeaker("conv-c6-test")).toMatchObject({
      name: "Arjun Mehta",
      role: "member",
    });
  });

  test("the guardian's send keeps upstream keys and clears the speaker", async () => {
    const { conversation } = makeConversation();
    await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest({ conversationKey: "plain-key" }),
      undefined,
      202,
    );
    expect(keysUsed).toEqual(["plain-key"]);
    expect(getConversationSpeaker("conv-c6-test")).toBeNull();
  });

  test("someone else's conversation is not found", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest({ conversationId: "conv-someone-elses" }, ARJUN),
      undefined,
      404,
    );
    expect(res.status).toBe(404);
  });
});
