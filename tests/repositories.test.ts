import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTurnTraceRepository } from "../src/repo/agentTurnTraceRepository";
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

  it("can require provider bindings instead of falling back to provider-derived workspaces", async () => {
    const repo = new ProviderBindingRepository("provider-bindings");

    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await expect(
      repo.resolveWorkspace({
        provider: "line",
        providerAccountId: "Ubot",
        providerConversationKey: "group:G1",
        fallbackWorkspaceId: "line:group:G1",
        resolutionMode: "bound_only",
      }),
    ).resolves.toBeNull();

    expect(commandInput(0)).toMatchObject({
      TableName: "provider-bindings",
      Key: {
        pk: "PROVIDER#line#ACCOUNT#Ubot",
        sk: "CONVERSATION#group:G1",
      },
    });
    expect(commandInput(1)).toMatchObject({
      TableName: "provider-bindings",
      Key: {
        pk: "PROVIDER#line#ACCOUNT#Ubot",
        sk: "INSTALLATION",
      },
    });

    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await expect(
      repo.resolveWorkspace({
        provider: "line",
        providerAccountId: "Ubot",
        providerConversationKey: "group:G1",
        fallbackWorkspaceId: "line:group:G1",
      }),
    ).resolves.toEqual({
      workspaceId: "line:group:G1",
      source: "fallback",
    });
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

  it("searches and patches task states without dropping existing fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repo = new TaskStateRepository("states");

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          taskId: "task-alpha",
          title: "Alpha task",
          description: "Contains alpha search token. Preserve this detail.",
          status: "open",
          dueAt: "2026-06-05T23:59:00+09:00",
          ownerUserId: "U1",
          sourceRef: "source:alpha",
          metadata: { category: "alpha" },
          createdAt: "created",
          updatedAt: "old",
        },
        {
          workspaceId: "T1",
          taskId: "task-beta",
          title: "Beta task",
          description: "Unrelated task detail.",
          status: "open",
          createdAt: "created",
          updatedAt: "old",
        },
      ],
    });
    sendMock.mockResolvedValueOnce({ Items: [] });
    sendMock.mockResolvedValueOnce({ Items: [] });
    sendMock.mockResolvedValueOnce({ Items: [] });

    await expect(repo.search({ workspaceId: "T1", query: "alpha search token", limit: 5 })).resolves.toEqual([
      expect.objectContaining({ taskId: "task-alpha" }),
    ]);

    sendMock.mockResolvedValueOnce({
      Item: {
        workspaceId: "T1",
        taskId: "task-alpha",
        title: "Alpha task",
        description: "Contains alpha search token. Preserve this detail.",
        status: "open",
        dueAt: "2026-06-05T23:59:00+09:00",
        priority: "high",
        ownerUserId: "U1",
        sourceType: "agent",
        sourceRef: "source:alpha",
        metadata: { category: "alpha" },
        createdAt: "created",
        updatedAt: "old",
      },
    });
    sendMock.mockResolvedValueOnce({});

    await expect(
      repo.patch({
        workspaceId: "T1",
        taskId: "task-alpha",
        expectedUpdatedAt: "old",
        patch: {
          description: "Contains alpha search token.",
        },
      }),
    ).resolves.toMatchObject({
      taskId: "task-alpha",
      title: "Alpha task",
      description: "Contains alpha search token.",
      dueAt: "2026-06-05T23:59:00+09:00",
      priority: "high",
      sourceRef: "source:alpha",
      metadata: { category: "alpha" },
      updatedAt: "2026-05-14T00:00:00.000Z",
    });
    expect(commandInput(sendMock.mock.calls.length - 1)).toMatchObject({
      Item: {
        pk: "WORKSPACE#T1",
        sk: "TASK#task-alpha",
        description: "Contains alpha search token.",
        dueAt: "2026-06-05T23:59:00+09:00",
        priority: "high",
      },
    });

    sendMock.mockResolvedValueOnce({
      Item: {
        workspaceId: "T1",
        taskId: "task-alpha",
        title: "Alpha task",
        status: "open",
        createdAt: "created",
        updatedAt: "newer",
      },
    });
    await expect(
      repo.patch({
        workspaceId: "T1",
        taskId: "task-alpha",
        expectedUpdatedAt: "old",
        patch: { description: "Stale description update." },
      }),
    ).rejects.toThrow("changed since it was loaded");
  });

  it("searches completed task states when statuses are omitted", async () => {
    const repo = new TaskStateRepository("states");

    sendMock
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [
          {
            workspaceId: "T1",
            taskId: "task-completed-search",
            title: "Completed search fixture",
            description: "Contains completed-only fixture token.",
            status: "done",
            createdAt: "created",
            updatedAt: "updated",
          },
        ],
      })
      .mockResolvedValueOnce({ Items: [] });

    await expect(repo.search({ workspaceId: "T1", query: "completed-only fixture", limit: 5 })).resolves.toEqual([
      expect.objectContaining({ taskId: "task-completed-search", status: "done" }),
    ]);
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
      leadTimeDays: 0,
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

    sendMock.mockResolvedValueOnce({});
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.upsert({
        recurringTaskId: "rt-yearly",
        workspaceId: "T1",
        title: "Father's Day preparation",
        recurrence: {
          frequency: "yearly",
          interval: 1,
          monthOfYear: 6,
          daysOfWeek: ["sunday"],
          weekOfMonth: 3,
        },
        leadTimeDays: 7,
        dayOfTask: {
          enabled: true,
          title: "Send Father's Day message",
          dueTime: "09:00",
        },
      }),
    ).resolves.toMatchObject({
      leadTimeDays: 7,
      dayOfTask: { enabled: true, title: "Send Father's Day message", dueTime: "09:00" },
    });
    expect(commandInput(sendMock.mock.calls.length - 1)).toMatchObject({
      Item: {
        leadTimeDays: 7,
        dayOfTask: { enabled: true, title: "Send Father's Day message", dueTime: "09:00" },
      },
    });
  });

  it("validates the fully merged recurring task before persisting an update", async () => {
    const repo = new RecurringTaskRepository("recurring");
    sendMock.mockResolvedValueOnce({
      Item: {
        recurringTaskId: "rt-yearly",
        workspaceId: "T1",
        title: "Prepare",
        recurrence: {
          frequency: "yearly",
          interval: 1,
          monthOfYear: 5,
          daysOfWeek: ["sunday"],
          weekOfMonth: 2,
        },
        leadTimeDays: 7,
        dayOfTask: { enabled: true, title: "Send message" },
        dueTime: "23:59",
        timezone: "Asia/Tokyo",
        enabled: true,
        createdAt: "created",
        updatedAt: "updated",
      },
    });

    await expect(
      repo.upsert({
        recurringTaskId: "rt-yearly",
        workspaceId: "T1",
        title: "Prepare",
        recurrence: {
          frequency: "yearly",
          interval: 1,
          monthOfYear: 5,
          daysOfWeek: ["sunday"],
          weekOfMonth: 2,
        },
        leadTimeDays: 0,
      }),
    ).rejects.toThrow("dayOfTask requires leadTimeDays");
    expect(sendMock).toHaveBeenCalledTimes(1);
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

  it("idempotently upserts channel memories by dedupe key and promotes explicit candidates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T01:00:00Z"));
    const repo = new ChannelMemoryRepository("channel-memory");

    sendMock
      .mockResolvedValueOnce({
        Items: [
          {
            workspaceId: "T1",
            channelId: "C1",
            memoryId: "chanmem_existing",
            dedupeKey: "person:fixture-taro:birthday",
            entityKey: "person:fixture-taro",
            text: "架空太郎：2000年1月2日生",
            attributes: { date_kind: "birthday" },
            tags: ["family", "birthday"],
            importance: 0.8,
            status: "candidate",
            origin: "inferred",
            sourceType: "document_import",
            sourceRef: "s3://source/document.pdf",
            createdByUserId: "U1",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const result = await repo.upsert({
      workspaceId: "T1",
      channelId: "C1",
      dedupeKey: "person:fixture-taro:birthday",
      text: "架空太郎（かくうたろう）：2000年1月2日生まれ。",
      attributes: { reading: "かくうたろう" },
      tags: ["birthday"],
      status: "active",
      origin: "explicit",
      sourceType: "agent",
      createdByUserId: "U1",
    });

    expect(result).toMatchObject({
      memoryId: "chanmem_existing",
      dedupeKey: "person:fixture-taro:birthday",
      status: "active",
      origin: "explicit",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-07-10T01:00:00.000Z",
      attributes: { date_kind: "birthday", reading: "かくうたろう" },
      tags: ["family", "birthday"],
      entityKey: "person:fixture-taro",
      importance: 0.8,
      sourceType: "document_import",
      sourceRef: "s3://source/document.pdf",
    });
    expect(commandInput(1)).toMatchObject({
      TableName: "channel-memory",
      Item: {
        sk: "MEMORY#chanmem_existing",
        dedupeKey: "person:fixture-taro:birthday",
        status: "active",
        origin: "explicit",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      ConditionExpression: "#updatedAt = :expectedUpdatedAt",
      ExpressionAttributeValues: {
        ":expectedUpdatedAt": "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("adds a dedupe key to an exact legacy candidate instead of creating a duplicate", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");
    sendMock
      .mockResolvedValueOnce({
        Items: [
          {
            workspaceId: "T1",
            channelId: "C1",
            memoryId: "chanmem_legacy",
            entityKey: "person:fixture-taro",
            text: "架空太郎の誕生日は1月2日",
            status: "candidate",
            origin: "inferred",
            createdAt: "created",
            updatedAt: "updated",
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        dedupeKey: "person:fixture-taro:birthday",
        entityKey: "person:fixture-taro",
        text: "架空太郎の誕生日は1月2日",
        status: "active",
        origin: "explicit",
      }),
    ).resolves.toMatchObject({
      memoryId: "chanmem_legacy",
      dedupeKey: "person:fixture-taro:birthday",
      status: "active",
    });
    expect(commandInput(1)).toMatchObject({
      Item: { sk: "MEMORY#chanmem_legacy" },
      ConditionExpression: "#updatedAt = :expectedUpdatedAt",
    });
  });

  it("re-reads after a concurrent deduplicated create instead of overwriting it", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");
    sendMock
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" })
      .mockResolvedValueOnce({
        Items: [
          {
            workspaceId: "T1",
            channelId: "C1",
            memoryId: "chanmem_concurrent",
            dedupeKey: "project:alpha:owner",
            text: "Alpha owner is U1",
            status: "active",
            origin: "explicit",
            sourceType: "agent",
            createdByUserId: "U1",
            createdAt: "created",
            updatedAt: "updated",
          },
        ],
      });

    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        dedupeKey: "project:alpha:owner",
        text: "Alpha owner is U1",
        status: "active",
        origin: "explicit",
        sourceType: "agent",
        createdByUserId: "U1",
      }),
    ).resolves.toMatchObject({ memoryId: "chanmem_concurrent", status: "active" });
    expect(commandInput(1)).toMatchObject({
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    });
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("lets a live canonical memory reuse a dedupe key left on an archived duplicate", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");
    sendMock
      .mockResolvedValueOnce({
        Items: [
          {
            workspaceId: "T1",
            channelId: "C1",
            memoryId: "chanmem_active",
            dedupeKey: "person:fixture-taro:birthday",
            text: "Canonical birthday",
            status: "active",
            origin: "explicit",
            createdAt: "active-created",
            updatedAt: "active-updated",
          },
          {
            workspaceId: "T1",
            channelId: "C1",
            memoryId: "chanmem_archived",
            dedupeKey: "person:fixture-taro:birthday",
            text: "Duplicate birthday",
            status: "archived",
            origin: "inferred",
            createdAt: "archived-created",
            updatedAt: "archived-updated",
          },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        memoryId: "chanmem_active",
        dedupeKey: "person:fixture-taro:birthday",
        expectedUpdatedAt: "active-updated",
        text: "Canonical birthday with reading",
        status: "active",
        origin: "explicit",
      }),
    ).resolves.toMatchObject({ memoryId: "chanmem_active", status: "active" });
  });

  it("does not let inferred input rewrite an approved explicit memory", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          channelId: "C1",
          memoryId: "chanmem_approved",
          dedupeKey: "project:fixture:owner",
          text: "The approved owner is U1",
          status: "active",
          origin: "explicit",
          createdAt: "created",
          updatedAt: "updated",
        },
      ],
    });

    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        dedupeKey: "project:fixture:owner",
        text: "The inferred owner might be U2",
        status: "candidate",
        origin: "inferred",
      }),
    ).rejects.toThrow("active and cannot be changed by inferred input");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("requires a version token before changing approved explicit memory", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          channelId: "C1",
          memoryId: "chanmem_approved",
          dedupeKey: "project:fixture:owner",
          text: "The approved owner is U1",
          status: "active",
          origin: "explicit",
          createdAt: "created",
          updatedAt: "updated",
        },
      ],
    });

    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        dedupeKey: "project:fixture:owner",
        text: "The approved owner is U2",
        status: "active",
        origin: "explicit",
      }),
    ).rejects.toThrow("requires memory_id and expected_updated_at");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite concurrent approved memory after an inferred create loses the race", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");
    sendMock
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" })
      .mockResolvedValueOnce({
        Items: [
          {
            workspaceId: "T1",
            channelId: "C1",
            memoryId: "chanmem_concurrent_approved",
            dedupeKey: "project:fixture:owner",
            text: "The approved owner is U1",
            status: "active",
            origin: "explicit",
            createdAt: "created",
            updatedAt: "updated",
          },
        ],
      });

    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        dedupeKey: "project:fixture:owner",
        text: "The inferred owner might be U2",
        status: "candidate",
        origin: "inferred",
      }),
    ).rejects.toThrow("cannot be changed by inferred input");
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(commandInput(1)).toMatchObject({
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    });
  });

  it("accepts a versioned retry when a concurrent writer already stored the same state", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");
    sendMock
      .mockResolvedValueOnce({
        Items: [
          {
            workspaceId: "T1",
            channelId: "C1",
            memoryId: "chanmem_versioned",
            dedupeKey: "project:fixture:owner",
            text: "The owner is U1",
            status: "active",
            origin: "explicit",
            createdAt: "created",
            updatedAt: "version-1",
          },
        ],
      })
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" })
      .mockResolvedValueOnce({
        Items: [
          {
            workspaceId: "T1",
            channelId: "C1",
            memoryId: "chanmem_versioned",
            dedupeKey: "project:fixture:owner",
            text: "The owner is U2",
            status: "active",
            origin: "explicit",
            createdAt: "created",
            updatedAt: "version-2",
          },
        ],
      });

    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        memoryId: "chanmem_versioned",
        dedupeKey: "project:fixture:owner",
        expectedUpdatedAt: "version-1",
        text: "The owner is U2",
        status: "active",
        origin: "explicit",
      }),
    ).resolves.toMatchObject({ text: "The owner is U2", updatedAt: "version-2" });
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("rejects stale or cross-channel channel-memory updates", async () => {
    const repo = new ChannelMemoryRepository("channel-memory");

    sendMock.mockResolvedValueOnce({ Items: [] });
    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        memoryId: "chanmem_missing",
        expectedUpdatedAt: "old",
        text: "Updated fact",
        status: "active",
        origin: "explicit",
      }),
    ).rejects.toThrow("was not found in the current channel");

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          channelId: "C1",
          memoryId: "chanmem_existing",
          text: "Existing fact",
          status: "active",
          origin: "explicit",
          createdAt: "created",
          updatedAt: "newer",
        },
      ],
    });
    await expect(
      repo.upsert({
        workspaceId: "T1",
        channelId: "C1",
        memoryId: "chanmem_existing",
        expectedUpdatedAt: "stale",
        text: "Updated fact",
        status: "active",
        origin: "explicit",
      }),
    ).rejects.toThrow("changed since it was loaded");
    expect(sendMock).toHaveBeenCalledTimes(2);
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
    expect(commandInput(2)).toMatchObject({ Limit: 5 });
  });

  it("sorts recent top-level turns by creation time after overfetching mixed sort keys", async () => {
    const repo = new ConversationTurnRepository("turns");
    const baseItem = {
      workspace_id: "T1",
      channel_id: "C1",
      conversation_ts: "100",
      context_scope: "channel_top_level",
      source: "line",
      source_event: "line_message",
      message_ts: "621106298603963083",
      user_id: "U1",
      text: "base",
    };
    const olderUser = {
      ...baseItem,
      turn_id: "older-user",
      role: "user",
      turn_ts: "621106298603963083",
      created_at: "2026-07-03T00:45:08.004Z",
      text: "remember this",
    };
    const middleUser = {
      ...baseItem,
      turn_id: "middle-user",
      role: "user",
      message_ts: "621106565746786307",
      turn_ts: "621106565746786307",
      created_at: "2026-07-03T00:47:46.643Z",
      text: "middle message",
    };
    const latestAssistant = {
      ...baseItem,
      turn_id: "latest-assistant",
      role: "assistant",
      source_event: "line_assistant_reply",
      message_ts: "1783039670907.414355",
      turn_ts: "1783039670907.414355",
      created_at: "2026-07-03T00:47:50.907Z",
      text: "assistant answer",
    };

    sendMock.mockResolvedValueOnce({
      Items: [middleUser, olderUser, latestAssistant],
    });

    await expect(repo.listRecentChannelTopLevelTurns("T1", "C1", 2)).resolves.toMatchObject([
      { turnId: "middle-user" },
      { turnId: "latest-assistant" },
    ]);
    expect(commandInput()).toMatchObject({
      Limit: 10,
      ScanIndexForward: false,
    });
  });
});

describe("agent turn trace repository", () => {
  it("saves and lists eval trace records by workspace", async () => {
    const repo = new AgentTurnTraceRepository("turn-traces");

    sendMock.mockResolvedValueOnce({});
    await repo.save({
      traceId: "trace-1",
      turnId: "turn-1",
      workspaceId: "T1",
      source: "slack",
      status: "completed",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:01.000Z",
      expiresAt: 1787529600,
      modelId: "moonshotai.kimi-k2.5",
      bedrockRegion: "ap-northeast-1",
      bedrockServiceTier: "flex",
      runtimeSessionId: "runtime-1",
      userIdHash: "user-hash",
      channelIdHash: "channel-hash",
      conversationId: "100",
      input: {
        text: "hello",
        blocks: [{ type: "text", text: "hello" }],
      },
      output: {
        text: "hi",
      },
      modelOutput: {
        text: "hi",
      },
      displayedOutput: {
        surface: "slack",
        text: "hi",
        messageTs: "100.1",
        threadTs: "100.0",
        channelIdHash: "channel-hash",
        postedAt: "2026-05-26T00:00:02.000Z",
      },
      toolCalls: [
        {
          toolCallId: "tool-1",
          name: "search_context",
          input: { task_statuses: ["open"] },
          output: { count: 0 },
          isError: false,
          startedAt: "2026-05-26T00:00:00.100Z",
          completedAt: "2026-05-26T00:00:00.200Z",
          durationMs: 100,
        },
      ],
      summary: {
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      },
      latencyMs: 1000,
    });

    expect(commandInput()).toMatchObject({
      TableName: "turn-traces",
      Item: {
        pk: "WORKSPACE#T1",
        sk: "TRACE#2026-05-26T00:00:00.000Z#trace-1#TURN#turn-1",
        gsi1pk: "TRACE#trace-1",
        gsi1sk: "2026-05-26T00:00:00.000Z#TURN#turn-1",
        trace_id: "trace-1",
        turn_id: "turn-1",
        expires_at: 1787529600,
        model_output: { text: "hi" },
        displayed_output: expect.objectContaining({ surface: "slack", messageTs: "100.1" }),
        tool_calls: [expect.objectContaining({ name: "search_context" })],
      },
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          trace_id: "trace-1",
          turn_id: "turn-1",
          workspace_id: "T1",
          source: "slack",
          status: "completed",
          created_at: "2026-05-26T00:00:00.000Z",
          updated_at: "2026-05-26T00:00:01.000Z",
          expires_at: 1787529600,
          input: { text: "hello", blocks: [] },
          output: { text: "hi" },
          model_output: { text: "hi" },
          displayed_output: { surface: "slack", text: "hi", postedAt: "2026-05-26T00:00:02.000Z" },
          tool_calls: [],
          summary: {
            taskIds: [],
            recurringTaskIds: [],
            savedMemoryIds: [],
            calendarDraftIds: [],
          },
          latency_ms: 1000,
        },
      ],
    });
    await expect(repo.listRecentByWorkspace({ workspaceId: "T1", limit: 500 })).resolves.toMatchObject([
      {
        traceId: "trace-1",
        turnId: "turn-1",
        expiresAt: 1787529600,
        modelOutput: { text: "hi" },
        displayedOutput: { surface: "slack" },
      },
    ]);
    expect(commandInput(1)).toMatchObject({
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": "WORKSPACE#T1",
      },
      ScanIndexForward: false,
      Limit: 200,
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          trace_id: "trace-1",
          turn_id: "turn-1",
          workspace_id: "T1",
          source: "slack",
          status: "completed",
          created_at: "2026-05-26T00:00:00.000Z",
          updated_at: "2026-05-26T00:00:01.000Z",
          expires_at: 1787529600,
          input: { text: "hello", blocks: [] },
          model_output: { text: "hi" },
          tool_calls: [],
          summary: {
            taskIds: [],
            recurringTaskIds: [],
            savedMemoryIds: [],
            calendarDraftIds: [],
          },
          latency_ms: 1000,
        },
      ],
    });
    await expect(repo.listByTraceId({ traceId: "trace-1", limit: 0 })).resolves.toMatchObject([
      { traceId: "trace-1", turnId: "turn-1" },
    ]);
    expect(commandInput(2)).toMatchObject({
      IndexName: "TraceIdIndex",
      KeyConditionExpression: "gsi1pk = :gsi1pk",
      ExpressionAttributeValues: {
        ":gsi1pk": "TRACE#trace-1",
      },
      ScanIndexForward: true,
      Limit: 1,
    });

    sendMock.mockResolvedValueOnce({
      Items: [
        {
          pk: "WORKSPACE#T1",
          sk: "TRACE#2026-05-26T00:00:00.000Z#trace-1#TURN#turn-1",
          trace_id: "trace-1",
          turn_id: "turn-1",
          workspace_id: "T1",
          source: "slack",
          status: "completed",
          created_at: "2026-05-26T00:00:00.000Z",
          updated_at: "2026-05-26T00:00:01.000Z",
          input: { text: "hello", blocks: [] },
          tool_calls: [],
          summary: {
            taskIds: [],
            recurringTaskIds: [],
            savedMemoryIds: [],
            calendarDraftIds: [],
          },
          latency_ms: 1000,
        },
      ],
    });
    sendMock.mockResolvedValueOnce({});
    await expect(
      repo.updateDisplayedOutput({
        traceId: "trace-1",
        turnId: "turn-1",
        displayedOutput: {
          surface: "slack",
          text: "updated",
          messageTs: "100.2",
          channelIdHash: "channel-hash",
          postedAt: "2026-05-26T00:00:03.000Z",
        },
        updatedAt: "2026-05-26T00:00:04.000Z",
      }),
    ).resolves.toBe(true);
    expect(commandInput(3)).toMatchObject({
      IndexName: "TraceIdIndex",
      KeyConditionExpression: "gsi1pk = :gsi1pk",
    });
    expect(commandInput(4)).toMatchObject({
      Key: {
        pk: "WORKSPACE#T1",
        sk: "TRACE#2026-05-26T00:00:00.000Z#trace-1#TURN#turn-1",
      },
      UpdateExpression: "SET displayed_output = :displayedOutput, updated_at = :updatedAt",
      ExpressionAttributeValues: {
        ":displayedOutput": expect.objectContaining({ surface: "slack", text: "updated" }),
        ":updatedAt": "2026-05-26T00:00:04.000Z",
      },
    });
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
      sourceType: "line_message_image" as const,
      sourceRef: "line:message:img-1",
      title: "LINE image img-1",
      lineMessageId: "img-1",
      channelId: "line:group:G1",
      messageTs: "msg-1",
      uploadedByUserId: "line:user:U1",
      mimeType: "image/jpeg",
      s3Bucket: "archived-line-images",
      s3Key: "line/group/G1/img-1.jpg",
      expiresAt: "2026-06-03T00:00:00.000Z",
      ttl: 1780444800,
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
        sourceType: "line_message_image",
        lineMessageId: "img-1",
        expiresAt: "2026-06-03T00:00:00.000Z",
        ttl: 1780444800,
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
