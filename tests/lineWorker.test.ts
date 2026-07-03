import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentInvoke: vi.fn(),
  archiveAttachments: vi.fn(),
  conversationSessionFindByConversation: vi.fn(),
  conversationSessionSave: vi.fn(),
  conversationTurnsListRecent: vi.fn(),
  conversationTurnsSave: vi.fn(),
  getSecretString: vi.fn(),
  lineDownloadMessageContent: vi.fn(),
  linePushText: vi.fn(),
}));

vi.mock("../src/agentcore/client", () => ({
  AgentCoreRuntimeClient: vi.fn().mockImplementation(function AgentCoreRuntimeClient() {
    return {
      invoke: mocks.agentInvoke,
    };
  }),
}));

vi.mock("../src/aws/secretsProvider", () => ({
  SecretsProvider: vi.fn().mockImplementation(function SecretsProvider() {
    return {
      getSecretString: mocks.getSecretString,
    };
  }),
}));

vi.mock("../src/line/lineAttachmentArchiveService", () => ({
  LineAttachmentArchiveService: vi.fn().mockImplementation(function LineAttachmentArchiveService() {
    return {
      archiveAttachments: mocks.archiveAttachments,
    };
  }),
}));

vi.mock("../src/line/postMessage", () => ({
  LineMessagingClient: vi.fn().mockImplementation(function LineMessagingClient() {
    return {
      downloadMessageContent: mocks.lineDownloadMessageContent,
      pushText: mocks.linePushText,
    };
  }),
}));

vi.mock("../src/repo/conversationSessionRepository", () => ({
  ConversationSessionRepository: vi.fn().mockImplementation(function ConversationSessionRepository() {
    return {
      findByConversation: mocks.conversationSessionFindByConversation,
      save: mocks.conversationSessionSave,
    };
  }),
}));

vi.mock("../src/repo/conversationTurnRepository", () => ({
  ConversationTurnRepository: vi.fn().mockImplementation(function ConversationTurnRepository() {
    return {
      listRecentChannelTopLevelTurns: mocks.conversationTurnsListRecent,
      save: mocks.conversationTurnsSave,
    };
  }),
}));

vi.mock("../src/repo/sourceDocumentRepository", () => ({
  SourceDocumentRepository: vi.fn().mockImplementation(function SourceDocumentRepository() {
    return {};
  }),
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  process.env = lineWorkerEnv();
  mocks.archiveAttachments.mockResolvedValue({
    documents: [],
    manifestBlocks: [],
  });
  mocks.agentInvoke.mockResolvedValue({
    text: "**Agent reply.**",
    sessionId: "agent-session-1",
    status: "completed",
    taskIds: [],
    recurringTaskIds: [],
    savedMemoryIds: [],
    calendarDraftIds: [],
  });
  mocks.conversationSessionFindByConversation.mockResolvedValue(null);
  mocks.conversationSessionSave.mockResolvedValue(undefined);
  mocks.conversationTurnsListRecent.mockResolvedValue([]);
  mocks.conversationTurnsSave.mockImplementation(async (turn: Record<string, unknown>) => ({
    ...turn,
    turnId: "turn-test-1",
    createdAt: "2026-06-12T00:00:00.000Z",
  }));
  mocks.getSecretString.mockResolvedValue("line-token");
  mocks.linePushText.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...originalEnv };
});

describe("LINE events worker", () => {
  it("invokes AgentCore with LINE image manifest text and archived source ids", async () => {
    const manifestText = [
      "Available image attachment: LINE image img-1 sourceId=src_archived expiresAt=2026-06-06T00:00:00.000Z.",
      "Use the source document tool to inspect it when needed.",
    ].join(" ");
    mocks.archiveAttachments.mockResolvedValueOnce({
      documents: [
        {
          sourceId: "src_archived",
          status: "archived",
          s3Bucket: "line-archive",
          s3Key: "raw/private/line/ws_1/src_archived/line-image-img-1.jpg",
        },
        {
          sourceId: "src_failed",
          status: "archive_failed",
          s3Bucket: "line-archive",
          s3Key: "raw/private/line/ws_1/src_failed/line-image-img-2.jpg",
        },
        {
          sourceId: "src_missing_key",
          status: "archived",
          s3Bucket: "line-archive",
        },
      ],
      manifestBlocks: [{ type: "text", text: manifestText }],
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { handler } = await import("../src/functions/line-events-worker/index");
    const { LineAttachmentArchiveService } = await import("../src/line/lineAttachmentArchiveService");
    const { SourceDocumentRepository } = await import("../src/repo/sourceDocumentRepository");

    await handler({
      Records: [
        {
          body: JSON.stringify(
            lineQueueMessage({
              attachments: [
                { id: "img-1", type: "image", contentType: "image/jpeg" },
                { id: "img-2", type: "image", contentType: "image/png" },
              ],
            }),
          ),
        },
      ],
    } as any);

    expect(SourceDocumentRepository).toHaveBeenCalledWith("source-documents");
    expect(LineAttachmentArchiveService).toHaveBeenCalledWith("line-archive", expect.anything());
    expect(mocks.archiveAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        channelId: "line:group:G1",
        messageTs: "1710000000000",
        userId: "line:user:U1",
        attachments: [
          { id: "img-1", type: "image", contentType: "image/jpeg" },
          { id: "img-2", type: "image", contentType: "image/png" },
        ],
        lineClient: expect.objectContaining({
          downloadMessageContent: mocks.lineDownloadMessageContent,
          pushText: mocks.linePushText,
        }),
        logger: expect.anything(),
        ttlSeconds: 86_400,
        maxImages: 3,
      }),
    );
    expect(mocks.lineDownloadMessageContent).not.toHaveBeenCalled();

    expect(mocks.agentInvoke).toHaveBeenCalledTimes(1);
    const invokeInput = mocks.agentInvoke.mock.calls[0][0];
    expect(invokeInput).toMatchObject({
      runtimeUserId: "line:user:U1",
      request: {
        context: {
          source: "line",
          workspaceId: "ws_1",
          userId: "line:user:U1",
          channelId: "line:group:G1",
          conversationTs: "line:group:G1",
        },
        toolContext: {
          workspaceId: "ws_1",
          userId: "line:user:U1",
          channelId: "line:group:G1",
          attachmentSourceIds: ["src_archived"],
        },
      },
    });
    expect(invokeInput.request.content).toEqual([
      {
        type: "text",
        text: [
          "Format the final answer as LINE plain text. Do not use Markdown syntax such as **bold**, headings, tables, code fences, or Slack mrkdwn.",
          "Current local date: 2026-06-05 (Asia/Tokyo)",
          "Use this date for relative dates such as today, tomorrow, and this week.",
          "Current user message:",
          "What is in this image?",
        ].join("\n"),
      },
      { type: "text", text: manifestText },
    ]);
    expect(invokeInput.request.content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
    expect(JSON.stringify(invokeInput.request.content)).not.toContain("base64");
    expect(mocks.linePushText).toHaveBeenCalledWith("line-target-G1", "Agent reply.");

    const [savedUserTurn, savedAssistantTurn] = mocks.conversationTurnsSave.mock.calls.map(
      ([turn]) => turn,
    );
    expect(savedUserTurn).toMatchObject({
      role: "user",
      messageTs: "1710000000000",
      turnTs: "LINE#2026-06-05T00:00:00.000Z#1710000000000",
    });
    expect(savedAssistantTurn).toMatchObject({
      role: "assistant",
      sourceEvent: "line_assistant_reply",
      messageTs: expect.stringMatching(/^\d+\.\d{6}$/),
      turnTs: expect.stringMatching(/^LINE#\d{4}-\d{2}-\d{2}T.*Z#\d+\.\d{6}$/),
    });
    expect(savedAssistantTurn.turnTs).toContain(savedAssistantTurn.messageTs);
  });
});

function lineWorkerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...originalEnv,
    SESSION_TABLE_NAME: "sessions",
    CONVERSATION_SESSIONS_TABLE_NAME: "conversation-sessions",
    WORK_SESSIONS_TABLE_NAME: "work-sessions",
    CONVERSATION_TURNS_TABLE_NAME: "conversation-turns",
    MEMORY_ITEMS_TABLE_NAME: "memory-items",
    TASKS_TABLE_NAME: "tasks",
    TASK_EVENTS_TABLE_NAME: "task-events",
    RECURRING_TASKS_TABLE_NAME: "recurring-tasks",
    PROVIDER_BINDINGS_TABLE_NAME: "provider-bindings",
    PROCESSED_EVENTS_TABLE_NAME: "processed-events",
    TASK_TABLE_NAME: "scheduled-tasks",
    AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/test",
    AGENTCORE_RUNTIME_QUALIFIER: "",
    DEFAULT_SCHEDULE_CHANNEL: "CDEFAULT",
    CALENDAR_DRAFTS_TABLE_NAME: "calendar-drafts",
    GOOGLE_CALENDAR_SECRET_ID: "google-calendar",
    GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: "google-oauth",
    GOOGLE_CALENDAR_TIME_ZONE: "Asia/Tokyo",
    LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: "line-token-secret",
    SOURCE_DOCUMENTS_TABLE_NAME: "source-documents",
    LINE_ATTACHMENT_ARCHIVE_BUCKET_NAME: "line-archive",
    ...overrides,
  };
}

function lineQueueMessage(overrides: Record<string, unknown> = {}) {
  return {
    correlationId: "corr-1",
    eventId: "event-1",
    workspaceId: "ws_1",
    providerAccountId: "line-bot",
    channelId: "line:group:G1",
    conversationTs: "line:group:G1",
    messageTs: "1710000000000",
    userId: "line:user:U1",
    text: "What is in this image?",
    responseTargetId: "line-target-G1",
    responseTargetType: "group",
    source: "message",
    contextScope: "channel_top_level",
    receivedAt: "2026-06-05T00:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}
