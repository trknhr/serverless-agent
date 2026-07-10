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
  vi.useRealTimers();
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
    const { AgentCoreRuntimeClient } = await import("../src/agentcore/client");

    await handler({
      taskId: "morning",
      workspaceId: "T1",
    });

    expect(AgentCoreRuntimeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        responseTimeoutMs: 120000,
      }),
    );
    const agentRequestText = mocks.agentInvoke.mock.calls[0][0].request.content[0].text;
    expect(agentRequestText).toContain("Only include facts, reminders, dates, tasks, events, and notes that are present in tool results");
    expect(agentRequestText).toContain("If the prompt asks for a memo or note and no grounded item is available, omit that section");
    expect(mocks.agentInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          context: expect.objectContaining({
            channelId: "C1",
          }),
          toolContext: expect.objectContaining({
            channelId: "C1",
            memoryWritePolicy: {
              allowWorkspaceMemory: false,
              channelInferredStatus: "candidate",
              defaultOrigin: "inferred",
            },
          }),
        }),
      }),
    );
    expect(mocks.slackPostMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "*リマインダー:* Morning Reminder\n\nToday's reminder.",
    });
    expect(mocks.linePushText).not.toHaveBeenCalled();
  });

  it("materializes yearly preparation and day-of task instances", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-05-02T00:00:00+09:00"));
    mocks.documentSend.mockImplementation(async (command) => {
      const input = command.input as Record<string, any>;
      if (input.TableName === "task_table_name" && input.Key) {
        return {
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
        };
      }
      if (input.TableName === "recurring_tasks_table_name" && input.KeyConditionExpression) {
        return {
          Items: [
            {
              pk: "WORKSPACE#T1",
              sk: "RECURRING_TASK#rt_mothers_day",
              recurringTaskId: "rt_mothers_day",
              workspaceId: "T1",
              title: "母の日プレゼント準備",
              description: "プレゼント検討・購入・配送手続き",
              recurrence: {
                frequency: "yearly",
                interval: 1,
                monthOfYear: 5,
                daysOfWeek: ["sunday"],
                weekOfMonth: 2,
              },
              leadTimeDays: 7,
              dayOfTask: {
                enabled: true,
                title: "母の日当日メッセージ",
                dueTime: "09:00",
              },
              dueTime: "23:59",
              timezone: "Asia/Tokyo",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        };
      }
      if (input.KeyConditionExpression || input.IndexName) {
        return { Items: [] };
      }
      return {};
    });
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
    await handler({ taskId: "morning", workspaceId: "T1" });

    const taskPuts = mocks.documentSend.mock.calls
      .map(([command]) => command.input as Record<string, any>)
      .filter((input) => input.TableName === "tasks_table_name" && input.Item?.sourceType === "recurring_task");
    expect(taskPuts).toHaveLength(2);
    expect(taskPuts.map((input) => input.Item)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "母の日プレゼント準備",
          dueAt: "2027-05-02T23:59:00+09:00",
          metadata: expect.objectContaining({
            eventDate: "2027-05-09",
            dueDate: "2027-05-02",
            materializationKind: "primary",
            leadTimeDays: 7,
          }),
        }),
        expect.objectContaining({
          title: "母の日当日メッセージ",
          dueAt: "2027-05-09T09:00:00+09:00",
          metadata: expect.objectContaining({
            eventDate: "2027-05-09",
            dueDate: "2027-05-09",
            materializationKind: "day_of",
            leadTimeDays: 0,
          }),
        }),
      ]),
    );
  });

  it("refreshes an open recurring instance when its lead-time deadline changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-05-02T00:00:00+09:00"));
    mocks.documentSend.mockImplementation(async (command) => {
      const input = command.input as Record<string, any>;
      if (input.TableName === "task_table_name" && input.Key) {
        return {
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
        };
      }
      if (input.TableName === "recurring_tasks_table_name" && input.KeyConditionExpression) {
        return {
          Items: [
            {
              recurringTaskId: "rt_mothers_day",
              workspaceId: "T1",
              title: "母の日プレゼント準備",
              recurrence: {
                frequency: "yearly",
                interval: 1,
                monthOfYear: 5,
                daysOfWeek: ["sunday"],
                weekOfMonth: 2,
              },
              leadTimeDays: 7,
              dueTime: "23:59",
              timezone: "Asia/Tokyo",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-07-10T00:00:00.000Z",
            },
          ],
        };
      }
      if (
        input.TableName === "tasks_table_name" &&
        input.Key?.sk?.startsWith("TASK#")
      ) {
        const taskId = String(input.Key.sk).slice("TASK#".length);
        return {
          Item: {
            workspaceId: "T1",
            taskId,
            title: "母の日プレゼント準備",
            status: "open",
            dueAt: "2027-05-09T23:59:00+09:00",
            sourceType: "recurring_task",
            sourceRef: "rt_mothers_day",
            metadata: {
              recurringTaskId: "rt_mothers_day",
              occurrenceDate: "2027-05-09",
            },
            createdAt: "2027-04-25T00:00:00.000Z",
            updatedAt: "2027-04-25T00:00:00.000Z",
          },
        };
      }
      if (input.KeyConditionExpression || input.IndexName) {
        return { Items: [] };
      }
      return {};
    });
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
    await handler({ taskId: "morning", workspaceId: "T1" });

    const refreshed = mocks.documentSend.mock.calls
      .map(([command]) => command.input as Record<string, any>)
      .find(
        (input) =>
          input.TableName === "tasks_table_name" &&
          input.Item?.sourceType === "recurring_task" &&
          input.Item?.metadata?.materializationKind === "primary",
      );
    expect(refreshed?.Item).toMatchObject({
      status: "open",
      dueAt: "2027-05-02T23:59:00+09:00",
      metadata: {
        recurringTaskId: "rt_mothers_day",
        occurrenceDate: "2027-05-09",
        eventDate: "2027-05-09",
        dueDate: "2027-05-02",
        materializationKind: "primary",
        leadTimeDays: 7,
      },
    });
    const updateEvent = mocks.documentSend.mock.calls
      .map(([command]) => command.input as Record<string, any>)
      .find(
        (input) =>
          input.TableName === "task_events_table_name" && input.Item?.type === "updated",
      );
    expect(updateEvent).toBeDefined();
  });

  it("passes the scheduled reminder creator as the agent user context", async () => {
    mocks.documentSend
      .mockResolvedValueOnce({
        Item: {
          taskId: "morning",
          name: "Morning Reminder",
          prompt: "Post today's reminder.",
          workspaceId: "T1",
          outputChannelId: "C1",
          enabled: true,
          createdByUserId: "UCREATOR",
          updatedByUserId: "UCREATOR",
          reuseSession: false,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
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

    expect(mocks.agentInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeUserId: "UCREATOR",
        request: expect.objectContaining({
          context: expect.objectContaining({
            userId: "UCREATOR",
          }),
          toolContext: expect.objectContaining({
            userId: "UCREATOR",
          }),
        }),
      }),
    );
  });

  it("stores scheduled Slack reminders as thread context for follow-up replies", async () => {
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
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValue({});
    mocks.agentInvoke.mockResolvedValueOnce({
      text: "Today's reminder.\nSecond line.",
      sessionId: "agent-session",
      status: "completed",
      taskIds: [],
      recurringTaskIds: [],
      savedMemoryIds: [],
      calendarDraftIds: [],
    });
    mocks.slackPostMessage.mockResolvedValueOnce({ ts: "200.123" });

    const { handler } = await import("../src/functions/scheduled-agent-runner");

    await handler({
      taskId: "morning",
      workspaceId: "T1",
    });

    expect(mocks.documentSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "conversation_sessions_table_name",
          Item: expect.objectContaining({
            pk: "WORKSPACE#T1#CHANNEL#C1",
            sk: "CONVERSATION#200.123",
            created_at: expect.any(String),
            last_used_at: expect.any(String),
          }),
        }),
      }),
    );
    expect(mocks.documentSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "conversation_turns_table_name",
          Item: expect.objectContaining({
            pk: "WORKSPACE#T1#CHANNEL#C1#CONVERSATION#200.123",
            context_scope: "thread",
            role: "assistant",
            source_event: "scheduled_reminder",
            thread_ts: "200.123",
            message_ts: "200.123",
            turn_ts: "200.123",
            text: "*リマインダー:* Morning Reminder\n\nToday's reminder.\nSecond line.",
          }),
        }),
      }),
    );
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

  it("does not send scheduled reminders after the daily workspace limit is exhausted", async () => {
    mocks.documentSend
      .mockResolvedValueOnce({
        Item: {
          taskId: "morning",
          name: "Morning Reminder",
          prompt: "Post today's reminder.",
          workspaceId: "ws_1",
          outputChannelId: "C1",
          enabled: true,
          reuseSession: false,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });
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

    expect(mocks.linePushText).not.toHaveBeenCalled();
    expect(mocks.slackPostMessage).not.toHaveBeenCalled();
  });
});
