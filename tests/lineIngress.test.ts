import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqsSend: vi.fn(),
  getSecretString: vi.fn(),
  markProcessed: vi.fn(),
  resolveWorkspace: vi.fn(),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(function SQSClient() {
    return { send: mocks.sqsSend };
  }),
  SendMessageCommand: vi.fn().mockImplementation(function SendMessageCommand(input) {
    return { input };
  }),
}));

vi.mock("../src/aws/secretsProvider", () => ({
  SecretsProvider: vi.fn().mockImplementation(function SecretsProvider() {
    return { getSecretString: mocks.getSecretString };
  }),
}));

vi.mock("../src/repo/eventDedupRepository", () => ({
  EventDedupRepository: vi.fn().mockImplementation(function EventDedupRepository() {
    return { markProcessed: mocks.markProcessed };
  }),
}));

vi.mock("../src/repo/providerBindingRepository", () => ({
  ProviderBindingRepository: vi.fn().mockImplementation(function ProviderBindingRepository() {
    return { resolveWorkspace: mocks.resolveWorkspace };
  }),
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  mocks.sqsSend.mockReset();
  mocks.getSecretString.mockReset().mockResolvedValue("line-secret");
  mocks.markProcessed.mockReset().mockResolvedValue(true);
  mocks.resolveWorkspace.mockReset();
  process.env = lineIngressEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = originalEnv;
});

function lineIngressEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...originalEnv,
    SESSION_TABLE_NAME: "sessions",
    CONVERSATION_SESSIONS_TABLE_NAME: "conversation-sessions",
    WORK_SESSIONS_TABLE_NAME: "work-sessions",
    CONVERSATION_TURNS_TABLE_NAME: "conversation-turns",
    USER_MEMORY_TABLE_NAME: "user-memory",
    MEMORY_ITEMS_TABLE_NAME: "memory-items",
    TASKS_TABLE_NAME: "tasks",
    TASK_EVENTS_TABLE_NAME: "task-events",
    RECURRING_TASKS_TABLE_NAME: "recurring-tasks",
    PROVIDER_BINDINGS_TABLE_NAME: "provider-bindings",
    PROCESSED_EVENTS_TABLE_NAME: "processed-events",
    TASK_TABLE_NAME: "scheduled-tasks",
    AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:runtime",
    DEFAULT_SCHEDULE_CHANNEL: "CDEFAULT",
    LINE_CHANNEL_SECRET_SECRET_ID: "line-secret-param",
    LINE_QUEUE_URL: "https://sqs.local/line",
    ...overrides,
  };
}

function signedLineEvent(text = "hello") {
  const rawBody = JSON.stringify({
    destination: "Ubot",
    events: [
      {
        type: "message",
        webhookEventId: "event-1",
        replyToken: "reply-1",
        timestamp: 1710000000000,
        source: { type: "group", groupId: "G1", userId: "U1" },
        message: { id: "msg-1", type: "text", text },
      },
    ],
  });
  const signature = createHmac("sha256", "line-secret").update(rawBody).digest("base64");

  return {
    body: rawBody,
    isBase64Encoded: false,
    headers: { "X-Line-Signature": signature },
    requestContext: { requestId: "req-1" },
  } as any;
}

describe("LINE events ingress workspace resolution", () => {
  it("does not enqueue unbound conversations when LINE resolution mode is bound_only", async () => {
    process.env = lineIngressEnv({ LINE_WORKSPACE_RESOLUTION_MODE: "bound_only" });
    mocks.resolveWorkspace.mockResolvedValueOnce(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { handler } = await import("../src/functions/line-events-ingress/index");

    const result = await handler(signedLineEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: true,
      enqueued: 0,
      duplicate: 0,
      disabled: 1,
    });
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({
      provider: "line",
      providerAccountId: "Ubot",
      providerConversationKey: "group:G1",
      fallbackWorkspaceId: "line:group:G1",
      resolutionMode: "bound_only",
    });
    expect(mocks.sqsSend).not.toHaveBeenCalled();

    const unresolvedBindingLog = logSpy.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .find((entry) => entry.message === "LINE event ignored because provider binding did not resolve");

    expect(unresolvedBindingLog).toMatchObject({
      workspaceResolutionMode: "bound_only",
      responseTargetType: "group",
      correlationId: "req-1:0",
    });
    const unresolvedBindingLogJson = JSON.stringify(unresolvedBindingLog);
    expect(unresolvedBindingLogJson).not.toContain("Ubot");
    expect(unresolvedBindingLogJson).not.toContain("G1");
    expect(unresolvedBindingLogJson).not.toContain("group:G1");
    expect(unresolvedBindingLogJson).not.toContain("event-1");
    expect(unresolvedBindingLogJson).not.toContain("line:group:G1");

    const allLogs = logSpy.mock.calls.map(([entry]) => String(entry)).join("\n");
    expect(allLogs).not.toContain("Ubot");
    expect(allLogs).not.toContain("G1");
    expect(allLogs).not.toContain("group:G1");
    expect(allLogs).not.toContain("event-1");
    expect(allLogs).not.toContain("line:group:G1");
  });

  it("keeps fallback behavior by default", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce({
      workspaceId: "line:group:G1",
      source: "fallback",
    });
    const { handler } = await import("../src/functions/line-events-ingress/index");

    const result = await handler(signedLineEvent("buy milk"));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      ok: true,
      enqueued: 1,
      duplicate: 0,
      disabled: 0,
    });
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({
      provider: "line",
      providerAccountId: "Ubot",
      providerConversationKey: "group:G1",
      fallbackWorkspaceId: "line:group:G1",
      resolutionMode: "fallback",
    });
    expect(mocks.sqsSend).toHaveBeenCalledTimes(1);
    expect(mocks.sqsSend.mock.calls[0][0].input).toMatchObject({
      QueueUrl: "https://sqs.local/line",
    });
    expect(JSON.parse(mocks.sqsSend.mock.calls[0][0].input.MessageBody)).toMatchObject({
      workspaceId: "line:group:G1",
      channelId: "line:group:G1",
      text: "buy milk",
    });
  });
});
