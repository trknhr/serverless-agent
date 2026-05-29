import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentInvoke: vi.fn(),
  documentSend: vi.fn(),
  linePushText: vi.fn(),
  slackPostMessage: vi.fn(),
}));

vi.mock("../src/agentcore/client", () => ({
  AgentCoreRuntimeClient: vi.fn().mockImplementation(function AgentCoreRuntimeClient() {
    return {
      invoke: mocks.agentInvoke,
    };
  }),
}));

vi.mock("../src/line/postMessage", () => ({
  LineMessagingClient: vi.fn().mockImplementation(function LineMessagingClient() {
    return {
      pushText: mocks.linePushText,
    };
  }),
}));

vi.mock("../src/repo/documentClient", () => ({
  documentClient: {
    send: mocks.documentSend,
  },
}));

vi.mock("../src/slack/postMessage", () => ({
  SlackWebClient: vi.fn().mockImplementation(function SlackWebClient() {
    return {
      postMessage: mocks.slackPostMessage,
    };
  }),
}));

const envKeys = [
  "SESSION_TABLE_NAME",
  "CONVERSATION_SESSIONS_TABLE_NAME",
  "WORK_SESSIONS_TABLE_NAME",
  "CONVERSATION_TURNS_TABLE_NAME",
  "USER_MEMORY_TABLE_NAME",
  "MEMORY_ITEMS_TABLE_NAME",
  "TASKS_TABLE_NAME",
  "TASK_EVENTS_TABLE_NAME",
  "RECURRING_TASKS_TABLE_NAME",
  "PROVIDER_BINDINGS_TABLE_NAME",
  "PROCESSED_EVENTS_TABLE_NAME",
  "TASK_TABLE_NAME",
  "AGENTCORE_RUNTIME_ARN",
  "AGENTCORE_RUNTIME_QUALIFIER",
  "DEFAULT_SCHEDULE_CHANNEL",
  "SLACK_SIGNING_SECRET_SECRET_ID",
  "SLACK_BOT_TOKEN_SECRET_ID",
  "CALENDAR_DRAFTS_TABLE_NAME",
  "GOOGLE_CALENDAR_SECRET_ID",
  "GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME",
  "GOOGLE_CALENDAR_TIME_ZONE",
  "LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID",
] as const;

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  mocks.agentInvoke.mockReset();
  mocks.documentSend.mockReset();
  mocks.linePushText.mockReset();
  mocks.slackPostMessage.mockReset();

  for (const key of envKeys) {
    process.env[key] = key.toLowerCase();
  }
  process.env.AGENTCORE_RUNTIME_ARN = "arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/test";
  process.env.AGENTCORE_RUNTIME_QUALIFIER = "";
  process.env.DEFAULT_SCHEDULE_CHANNEL = "CDEFAULT";
  process.env.GOOGLE_CALENDAR_TIME_ZONE = "Asia/Tokyo";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("scheduled agent runner", () => {
  it("keeps scheduled Slack reminders on Slack", async () => {
    mocks.documentSend
      .mockResolvedValueOnce({
        Item: {
          taskId: "morning",
          name: "Morning Reminder",
          prompt: "Post today's reminder.",
          workspaceId: "T1",
          outputChannelId: "C1",
          enabled: true,
          reuseSession: false,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] });
    mocks.agentInvoke.mockResolvedValueOnce({
      text: "Today's reminder.",
      sessionId: "agent-session",
      status: "completed",
      taskIds: [],
      recurringTaskIds: [],
      savedMemoryIds: [],
      calendarDraftIds: [],
    });

    const { handler } = await import("../src/functions/scheduled-agent-runner");

    await handler({
      taskId: "morning",
      workspaceId: "T1",
    });

    expect(mocks.slackPostMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "*リマインダー:* Morning Reminder\n\nToday's reminder.",
    });
    expect(mocks.linePushText).not.toHaveBeenCalled();
  });

  it("posts scheduled LINE reminders back to the LINE conversation", async () => {
    mocks.documentSend
      .mockResolvedValueOnce({
        Item: {
          taskId: "morning",
          name: "Morning Reminder",
          prompt: "Post today's reminder.",
          workspaceId: "ws_1",
          outputChannelId: "line:group:G1",
          enabled: true,
          reuseSession: false,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] });
    mocks.agentInvoke.mockResolvedValueOnce({
      text: "今日の予定です。",
      sessionId: "agent-session",
      status: "completed",
      taskIds: [],
      recurringTaskIds: [],
      savedMemoryIds: [],
      calendarDraftIds: [],
    });

    const { handler } = await import("../src/functions/scheduled-agent-runner");

    await handler({
      taskId: "morning",
      workspaceId: "ws_1",
    });

    expect(mocks.linePushText).toHaveBeenCalledWith(
      "G1",
      "リマインダー: Morning Reminder\n\n今日の予定です。",
    );
    expect(mocks.slackPostMessage).not.toHaveBeenCalled();
  });
});
