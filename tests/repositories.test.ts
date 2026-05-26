import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarDraftRepository } from "../src/repo/calendarDraftRepository";
import { ChannelMemoryRepository } from "../src/repo/channelMemoryRepository";
import { ConversationSessionRepository } from "../src/repo/conversationSessionRepository";
import { ConversationTurnRepository } from "../src/repo/conversationTurnRepository";
import { EventDedupRepository } from "../src/repo/eventDedupRepository";
import { GoogleOAuthConnectionRepository } from "../src/repo/googleOAuthConnectionRepository";
import { MemoryItemRepository } from "../src/repo/memoryItemRepository";
import { ProviderBindingRepository } from "../src/repo/providerBindingRepository";
import { RecurringTaskRepository } from "../src/repo/recurringTaskRepository";
import { SessionRepository } from "../src/repo/sessionRepository";
import { SourceDocumentRepository } from "../src/repo/sourceDocumentRepository";
import { TaskEventRepository } from "../src/repo/taskEventRepository";
import { TaskRepository } from "../src/repo/taskRepository";
import { TaskStateRepository } from "../src/repo/taskStateRepository";
import { UserMemoryRepository } from "../src/repo/userMemoryRepository";
import { UserPreferenceRepository } from "../src/repo/userPreferenceRepository";
import { WorkSessionRepository } from "../src/repo/workSessionRepository";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("../src/repo/documentClient", () => ({
  documentClient: {
    send: sendMock,
  },
}));

afterEach(() => {
  sendMock.mockReset();
  vi.useRealTimers();
});

function commandInput(callIndex = 0): Record<string, unknown> {
  return sendMock.mock.calls[callIndex][0].input;
}

describe("basic DynamoDB repositories", () => {
  it("marks events processed and handles duplicate conditional failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new EventDedupRepository("events");

    sendMock.mockResolvedValueOnce({});
    await expect(repo.markProcessed("Ev1", 60)).resolves.toBe(true);
    expect(commandInput()).toMatchObject({
      TableName: "events",
      Item: {
        pk: "EVENT#Ev1",
        created_at: "2026-05-14T00:00:00.000Z",
        ttl: 1778716860,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    });

    sendMock.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });
    await expect(repo.markProcessed("Ev1", 60)).resolves.toBe(false);

    sendMock.mockRejectedValueOnce(new Error("boom"));
    await expect(repo.markProcessed("Ev2", 60)).rejects.toThrow("boom");
  });

  it("finds and saves legacy thread sessions", async () => {
    const repo = new SessionRepository("sessions");
    sendMock.mockResolvedValueOnce({
      Item: {
        session_id: "session",
        memory_store_id: "memory",
        created_at: "created",
        last_used_at: "last",
      },
    });

    await expect(repo.findByThread("T1", "C1", "123.4")).resolves.toEqual({
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "123.4",
      sessionId: "session",
      memoryStoreId: "memory",
      createdAt: "created",
      lastUsedAt: "last",
    });
    expect(commandInput()).toMatchObject({
      TableName: "sessions",
      Key: {
        pk: "WORKSPACE#T1#CHANNEL#C1",
        sk: "THREAD#123.4",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "123.4",
      sessionId: "session",
      memoryStoreId: "memory",
      createdAt: "created",
      lastUsedAt: "last",
    });
    expect(commandInput(1)).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1#CHANNEL#C1",
        sk: "THREAD#123.4",
        session_id: "session",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await expect(repo.findByThread("T1", "C1", "missing")).resolves.toBeNull();
  });

  it("finds and saves conversation sessions", async () => {
    const repo = new ConversationSessionRepository("sessions");
    sendMock.mockResolvedValueOnce({
      Item: {
        agent_runtime_session_id: "agent-session",
        memory_store_id: "memory",
        created_at: "created",
        last_used_at: "last",
      },
    });

    await expect(repo.findByConversation("T1", "C1", "171")).resolves.toEqual({
      workspaceId: "T1",
      channelId: "C1",
      conversationTs: "171",
      agentRuntimeSessionId: "agent-session",
      memoryStoreId: "memory",
      createdAt: "created",
      lastUsedAt: "last",
    });

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      channelId: "C1",
      conversationTs: "171",
      agentRuntimeSessionId: "agent-session",
      memoryStoreId: "memory",
      createdAt: "created",
      lastUsedAt: "last",
    });

    expect(commandInput(1)).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1#CHANNEL#C1",
        sk: "CONVERSATION#171",
        agent_runtime_session_id: "agent-session",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await expect(repo.findByConversation("T1", "C1", "missing")).resolves.toBeNull();
  });

  it("resolves provider workspace bindings with conversation, installation, and fallback order", async () => {
    const repo = new ProviderBindingRepository("provider-bindings");
    sendMock.mockResolvedValueOnce({});

    await repo.save({
      provider: "line",
      providerAccountId: "Ubot",
      bindingKind: "conversation",
      providerConversationKey: "group:G1",
      workspaceId: "ws_group",
      conversationId: "line:group:G1",
      status: "active",
      createdAt: "created",
      updatedAt: "updated",
    });
    expect(commandInput()).toMatchObject({
      TableName: "provider-bindings",
      Item: {
        pk: "PROVIDER#line#ACCOUNT#Ubot",
        sk: "CONVERSATION#group:G1",
        workspaceId: "ws_group",
        conversationId: "line:group:G1",
      },
    });

    sendMock.mockResolvedValueOnce({
      Item: {
        provider: "line",
        providerAccountId: "Ubot",
        bindingKind: "conversation",
        providerConversationKey: "group:G1",
        workspaceId: "ws_group",
        conversationId: "line:group:G1",
        status: "active",
        createdAt: "created",
        updatedAt: "updated",
      },
    });
    await expect(
      repo.resolveWorkspace({
        provider: "line",
        providerAccountId: "Ubot",
        providerConversationKey: "group:G1",
        fallbackWorkspaceId: "line:group:G1",
      }),
    ).resolves.toEqual({
      workspaceId: "ws_group",
      source: "conversation_binding",
    });

    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Item: {
        provider: "line",
        providerAccountId: "Ubot",
        bindingKind: "installation",
        workspaceId: "ws_install",
        status: "active",
        createdAt: "created",
        updatedAt: "updated",
      },
    });
    await expect(
      repo.resolveWorkspace({
        provider: "line",
        providerAccountId: "Ubot",
        providerConversationKey: "room:R1",
        fallbackWorkspaceId: "line:room:R1",
      }),
    ).resolves.toEqual({
      workspaceId: "ws_install",
      source: "installation_binding",
    });

    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await expect(
      repo.resolveWorkspace({
        provider: "line",
        providerAccountId: "Ubot",
        providerConversationKey: "user:U1",
        fallbackWorkspaceId: "line:user:U1",
      }),
    ).resolves.toEqual({
      workspaceId: "line:user:U1",
      source: "fallback",
    });

    sendMock.mockResolvedValueOnce({
      Item: {
        provider: "line",
        providerAccountId: "Ubot",
        bindingKind: "conversation",
        providerConversationKey: "group:G2",
        workspaceId: "ws_disabled",
        status: "disabled",
        createdAt: "created",
        updatedAt: "updated",
      },
    });
    await expect(
      repo.resolveWorkspace({
        provider: "line",
        providerAccountId: "Ubot",
        providerConversationKey: "group:G2",
        fallbackWorkspaceId: "line:group:G2",
      }),
    ).resolves.toBeNull();
  });

  it("finds and saves user memory records", async () => {
    const repo = new UserMemoryRepository("memory");
    sendMock.mockResolvedValueOnce({
      Item: {
        memory_store_id: "store",
        profile_summary: "summary",
        created_at: "created",
        updated_at: "updated",
      },
    });

    await expect(repo.find("T1", "U1")).resolves.toEqual({
      workspaceId: "T1",
      userId: "U1",
      memoryStoreId: "store",
      profileSummary: "summary",
      createdAt: "created",
      updatedAt: "updated",
    });

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      userId: "U1",
      memoryStoreId: "store",
      profileSummary: "summary",
      createdAt: "created",
      updatedAt: "updated",
    });
    expect(commandInput(1)).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1#USER#U1",
        memory_store_id: "store",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await expect(repo.find("T1", "U2")).resolves.toBeNull();
  });

  it("creates, lists, and expires owner-scoped work sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    const repo = new WorkSessionRepository("work-sessions");

    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.create({
        workspaceId: "T1",
        ownerUserId: "U1",
        kind: "browser",
        workSessionId: "ws1",
        runtimeSessionId: "runtime1",
        maxLifetimeSeconds: 28_800,
      }),
    ).resolves.toMatchObject({
      workspaceId: "T1",
      ownerUserId: "U1",
      workSessionId: "ws1",
      runtimeSessionId: "runtime1",
      kind: "browser",
      status: "active",
      createdAt: "2026-05-25T00:00:00.000Z",
      lastUsedAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T08:00:00.000Z",
    });
    expect(commandInput()).toMatchObject({
      TableName: "work-sessions",
      Item: {
        pk: "WORKSPACE#T1#OWNER#U1",
        sk: "KIND#browser#WORK_SESSION#ws1",
        ttl: 1779696000,
      },
    });

    sendMock.mockResolvedValueOnce({
      Item: workSessionItem("ws1", "runtime1", "browser", "active", "2026-05-25T00:00:00.000Z"),
    });
    await expect(
      repo.get({
        workspaceId: "T1",
        ownerUserId: "U1",
        kind: "browser",
        workSessionId: "ws1",
      }),
    ).resolves.toMatchObject({
      workSessionId: "ws1",
      runtimeSessionId: "runtime1",
    });
    expect(commandInput(1)).toMatchObject({
      Key: {
        pk: "WORKSPACE#T1#OWNER#U1",
        sk: "KIND#browser#WORK_SESSION#ws1",
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        workSessionItem("older", "runtime-old", "browser", "active", "2026-05-25T00:05:00.000Z"),
        workSessionItem("newer", "runtime-new", "browser", "active", "2026-05-25T00:10:00.000Z"),
      ],
    });
    await expect(
      repo.listActiveByOwner({
        workspaceId: "T1",
        ownerUserId: "U1",
        kind: "browser",
        now: new Date("2026-05-25T00:12:00.000Z"),
      }),
    ).resolves.toMatchObject([{ workSessionId: "newer" }, { workSessionId: "older" }]);
    expect(commandInput(2)).toMatchObject({
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
      FilterExpression: "#status = :active AND expiresAt > :now",
      ExpressionAttributeValues: {
        ":pk": "WORKSPACE#T1#OWNER#U1",
        ":skPrefix": "KIND#browser#",
        ":active": "active",
        ":now": "2026-05-25T00:12:00.000Z",
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        workSessionItem("idle", "runtime-idle", "browser", "active", "2026-05-25T00:00:00.000Z"),
        workSessionItem("fresh", "runtime-fresh", "browser", "active", "2026-05-25T00:10:00.000Z"),
      ],
    });
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.expireIdleSessions({
        workspaceId: "T1",
        ownerUserId: "U1",
        kind: "browser",
        idleTimeoutSeconds: 900,
        now: new Date("2026-05-25T00:20:00.000Z"),
      }),
    ).resolves.toMatchObject([{ workSessionId: "idle" }]);
    expect(commandInput(4)).toMatchObject({
      Key: {
        pk: "WORKSPACE#T1#OWNER#U1",
        sk: "KIND#browser#WORK_SESSION#idle",
      },
      UpdateExpression: "SET #status = :status, lastUsedAt = :lastUsedAt",
      ExpressionAttributeValues: {
        ":status": "expired",
        ":lastUsedAt": "2026-05-25T00:20:00.000Z",
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        workSessionItem("newest", "runtime-newest", "browser", "active", "2026-05-25T00:30:00.000Z"),
        workSessionItem("middle", "runtime-middle", "browser", "active", "2026-05-25T00:20:00.000Z"),
        workSessionItem("oldest", "runtime-oldest", "browser", "active", "2026-05-25T00:10:00.000Z"),
      ],
    });
    sendMock.mockResolvedValueOnce({});
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.enforceActiveLimit({
        workspaceId: "T1",
        ownerUserId: "U1",
        kind: "browser",
        maxActiveSessions: 1,
        now: new Date("2026-05-25T00:31:00.000Z"),
      }),
    ).resolves.toMatchObject([{ workSessionId: "middle" }, { workSessionId: "oldest" }]);
  });
});

function workSessionItem(
  workSessionId: string,
  runtimeSessionId: string,
  kind: "browser" | "sandbox",
  status: "active" | "completed" | "expired",
  lastUsedAt: string,
) {
  return {
    workspaceId: "T1",
    ownerUserId: "U1",
    workSessionId,
    runtimeSessionId,
    kind,
    status,
    createdAt: "2026-05-25T00:00:00.000Z",
    lastUsedAt,
    expiresAt: "2026-05-25T08:00:00.000Z",
    ttl: 1779696000,
  };
}

describe("task repositories", () => {
  it("gets and saves scheduled tasks with schema defaults", async () => {
    const repo = new TaskRepository("tasks");
    sendMock.mockResolvedValueOnce({
      Item: {
        taskId: "task1",
        name: "Digest",
        prompt: "Summarize",
        workspaceId: "T1",
        outputChannelId: "C1",
        enabled: true,
        scheduleName: "serverless-agent-task1",
        scheduleGroupName: "default",
        scheduleExpression: "cron(0 8 * * ? *)",
        scheduleExpressionTimezone: "Asia/Tokyo",
        createdAt: "created",
        updatedAt: "updated",
      },
    });

    await expect(repo.get("T1", "task1")).resolves.toMatchObject({
      taskId: "task1",
      reuseSession: false,
      scheduleExpression: "cron(0 8 * * ? *)",
    });
    expect(commandInput()).toMatchObject({
      Key: { pk: "WORKSPACE#T1#TASK#task1" },
    });

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      taskId: "task1",
      name: "Digest",
      prompt: "Summarize",
      workspaceId: "T1",
      outputChannelId: "C1",
      enabled: true,
      scheduleName: "serverless-agent-task1",
      scheduleGroupName: "default",
      scheduleExpression: "cron(0 8 * * ? *)",
      scheduleExpressionTimezone: "Asia/Tokyo",
      reuseSession: true,
      memoryStoreId: "memory",
      vaultIds: ["vault"],
      createdAt: "created",
      updatedAt: "updated",
    });
    expect(commandInput(1)).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1#TASK#task1",
        scheduleName: "serverless-agent-task1",
        scheduleExpression: "cron(0 8 * * ? *)",
        reuseSession: true,
        vaultIds: ["vault"],
      },
    });
    expect(commandInput(2)).toMatchObject({
      Key: { pk: "TASK#task1" },
      ConditionExpression: "#workspaceId = :workspaceId",
      ExpressionAttributeValues: {
        ":workspaceId": "T1",
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          taskId: "task1",
          name: "Digest",
          prompt: "Summarize",
          workspaceId: "T1",
          outputChannelId: "C1",
          enabled: true,
          scheduleName: "serverless-agent-task1",
          scheduleExpression: "cron(0 8 * * ? *)",
          scheduleExpressionTimezone: "Asia/Tokyo",
          createdAt: "created",
          updatedAt: "updated",
        },
      ],
    });
    await expect(repo.list({ workspaceId: "T1", enabled: true })).resolves.toHaveLength(1);
    expect(commandInput(3)).toMatchObject({
      IndexName: "WorkspaceIndex",
      KeyConditionExpression: "#workspaceId = :workspaceId",
      FilterExpression: "#enabled = :enabled",
      ExpressionAttributeValues: {
        ":workspaceId": "T1",
        ":enabled": true,
      },
    });

    sendMock.mockResolvedValueOnce({});
    await repo.delete("T1", "task1");
    expect(commandInput(4)).toMatchObject({
      Key: { pk: "WORKSPACE#T1#TASK#task1" },
    });
    expect(commandInput(5)).toMatchObject({
      Key: { pk: "TASK#task1" },
      ConditionExpression: "#workspaceId = :workspaceId",
    });

    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await expect(repo.get("T1", "missing")).resolves.toBeNull();
  });

  it("saves task events with generated ids and timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new TaskEventRepository("events");
    sendMock.mockResolvedValueOnce({});

    const saved = await repo.save({
      taskId: "task1",
      type: "marked_done",
      payload: { by: "U1" },
    });

    expect(saved.eventId).toMatch(/^tevt_/);
    expect(saved.createdAt).toBe("2026-05-14T00:00:00.000Z");
    expect(commandInput()).toMatchObject({
      Item: {
        pk: "TASK#task1",
        type: "marked_done",
        payload: { by: "U1" },
      },
    });
  });

  it("upserts, lists, and completes task states", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new TaskStateRepository("states");

    sendMock.mockResolvedValueOnce({});
    const created = await repo.upsert({
      workspaceId: "T1",
      title: "New task",
      status: "open",
      priority: "high",
    });
    expect(created.taskId).toMatch(/^task_/);
    expect(created.createdAt).toBe("2026-05-14T00:00:00.000Z");
    expect(commandInput()).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1",
        gsi1pk: "WORKSPACE#T1#STATUS#open",
        gsi1sk: expect.stringContaining("DUE#9999-12-31T23:59:59.999Z"),
      },
    });

    sendMock.mockResolvedValueOnce({
      Item: {
        workspaceId: "T1",
        taskId: "task1",
        title: "Existing",
        status: "open",
        createdAt: "created",
        updatedAt: "old",
      },
    });
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.upsert({
        workspaceId: "T1",
        taskId: "task1",
        title: "Existing changed",
        status: "in_progress",
      }),
    ).resolves.toMatchObject({
      taskId: "task1",
      title: "Existing changed",
      createdAt: "created",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          taskId: "a",
          title: "late",
          status: "open",
          dueAt: "2026-06-01",
          ownerUserId: "U1",
          createdAt: "c",
          updatedAt: "2026-05-01",
        },
        {
          workspaceId: "T1",
          taskId: "b",
          title: "soon",
          status: "open",
          dueAt: "2026-05-20",
          ownerUserId: "U1",
          createdAt: "c",
          updatedAt: "2026-05-02",
        },
        {
          workspaceId: "T1",
          taskId: "other-owner",
          title: "hidden",
          status: "open",
          ownerUserId: "U2",
          createdAt: "c",
          updatedAt: "2026-05-03",
        },
      ],
    });
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          taskId: "c",
          title: "doing",
          status: "in_progress",
          createdAt: "c",
          updatedAt: "2026-05-10",
        },
      ],
    });

    await expect(
      repo.list({
        workspaceId: "T1",
        ownerUserId: "U1",
        dueBefore: "2026-05-30",
        limit: 5,
      }),
    ).resolves.toMatchObject([{ taskId: "b" }, { taskId: "c" }]);

    sendMock.mockResolvedValueOnce({});
    await expect(repo.markDone({ workspaceId: "T1", taskId: "missing" })).rejects.toThrow(
      "was not found",
    );

    sendMock.mockResolvedValueOnce({
      Item: {
        workspaceId: "T1",
        taskId: "done-task",
        title: "Finish",
        status: "open",
        createdAt: "created",
        updatedAt: "old",
      },
    });
    sendMock.mockResolvedValueOnce({
      Item: {
        workspaceId: "T1",
        taskId: "done-task",
        title: "Finish",
        status: "open",
        createdAt: "created",
        updatedAt: "old",
      },
    });
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.markDone({
        workspaceId: "T1",
        taskId: "done-task",
        completedByUserId: "U1",
        completedAt: "completed",
      }),
    ).resolves.toMatchObject({
      status: "done",
      completedAt: "completed",
      completedByUserId: "U1",
    });

    sendMock.mockResolvedValueOnce({
      Item: {
        workspaceId: "T1",
        taskId: "full",
        title: "Full",
        description: "Description",
        status: "done",
        dueAt: "2026-05-15",
        priority: "medium",
        ownerUserId: "U1",
        calendarEventId: "event",
        sourceType: "slack",
        sourceRef: "ref",
        metadata: { key: "value" },
        completedAt: "completed",
        completedByUserId: "U1",
        createdAt: "created",
        updatedAt: "updated",
      },
    });
    await expect(repo.get("T1", "full")).resolves.toMatchObject({
      description: "Description",
      calendarEventId: "event",
      metadata: { key: "value" },
      completedByUserId: "U1",
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          taskId: "done",
          title: "Done",
          status: "done",
          createdAt: "c",
          updatedAt: "2026-05-10",
        },
      ],
    });
    await expect(repo.list({ workspaceId: "T1", statuses: ["done"], limit: 0 })).resolves.toEqual([
      expect.objectContaining({ taskId: "done" }),
    ]);
    expect(commandInput(sendMock.mock.calls.length - 1)).toMatchObject({
      Limit: 50,
      ExpressionAttributeValues: {
        ":gsi1pk": "WORKSPACE#T1#STATUS#done",
      },
    });
  });

  it("gets, lists, upserts, and disables recurring tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new RecurringTaskRepository("recurring");
    const existing = {
      recurringTaskId: "rt1",
      workspaceId: "T1",
      title: "Weekly",
      recurrence: { frequency: "weekly", interval: 1 },
      dueTime: "09:00",
      timezone: "UTC",
      enabled: true,
      createdAt: "created",
      updatedAt: "old",
    };

    sendMock.mockResolvedValueOnce({ Item: existing });
    await expect(repo.get("T1", "rt1")).resolves.toMatchObject(existing);

    sendMock.mockResolvedValueOnce({ Items: [existing, { ...existing, recurringTaskId: "rt2", enabled: false }] });
    await expect(repo.list({ workspaceId: "T1", enabled: true, limit: 500 })).resolves.toHaveLength(1);
    expect(commandInput(1)).toMatchObject({
      Limit: 250,
      ExpressionAttributeValues: {
        ":pk": "WORKSPACE#T1",
        ":skPrefix": "RECURRING_TASK#",
      },
    });

    sendMock.mockResolvedValueOnce({});
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.upsert({
        recurringTaskId: "rt-new",
        workspaceId: "T1",
        title: "Daily",
        recurrence: { frequency: "daily" },
      }),
    ).resolves.toMatchObject({
      dueTime: "23:59",
      timezone: "Asia/Tokyo",
      enabled: true,
    });

    sendMock.mockResolvedValueOnce({ Item: existing });
    sendMock.mockResolvedValueOnce({ Item: existing });
    sendMock.mockResolvedValueOnce({});
    await expect(repo.disable("T1", "rt1")).resolves.toMatchObject({ enabled: false });

    sendMock.mockResolvedValueOnce({});
    await expect(repo.disable("T1", "missing")).rejects.toThrow("was not found");

    sendMock.mockResolvedValueOnce({ Item: existing });
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.upsert({
        recurringTaskId: "rt1",
        workspaceId: "T1",
        title: "Monthly",
        recurrence: { frequency: "monthly", daysOfMonth: [14] },
        dueTime: "10:30",
        timezone: "Asia/Tokyo",
        enabled: false,
      }),
    ).resolves.toMatchObject({
      recurrence: { frequency: "monthly", interval: 1, daysOfMonth: [14] },
      dueTime: "10:30",
      timezone: "Asia/Tokyo",
      enabled: false,
      createdAt: "created",
    });
  });
});

describe("memory repositories", () => {
  it("saves and searches workspace memory items", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new MemoryItemRepository("memory");

    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.save({
        workspaceId: "T1",
        entityKey: "project:x",
        text: "Project X uses DynamoDB",
        attributes: { system: "ddb" },
        tags: ["aws"],
        importance: 3,
      }),
    ).resolves.toMatchObject({
      workspaceId: "T1",
      memoryId: expect.stringMatching(/^mem_/),
      createdAt: "2026-05-14T00:00:00.000Z",
    });
    expect(commandInput()).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1",
        gsi1pk: "WORKSPACE#T1#ENTITY#project:x",
        searchText: expect.stringContaining("dynamodb"),
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          memoryId: "low",
          text: "Project X old",
          searchText: "project x old",
          importance: 1,
          createdAt: "c",
          updatedAt: "2026-05-01",
        },
        {
          workspaceId: "T1",
          memoryId: "high",
          text: "Project X new",
          searchText: "project x new",
          importance: 5,
          createdAt: "c",
          updatedAt: "2026-05-02",
        },
        {
          workspaceId: "T1",
          memoryId: "miss",
          text: "Other",
          searchText: "other",
          importance: 9,
          createdAt: "c",
          updatedAt: "2026-05-03",
        },
      ],
    });

    await expect(repo.search({ workspaceId: "T1", query: "project x", entityKey: "project:x", limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        memoryId: "high",
        text: "Project X new",
      }),
    ]);
    expect(commandInput(1)).toMatchObject({
      IndexName: "EntityIndex",
      ExpressionAttributeValues: {
        ":gsi1pk": "WORKSPACE#T1#ENTITY#project:x",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      memoryId: "mem-explicit",
      text: "No entity",
    });
    expect(commandInput(2)).toMatchObject({
      Item: {
        sk: "MEMORY#mem-explicit",
        gsi1pk: undefined,
        gsi1sk: undefined,
        searchText: "no entity {}",
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          memoryId: "older",
          text: "Older",
          searchText: "",
          createdAt: "c",
          updatedAt: "2026-05-01",
        },
        {
          workspaceId: "T1",
          memoryId: "newer",
          text: "Newer",
          searchText: "",
          createdAt: "c",
          updatedAt: "2026-05-02",
        },
      ],
    });
    await expect(repo.search({ workspaceId: "T1", query: "", limit: 99 })).resolves.toMatchObject([
      { memoryId: "newer" },
      { memoryId: "older" },
    ]);
    expect(commandInput(3)).toMatchObject({
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": "WORKSPACE#T1",
      },
    });
  });

  it("saves and searches channel memories by status, entity, and query terms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new ChannelMemoryRepository("channel-memory");

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      channelId: "C1",
      text: "Release channel norm",
      entityKey: "release",
      tags: ["deploy"],
      status: "candidate",
      origin: "inferred",
    });
    expect(commandInput()).toMatchObject({
      Item: {
        pk: "CHANNEL#T1#C1",
        sk: expect.stringContaining("MEMORY#chanmem_"),
        searchText: expect.stringContaining("deploy"),
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          channelId: "C1",
          memoryId: "active",
          text: "Deploy windows",
          entityKey: "release",
          searchText: "deploy windows",
          status: "active",
          origin: "explicit",
          importance: 2,
          createdAt: "c",
          updatedAt: "2026-05-01",
        },
        {
          workspaceId: "T1",
          channelId: "C1",
          memoryId: "candidate",
          text: "Deploy checklist",
          entityKey: "release",
          searchText: "deploy checklist",
          status: "candidate",
          origin: "inferred",
          importance: 5,
          createdAt: "c",
          updatedAt: "2026-05-02",
        },
      ],
    });

    await expect(
      repo.search({
        workspaceId: "T1",
        channelId: "C1",
        query: "deploy",
        entityKey: "release",
        statuses: ["candidate"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        memoryId: "candidate",
      }),
    ]);

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      channelId: "C1",
      memoryId: "chan-explicit",
      text: "Channel norm",
      status: "active",
      origin: "explicit",
    });
    expect(commandInput(2)).toMatchObject({
      Item: {
        sk: "MEMORY#chan-explicit",
        searchText: "channel norm {}",
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          channelId: "C1",
          memoryId: "active-old",
          text: "Active old",
          searchText: "",
          status: "active",
          origin: "explicit",
          createdAt: "c",
          updatedAt: "2026-05-01",
        },
        {
          workspaceId: "T1",
          channelId: "C1",
          memoryId: "archived",
          text: "Archived",
          searchText: "",
          status: "archived",
          origin: "explicit",
          createdAt: "c",
          updatedAt: "2026-05-03",
        },
      ],
    });
    await expect(
      repo.search({ workspaceId: "T1", channelId: "C1", query: "", limit: -1 }),
    ).resolves.toEqual([expect.objectContaining({ memoryId: "active-old" })]);
  });

  it("gets channel memory by id", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");

    sendMock.mockResolvedValueOnce({
      Item: {
        workspaceId: "T1",
        channelId: "C1",
        memoryId: "chanmem_1",
        text: "Channel fact",
        searchText: "channel fact",
        status: "active",
        origin: "explicit",
        createdAt: "created",
        updatedAt: "updated",
      },
    });

    await expect(repo.get("T1", "C1", "chanmem_1")).resolves.toMatchObject({
      workspaceId: "T1",
      channelId: "C1",
      memoryId: "chanmem_1",
      text: "Channel fact",
    });
    expect(commandInput()).toMatchObject({
      TableName: "channel-memory",
      Key: {
        pk: "CHANNEL#T1#C1",
        sk: "MEMORY#chanmem_1",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await expect(repo.get("T1", "C1", "missing")).resolves.toBeNull();
  });

  it("saves and searches user preferences", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new UserPreferenceRepository("prefs");

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      userId: "U1",
      preferenceKey: "tone",
      entityKey: "writing",
      text: "Prefer short summaries",
      tags: ["style"],
      origin: "explicit",
    });
    expect(commandInput()).toMatchObject({
      Item: {
        pk: "USER#T1#U1",
        sk: expect.stringContaining("PREFERENCE#pref_"),
        searchText: expect.stringContaining("short summaries"),
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          userId: "U1",
          preferenceId: "pref1",
          preferenceKey: "tone",
          entityKey: "writing",
          text: "Prefer short summaries",
          searchText: "prefer short summaries",
          origin: "explicit",
          importance: 2,
          createdAt: "c",
          updatedAt: "2026-05-01",
        },
        {
          workspaceId: "T1",
          userId: "U1",
          preferenceId: "pref2",
          preferenceKey: "tool",
          entityKey: "calendar",
          text: "Use calendar",
          searchText: "use calendar",
          origin: "inferred",
          importance: 5,
          createdAt: "c",
          updatedAt: "2026-05-02",
        },
      ],
    });

    await expect(
      repo.search({ workspaceId: "T1", userId: "U1", query: "short", entityKey: "writing" }),
    ).resolves.toEqual([expect.objectContaining({ preferenceId: "pref1" })]);

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      userId: "U1",
      preferenceId: "pref-explicit",
      text: "No tags",
      origin: "inferred",
    });
    expect(commandInput(2)).toMatchObject({
      Item: {
        sk: "PREFERENCE#pref-explicit",
        searchText: "no tags {}",
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          userId: "U1",
          preferenceId: "pref-old",
          text: "Old",
          searchText: "",
          origin: "explicit",
          createdAt: "c",
          updatedAt: "2026-05-01",
        },
        {
          workspaceId: "T1",
          userId: "U1",
          preferenceId: "pref-new",
          text: "New",
          searchText: "",
          origin: "explicit",
          createdAt: "c",
          updatedAt: "2026-05-02",
        },
      ],
    });
    await expect(repo.search({ workspaceId: "T1", userId: "U1", query: "", limit: 99 })).resolves.toMatchObject([
      { preferenceId: "pref-new" },
      { preferenceId: "pref-old" },
    ]);
  });
});

describe("conversation turn repository", () => {
  it("saves turns and only indexes top-level channel context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new ConversationTurnRepository("turns");

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      workspaceId: "T1",
      channelId: "C1",
      conversationTs: "100",
      contextScope: "channel_top_level",
      role: "user",
      source: "slack",
      sourceEvent: "app_mention",
      messageTs: "101",
      turnTs: "101",
      userId: "U1",
      text: "hello",
    });
    expect(commandInput()).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1#CHANNEL#C1#CONVERSATION#100",
        gsi1pk: "WORKSPACE#T1#CHANNEL#C1#SCOPE#channel_top_level",
        turn_id: expect.stringMatching(/^turn_/),
        created_at: "2026-05-14T00:00:00.000Z",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      turnId: "turn-thread",
      createdAt: "created",
      workspaceId: "T1",
      channelId: "C1",
      conversationTs: "100",
      contextScope: "thread",
      role: "assistant",
      source: "slack",
      sourceEvent: "assistant_reply",
      threadTs: "100",
      messageTs: "102",
      turnTs: "102",
      text: "reply",
    });
    expect(commandInput(1)).toMatchObject({
      Item: {
        gsi1pk: undefined,
        gsi1sk: undefined,
        turn_id: "turn-thread",
        created_at: "created",
      },
    });
  });

  it("lists turns by conversation and recent top-level channel scope", async () => {
    const repo = new ConversationTurnRepository("turns");
    const itemA = {
      turn_id: "turn-a",
      workspace_id: "T1",
      channel_id: "C1",
      conversation_ts: "100",
      context_scope: "thread",
      role: "user",
      source: "slack",
      source_event: "dm",
      message_ts: "101",
      turn_ts: "101",
      user_id: "U1",
      text: "a",
      created_at: "created-a",
    };
    const itemB = {
      ...itemA,
      turn_id: "turn-b",
      message_ts: "102",
      turn_ts: "102",
      text: "b",
      created_at: "created-b",
    };

    sendMock.mockResolvedValueOnce({ Items: [itemA, itemB] });
    await expect(repo.listByConversation("T1", "C1", "100")).resolves.toMatchObject([
      { turnId: "turn-a" },
      { turnId: "turn-b" },
    ]);

    sendMock.mockResolvedValueOnce({ Items: [itemB, itemA] });
    await expect(repo.listRecentChannelTopLevelTurns("T1", "C1", 100)).resolves.toMatchObject([
      { turnId: "turn-a" },
      { turnId: "turn-b" },
    ]);
    expect(commandInput(1)).toMatchObject({
      IndexName: "ChannelScopeIndex",
      Limit: 50,
      ScanIndexForward: false,
    });

    sendMock.mockResolvedValueOnce({ Items: [] });
    await expect(repo.listRecentChannelTopLevelTurns("T1", "C1", 0)).resolves.toEqual([]);
    expect(commandInput(2)).toMatchObject({ Limit: 1 });
  });
});

describe("calendar, source document, and OAuth repositories", () => {
  it("saves, gets, and lists calendar drafts with filtering", async () => {
    const repo = new CalendarDraftRepository("drafts");
    const draft = {
      draftId: "draft1",
      workspaceId: "T1",
      userId: "U1",
      title: "Meeting candidates",
      status: "pending" as const,
      candidates: [
        {
          candidateId: "cand1",
          summary: "Meet",
          allDay: false,
          startAt: "2026-05-15T10:00:00+09:00",
          endAt: "2026-05-15T11:00:00+09:00",
          status: "pending" as const,
        },
      ],
      createdAt: "created",
      updatedAt: "2026-05-14",
    };

    sendMock.mockResolvedValueOnce({});
    await expect(repo.save(draft)).resolves.toEqual(draft);
    expect(commandInput()).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1#USER#U1",
        sk: "DRAFT#draft1",
      },
    });

    sendMock.mockResolvedValueOnce({ Item: draft });
    await expect(repo.get("T1", "U1", "draft1")).resolves.toMatchObject({ draftId: "draft1" });

    sendMock.mockResolvedValueOnce({
      Items: [
        draft,
        { ...draft, draftId: "draft2", status: "rejected", updatedAt: "2026-05-15" },
        { ...draft, draftId: "draft3", status: "pending", updatedAt: "2026-05-16" },
      ],
    });
    await expect(repo.list({ workspaceId: "T1", userId: "U1", statuses: ["pending"], limit: 1 })).resolves.toEqual([
      expect.objectContaining({ draftId: "draft3" }),
    ]);

    sendMock.mockResolvedValueOnce({
      Items: [
        { ...draft, draftId: "draft2", status: "rejected", updatedAt: "2026-05-15" },
        { ...draft, draftId: "draft1", status: "pending", updatedAt: "2026-05-14" },
      ],
    });
    await expect(repo.list({ workspaceId: "T1", statuses: [], limit: 50 })).resolves.toMatchObject([
      { draftId: "draft2" },
      { draftId: "draft1" },
    ]);

    sendMock.mockResolvedValueOnce({});
    await expect(repo.get("T1", undefined, "missing")).resolves.toBeNull();
  });

  it("saves and gets source documents", async () => {
    const repo = new SourceDocumentRepository("sources");
    const document = {
      sourceId: "src1",
      workspaceId: "T1",
      sourceType: "slack_file" as const,
      sourceRef: "https://slack/file",
      title: "doc.pdf",
      slackFileId: "F1",
      slackPermalink: "https://slack/permalink",
      channelId: "C1",
      threadTs: "100",
      messageTs: "101",
      uploadedByUserId: "U1",
      mimeType: "application/pdf",
      size: 12,
      checksum: "sha",
      s3Bucket: "bucket",
      s3Key: "key",
      status: "archived" as const,
      summary: "summary",
      importedTaskIds: ["task"],
      importedRecurringTaskIds: ["rt"],
      savedMemoryIds: ["mem"],
      extractionStatus: "queued" as const,
      extractedMarkdownS3Bucket: "mb",
      extractedMarkdownS3Key: "mk",
      extractedMarkdownChecksum: "msha",
      extractedMarkdownSize: 10,
      createdAt: "created",
      updatedAt: "updated",
    };

    sendMock.mockResolvedValueOnce({});
    await expect(repo.save(document)).resolves.toEqual(document);
    expect(commandInput()).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1",
        sk: "SOURCE#src1",
        extractedMarkdownS3Key: "mk",
      },
    });

    sendMock.mockResolvedValueOnce({ Item: document });
    await expect(repo.get("T1", "src1")).resolves.toEqual(document);

    sendMock.mockResolvedValueOnce({});
    await expect(repo.get("T1", "missing")).resolves.toBeNull();
  });

  it("loads and saves Google OAuth connections while preserving connectedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new GoogleOAuthConnectionRepository("connections");
    const existing = {
      workspaceId: "T1",
      userId: "U1",
      googleSubject: "sub",
      googleEmail: "u@example.com",
      refreshToken: "refresh",
      calendarId: "primary",
      timeZone: "Asia/Tokyo",
      scopes: ["calendar"],
      connectedAt: "connected",
      updatedAt: "old",
    };

    sendMock.mockResolvedValueOnce({ Item: existing });
    await expect(repo.get("T1", "U1")).resolves.toEqual(existing);

    sendMock.mockResolvedValueOnce({});
    await expect(repo.get("T1", "missing")).resolves.toBeNull();

    sendMock.mockResolvedValueOnce({ Item: existing });
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.save({
        workspaceId: "T1",
        userId: "U1",
        refreshToken: "new-refresh",
      }),
    ).resolves.toMatchObject({
      connectedAt: "connected",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });
    expect(commandInput(3)).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1#USER#U1",
        sk: "GOOGLE_CALENDAR",
        refreshToken: "new-refresh",
      },
    });

    sendMock.mockResolvedValueOnce({});
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.save({
        workspaceId: "T1",
        userId: "U2",
        refreshToken: "refresh",
        connectedAt: "provided",
        updatedAt: "provided-updated",
      }),
    ).resolves.toMatchObject({
      connectedAt: "provided",
      updatedAt: "provided-updated",
    });
  });
});
