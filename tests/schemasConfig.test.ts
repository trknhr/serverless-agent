import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentContentBlockSchema,
  agentRuntimeRequestSchema,
  agentRuntimeResponseSchema,
  buildAgentRuntimeResources,
} from "../src/agentcore/contracts";
import {
  buildGoogleAuthorizationUrl,
  createGoogleOAuthState,
  exchangeGoogleAuthorizationCode,
  fetchGoogleUserInfo,
  parseGoogleOAuthClientConfig,
  verifyGoogleOAuthState,
} from "../src/calendar/googleOAuth";
import {
  chatMessageRequestSchema,
  chatMessageResponseSchema,
} from "../src/chat/contracts";
import {
  loadChatApiEnv,
  loadGoogleOAuthEnv,
  loadImportApiEnv,
  loadImportWorkerEnv,
  loadIngressEnv,
  loadLineIngressEnv,
  loadLineWorkerEnv,
  loadSchedulerEnv,
  loadSlackInteractionsEnv,
  loadWorkerEnv,
} from "../src/config/env";
import {
  createImportUploadRequestSchema,
  createImportUploadResponseSchema,
  documentImportQueueMessageSchema,
  enqueueImportResponseSchema,
  ingestMarkdownRequestSchema,
  queueImportRequestSchema,
} from "../src/imports/contracts";
import {
  recurringTaskRecurrenceSchema,
  recurringTaskSchema,
} from "../src/tasks/recurringTask";
import {
  buildScheduledTaskPk,
  scheduledTaskSchema,
} from "../src/tasks/taskDefinition";
import { lineQueueMessageSchema, slackQueueMessageSchema } from "../src/shared/contracts";
import { Logger, logger } from "../src/shared/logger";

const originalEnv = process.env;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = originalEnv;
});

function withEnv(values: Record<string, string | undefined>) {
  process.env = {
    ...originalEnv,
    ...values,
  };
}

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
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
    SLACK_SIGNING_SECRET_SECRET_ID: "slack-signing",
    SLACK_BOT_TOKEN_SECRET_ID: "slack-token",
    AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:runtime",
    DEFAULT_SCHEDULE_CHANNEL: "CDEFAULT",
    ...overrides,
  };
}

function toolRuntimeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return baseEnv({
    CALENDAR_DRAFTS_TABLE_NAME: "calendar-drafts",
    GOOGLE_CALENDAR_SECRET_ID: "google-secret",
    GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: "google-connections",
    SOURCE_DOCUMENTS_TABLE_NAME: "sources",
    SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME: "slack-archive",
    DOCUMENT_ARCHIVE_BUCKET_NAME: "document-archive",
    DOCUMENT_IMPORT_QUEUE_URL: "https://sqs.local/import",
    ...overrides,
  });
}

describe("runtime contract schemas", () => {
  it("validates agent content blocks and response defaults", () => {
    expect(
      agentContentBlockSchema.parse({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "abc",
        },
      }),
    ).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "abc",
      },
    });
    expect(
      agentContentBlockSchema.parse({
        type: "document",
        title: "doc",
        source: {
          type: "file",
          file_id: "file-1",
        },
      }),
    ).toMatchObject({ type: "document" });

    expect(agentRuntimeResponseSchema.parse({ text: "ok" })).toEqual({
      text: "ok",
      taskIds: [],
      recurringTaskIds: [],
      savedMemoryIds: [],
      calendarDraftIds: [],
    });
  });

  it("validates agent runtime requests and maps resources from env", () => {
    expect(
      agentRuntimeRequestSchema.parse({
        content: [{ type: "text", text: "hello" }],
        context: {
          source: "test",
          workspaceId: "T1",
          custom: true,
        },
        toolContext: {
          workspaceId: "T1",
          memoryWritePolicy: {
            allowWorkspaceMemory: true,
            channelInferredStatus: "candidate",
            defaultOrigin: "imported",
          },
        },
      }),
    ).toMatchObject({
      context: { custom: true },
      toolContext: { memoryWritePolicy: { defaultOrigin: "imported" } },
    });

    expect(
      buildAgentRuntimeResources({
        MEMORY_ITEMS_TABLE_NAME: "memory",
        WORK_SESSIONS_TABLE_NAME: "work-sessions",
        TASK_TABLE_NAME: "scheduled",
        TASKS_TABLE_NAME: "tasks",
        TASK_EVENTS_TABLE_NAME: "events",
        RECURRING_TASKS_TABLE_NAME: "recurring",
        CALENDAR_DRAFTS_TABLE_NAME: "drafts",
        GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: "connections",
        GOOGLE_CALENDAR_SECRET_ID: "secret",
        GOOGLE_OAUTH_START_URL: "https://oauth/start",
        GOOGLE_CALENDAR_TIME_ZONE: "Asia/Tokyo",
        SCHEDULER_SCHEDULE_GROUP_NAME: "default",
        SCHEDULER_SCHEDULE_NAME_PREFIX: "serverless-agent",
        SCHEDULER_DEFAULT_TIME_ZONE: "Asia/Tokyo",
        SCHEDULER_TARGET_ARN: "arn:aws:lambda:target",
        SCHEDULER_TARGET_ROLE_ARN: "arn:aws:iam::123:role/scheduler",
        DEFAULT_RESPONSE_LANGUAGE: "ja",
        WEB_SEARCH_PROVIDER: "searxng",
        WEB_SEARCH_API_KEY_PARAMETER_NAME: "/example/serverless-agent/web-search-api-key",
        WEB_SEARCH_BASE_URL: "https://search.example.org",
        BROWSER_PROVIDER: "agentcore-browser",
        BROWSER_IDENTIFIER: "aws.browser.v1",
        SKILLS_TABLE_NAME: "skills",
        WORK_SESSION_IDLE_TIMEOUT_SECONDS: 900,
        WORK_SESSION_MAX_LIFETIME_SECONDS: 28_800,
        WORK_SESSION_MAX_ACTIVE_PER_OWNER: 2,
      }),
    ).toEqual({
      memoryItemsTableName: "memory",
      workSessionsTableName: "work-sessions",
      scheduledTasksTableName: "scheduled",
      tasksTableName: "tasks",
      taskEventsTableName: "events",
      recurringTasksTableName: "recurring",
      calendarDraftsTableName: "drafts",
      googleOAuthConnectionsTableName: "connections",
      googleCalendarSecretId: "secret",
      googleOAuthStartUrl: "https://oauth/start",
      googleCalendarTimeZone: "Asia/Tokyo",
      schedulerScheduleGroupName: "default",
      schedulerScheduleNamePrefix: "serverless-agent",
      schedulerDefaultTimeZone: "Asia/Tokyo",
      schedulerTargetArn: "arn:aws:lambda:target",
      schedulerTargetRoleArn: "arn:aws:iam::123:role/scheduler",
      defaultResponseLanguage: "ja",
      webSearchProvider: "searxng",
      webSearchApiKeyParameterName: "/example/serverless-agent/web-search-api-key",
      webSearchBaseUrl: "https://search.example.org",
      browserProvider: "agentcore-browser",
      browserIdentifier: "aws.browser.v1",
      skillsTableName: "skills",
      workSessionIdleTimeoutSeconds: 900,
      workSessionMaxLifetimeSeconds: 28_800,
      workSessionMaxActivePerOwner: 2,
    });
  });
});

describe("API contract schemas", () => {
  it("validates Slack queue messages and default files", () => {
    expect(
      slackQueueMessageSchema.parse({
        correlationId: "corr",
        eventId: "Ev1",
        workspaceId: "T1",
        channelId: "C1",
        conversationTs: "100",
        messageTs: "101",
        userId: "line:user:U1",
        text: "hello",
        source: "dm",
        contextScope: "channel_top_level",
        receivedAt: "now",
      }),
    ).toMatchObject({
      files: [],
    });
  });

  it("validates LINE queue messages", () => {
    expect(
      lineQueueMessageSchema.parse({
        correlationId: "corr",
        eventId: "line-event",
        workspaceId: "line:user:U1",
        providerAccountId: "Ubot",
        channelId: "line:user:U1",
        conversationTs: "line:user:U1",
        messageTs: "message-1",
        userId: "U1",
        text: "hello",
        replyToken: "reply",
        responseTargetId: "U1",
        responseTargetType: "user",
        source: "message",
        contextScope: "channel_top_level",
        receivedAt: "2026-05-18T00:00:00.000Z",
      }),
    ).toMatchObject({
      workspaceId: "line:user:U1",
      providerAccountId: "Ubot",
      responseTargetType: "user",
    });
  });

  it("validates chat request and response defaults", () => {
    expect(
      chatMessageRequestSchema.parse({
        workspaceId: "T1",
        userId: "U1",
        text: "hello",
      }),
    ).toEqual({
      workspaceId: "T1",
      userId: "U1",
      text: "hello",
    });
    expect(
      chatMessageResponseSchema.parse({
        ok: true,
        sessionId: "s1",
        text: "done",
      }),
    ).toEqual({
      ok: true,
      sessionId: "s1",
      text: "done",
      taskIds: [],
      recurringTaskIds: [],
      savedMemoryIds: [],
    });
  });

  it("validates import contracts and queue operation defaults", () => {
    expect(
      createImportUploadRequestSchema.parse({
        workspaceId: "T1",
        userId: "U1",
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        fileSize: 1,
        checksum: "sha",
      }),
    ).toMatchObject({ fileName: "doc.pdf" });
    expect(
      createImportUploadResponseSchema.parse({
        sourceId: "src1",
        uploadUrl: "https://upload.example",
        s3Bucket: "bucket",
        s3Key: "key",
        statusUrl: "/status/src1",
      }),
    ).toMatchObject({ sourceId: "src1" });
    expect(enqueueImportResponseSchema.parse({ ok: true, sourceId: "src1", statusUrl: "/s" })).toEqual({
      ok: true,
      sourceId: "src1",
      statusUrl: "/s",
    });
    expect(
      queueImportRequestSchema.parse({
        workspaceId: "T1",
        userId: "U1",
        sourceId: "src1",
      }),
    ).toMatchObject({ sourceId: "src1" });
    expect(
      ingestMarkdownRequestSchema.parse({
        workspaceId: "T1",
        userId: "U1",
        title: "Runbook",
        markdown: "# Runbook",
      }),
    ).toMatchObject({ title: "Runbook" });
    expect(
      documentImportQueueMessageSchema.parse({
        correlationId: "corr",
        workspaceId: "T1",
        userId: "U1",
        sourceId: "src1",
        queuedAt: "now",
      }),
    ).toMatchObject({ operation: "import" });
  });
});

describe("logger", () => {
  it("writes structured info, warn, error, and child log contexts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const child = new Logger({ requestId: "req" }).child({ workspaceId: "T1" });

    child.info("started", { step: 1 });
    child.warn("careful");
    child.error("failed", { error: "boom" });
    logger.info("root");

    expect(consoleLog.mock.calls.map(([line]) => JSON.parse(line as string))).toEqual([
      {
        timestamp: "2026-05-14T00:00:00.000Z",
        level: "INFO",
        message: "started",
        requestId: "req",
        workspaceId: "T1",
        step: 1,
      },
      {
        timestamp: "2026-05-14T00:00:00.000Z",
        level: "WARN",
        message: "careful",
        requestId: "req",
        workspaceId: "T1",
      },
      {
        timestamp: "2026-05-14T00:00:00.000Z",
        level: "ERROR",
        message: "failed",
        requestId: "req",
        workspaceId: "T1",
        error: "boom",
      },
      {
        timestamp: "2026-05-14T00:00:00.000Z",
        level: "INFO",
        message: "root",
      },
    ]);
  });
});

describe("task schemas", () => {
  it("validates scheduled tasks and builds DynamoDB keys", () => {
    expect(buildScheduledTaskPk("T1", "task-1")).toBe("WORKSPACE#T1#TASK#task-1");
    expect(
      scheduledTaskSchema.parse({
        taskId: "task-1",
        name: "Daily digest",
        prompt: "Summarize",
        workspaceId: "T1",
        outputChannelId: "C1",
        enabled: true,
        scheduleName: "serverless-agent-task-1",
        scheduleExpression: "cron(0 8 * * ? *)",
        scheduleExpressionTimezone: "Asia/Tokyo",
        createdAt: "2026-05-14T00:00:00Z",
        updatedAt: "2026-05-14T00:00:00Z",
      }),
    ).toMatchObject({
      reuseSession: false,
      scheduleName: "serverless-agent-task-1",
      scheduleExpressionTimezone: "Asia/Tokyo",
    });
  });

  it("validates recurring task defaults and bounds", () => {
    expect(recurringTaskRecurrenceSchema.parse({ frequency: "weekly" })).toEqual({
      frequency: "weekly",
      interval: 1,
    });
    expect(() =>
      recurringTaskRecurrenceSchema.parse({ frequency: "monthly", daysOfMonth: [32] }),
    ).toThrow();
    expect(
      recurringTaskSchema.parse({
        recurringTaskId: "rt1",
        workspaceId: "T1",
        title: "Follow up",
        recurrence: { frequency: "daily" },
        createdAt: "created",
        updatedAt: "updated",
      }),
    ).toMatchObject({
      dueTime: "23:59",
      timezone: "Asia/Tokyo",
      enabled: true,
    });
  });
});

describe("environment loaders", () => {
  it("loads ingress and applies numeric defaults", () => {
    withEnv(baseEnv({ SLACK_QUEUE_URL: "https://sqs.local/slack" }));

    expect(loadIngressEnv()).toMatchObject({
      EVENT_DEDUP_TTL_SECONDS: 86400,
      AGENT_RESPONSE_TIMEOUT_MS: 120000,
      TOP_LEVEL_CONTEXT_TURN_LIMIT: 10,
      MAX_SLACK_FILE_BYTES: 10_000_000,
      WORK_SESSION_IDLE_TIMEOUT_SECONDS: 900,
      WORK_SESSION_MAX_LIFETIME_SECONDS: 28_800,
      WORK_SESSION_MAX_ACTIVE_PER_OWNER: 2,
      AGENTCORE_RUNTIME_QUALIFIER: "",
      SLACK_QUEUE_URL: "https://sqs.local/slack",
    });
  });

  it("loads LINE ingress and worker env variants", () => {
    withEnv({
      ...toolRuntimeEnv(),
      LINE_CHANNEL_SECRET_SECRET_ID: "line-secret",
      LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: "line-token",
      LINE_QUEUE_URL: "https://sqs.local/line",
    });

    expect(loadLineIngressEnv()).toMatchObject({
      LINE_CHANNEL_SECRET_SECRET_ID: "line-secret",
      LINE_QUEUE_URL: "https://sqs.local/line",
      TOP_LEVEL_CONTEXT_TURN_LIMIT: 10,
    });
    expect(loadLineWorkerEnv()).toMatchObject({
      LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID: "line-token",
      CALENDAR_DRAFTS_TABLE_NAME: "calendar-drafts",
    });
  });

  it("loads worker and tool runtime env variants", () => {
    withEnv(toolRuntimeEnv({ GOOGLE_OAUTH_START_URL: "https://oauth/start" }));

    expect(loadWorkerEnv()).toMatchObject({
      SOURCE_DOCUMENTS_TABLE_NAME: "sources",
      SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME: "slack-archive",
      GOOGLE_CALENDAR_TIME_ZONE: "Asia/Tokyo",
    });
    expect(loadImportWorkerEnv()).toMatchObject({
      DOCUMENT_ARCHIVE_BUCKET_NAME: "document-archive",
    });
    expect(loadChatApiEnv()).toMatchObject({
      CALENDAR_DRAFTS_TABLE_NAME: "calendar-drafts",
    });
    expect(loadSchedulerEnv()).toMatchObject({
      RECURRING_TASKS_TABLE_NAME: "recurring-tasks",
    });
    expect(loadSlackInteractionsEnv()).toMatchObject({
      GOOGLE_OAUTH_START_URL: "https://oauth/start",
    });
  });

  it("loads import api and google oauth env variants", () => {
    withEnv(toolRuntimeEnv({ GOOGLE_CALENDAR_TIME_ZONE: "UTC" }));

    expect(loadImportApiEnv()).toMatchObject({
      DOCUMENT_IMPORT_QUEUE_URL: "https://sqs.local/import",
      DOCUMENT_ARCHIVE_BUCKET_NAME: "document-archive",
    });
    expect(loadGoogleOAuthEnv()).toMatchObject({
      GOOGLE_CALENDAR_SECRET_ID: "google-secret",
      GOOGLE_CALENDAR_TIME_ZONE: "UTC",
    });
  });

  it("throws when required env is missing", () => {
    withEnv({ ...baseEnv(), SLACK_QUEUE_URL: "" });

    expect(() => loadIngressEnv()).toThrow();
  });
});

describe("Google OAuth helpers", () => {
  it("parses secret key variants and rejects incomplete secrets", () => {
    expect(
      parseGoogleOAuthClientConfig(
        JSON.stringify({
          client_id: "cid",
          client_secret: "secret",
        }),
      ),
    ).toEqual({ clientId: "cid", clientSecret: "secret" });
    expect(
      parseGoogleOAuthClientConfig(
        JSON.stringify({
          clientId: "cid2",
          clientSecret: "secret2",
        }),
      ),
    ).toEqual({ clientId: "cid2", clientSecret: "secret2" });
    expect(() => parseGoogleOAuthClientConfig(JSON.stringify({ client_id: "cid" }))).toThrow();
  });

  it("builds authorization URLs with expected scopes and state", () => {
    const url = new URL(
      buildGoogleAuthorizationUrl({
        config: { clientId: "cid", clientSecret: "secret" },
        redirectUri: "https://app.example/callback",
        state: "state-token",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("state")).toBe("state-token");
  });

  it("signs, verifies, rejects tampered, and rejects expired OAuth state tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const token = createGoogleOAuthState({ workspaceId: "T1", userId: "U1" }, "signing");

    expect(verifyGoogleOAuthState(token, "signing")).toMatchObject({
      workspaceId: "T1",
      userId: "U1",
    });
    expect(() => verifyGoogleOAuthState(`${token}x`, "signing")).toThrow("signature");

    vi.setSystemTime(new Date("2026-05-14T00:11:00Z"));
    expect(() => verifyGoogleOAuthState(token, "signing")).toThrow("expired");
    expect(() => verifyGoogleOAuthState("not-valid", "signing")).toThrow("Invalid OAuth state");
  });

  it("exchanges codes and fetches user info through fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "sub", email: "u@example.com" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeGoogleAuthorizationCode({
        config: { clientId: "cid", clientSecret: "secret" },
        redirectUri: "https://app.example/callback",
        code: "code",
      }),
    ).resolves.toEqual({ access_token: "access" });
    await expect(fetchGoogleUserInfo("access")).resolves.toEqual({
      sub: "sub",
      email: "u@example.com",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://openidconnect.googleapis.com/v1/userinfo",
      expect.objectContaining({
        headers: {
          authorization: "Bearer access",
        },
      }),
    );
  });

  it("surfaces Google OAuth HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("bad", { status: 400, statusText: "Bad Request" }))
        .mockResolvedValueOnce(new Response("bad", { status: 401, statusText: "Unauthorized" })),
    );

    await expect(
      exchangeGoogleAuthorizationCode({
        config: { clientId: "cid", clientSecret: "secret" },
        redirectUri: "https://app.example/callback",
        code: "code",
      }),
    ).rejects.toThrow("token exchange failed");
    await expect(fetchGoogleUserInfo("bad-token")).rejects.toThrow("userinfo request failed");
  });
});
