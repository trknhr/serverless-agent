import type { APIGatewayProxyEvent } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendMock, invokeMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("../src/repo/documentClient", () => ({
  documentClient: {
    send: sendMock,
  },
}));

vi.mock("../src/agentcore/client", () => ({
  AgentCoreRuntimeClient: vi.fn().mockImplementation(function AgentCoreRuntimeClient() {
    return {
    invoke: invokeMock,
    };
  }),
}));

const originalEnv = { ...process.env };

function chatApiEnv(): NodeJS.ProcessEnv {
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
    TASK_TABLE_NAME: "legacy-tasks",
    AGENTCORE_RUNTIME_ARN: "arn:aws:bedrock-agentcore:ap-northeast-1:123:runtime/test",
    AGENTCORE_RUNTIME_QUALIFIER: "DEFAULT",
    DEFAULT_SCHEDULE_CHANNEL: "C_DEFAULT",
    SLACK_SIGNING_SECRET_SECRET_ID: "slack-signing",
    SLACK_BOT_TOKEN_SECRET_ID: "slack-bot",
    CALENDAR_DRAFTS_TABLE_NAME: "calendar-drafts",
    GOOGLE_CALENDAR_SECRET_ID: "google-calendar",
    GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME: "google-oauth",
    SKILLS_TABLE_NAME: "skills",
  };
}

function baseEvent(overrides: Partial<APIGatewayProxyEvent>): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: "GET",
    isBase64Encoded: false,
    path: "/",
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: "/",
    requestContext: {
      accountId: "123",
      apiId: "api",
      authorizer: {},
      protocol: "HTTP/1.1",
      httpMethod: "GET",
      identity: {} as never,
      path: "/",
      stage: "prod",
      requestId: "req-1",
      requestTimeEpoch: 0,
      resourceId: "res",
      resourcePath: "/",
    },
    ...overrides,
  };
}

async function loadHandler() {
  vi.resetModules();
  process.env = chatApiEnv();
  return await import("../src/functions/chat-api/index");
}

afterEach(() => {
  sendMock.mockReset();
  invokeMock.mockReset();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("chat admin skill API", () => {
  it("lists builtin skills with override audit state", async () => {
    const { handler } = await loadHandler();
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          skillId: "web-research",
          enabled: false,
          updatedAt: "updated",
          updatedByUserId: "U1",
          previousEnabled: true,
        },
      ],
    });

    const response = await handler(
      baseEvent({
        httpMethod: "GET",
        resource: "/admin/workspaces/{workspaceId}/builtin-skills",
        pathParameters: { workspaceId: "T1" },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      skills: expect.arrayContaining([
        expect.objectContaining({
          skillId: "web-research",
          source: "builtin",
          enabled: false,
          status: "disabled",
          audit: {
            updatedAt: "updated",
            updatedByUserId: "U1",
            previousEnabled: true,
          },
        }),
      ]),
    });
  });

  it("updates builtin skill enablement", async () => {
    const { handler } = await loadHandler();
    sendMock.mockResolvedValueOnce({});
    sendMock.mockResolvedValueOnce({});

    const response = await handler(
      baseEvent({
        httpMethod: "PATCH",
        resource: "/admin/workspaces/{workspaceId}/builtin-skills/{skillId}",
        pathParameters: { workspaceId: "T1", skillId: "web-research" },
        body: JSON.stringify({ enabled: false, actorUserId: "U1" }),
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      skill: {
        skillId: "web-research",
        enabled: false,
        status: "disabled",
      },
      audit: {
        actorUserId: "U1",
        previousEnabled: true,
        nextEnabled: false,
      },
    });
  });

  it("returns 404 for missing builtin skill", async () => {
    const { handler } = await loadHandler();
    const response = await handler(
      baseEvent({
        httpMethod: "PATCH",
        resource: "/admin/workspaces/{workspaceId}/builtin-skills/{skillId}",
        pathParameters: { workspaceId: "T1", skillId: "not-real" },
        body: JSON.stringify({ enabled: true, actorUserId: "U1" }),
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("returns 400 for invalid admin request bodies", async () => {
    const { handler } = await loadHandler();
    const response = await handler(
      baseEvent({
        httpMethod: "PATCH",
        resource: "/admin/workspaces/{workspaceId}/builtin-skills/{skillId}",
        pathParameters: { workspaceId: "T1", skillId: "web-research" },
        body: JSON.stringify({ enabled: "yes" }),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: "bad_request",
    });
  });
});
