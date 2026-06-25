import { describe, expect, it, vi } from "vitest";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import { Logger } from "../src/shared/logger";

function toolPayload(result: Awaited<ReturnType<CustomToolExecutor["execute"]>>): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("search_context tool", () => {
  it("falls back to task keyword search when list_tasks is selected for a search request", async () => {
    const tasks = {
      list: vi.fn(),
      search: vi.fn().mockResolvedValue([
        {
          workspaceId: "T1",
          taskId: "task_synthetic_card",
          title: "Submit synthetic card",
          description: "Prepare the synthetic reference card.",
          status: "open",
          dueAt: "2026-06-05T23:59:00+09:00",
          updatedAt: "2026-06-05T00:05:00.000Z",
        },
      ]),
    };
    const executor = new CustomToolExecutor(
      {
        tasks,
        taskEvents: {},
        memoryItems: {},
      } as never,
      {
        workspaceId: "T1",
        userId: "U1",
        logger: new Logger({ test: "list-tasks-search-fallback" }),
        currentRequestText: "Search tasks for synthetic reference card.",
      },
    );

    const result = await executor.execute({
      id: "tool-list-tasks",
      type: "agent.tool_use",
      name: "list_tasks",
      input: {},
    });

    expect(tasks.search).toHaveBeenCalledWith({
      workspaceId: "T1",
      query: "synthetic reference card",
      statuses: undefined,
      dueBefore: undefined,
      limit: undefined,
    });
    expect(tasks.list).not.toHaveBeenCalled();
    expect(toolPayload(result)).toMatchObject({
      mode: "keyword_search",
      query: "synthetic reference card",
      count: 1,
      tasks: [
        {
          task_id: "task_synthetic_card",
          title: "Submit synthetic card",
          status: "open",
        },
      ],
    });
  });

  it("does not owner-filter task lists for scheduled reminders", async () => {
    const tasks = {
      list: vi.fn().mockResolvedValue([
        {
          workspaceId: "T1",
          taskId: "task_imported",
          title: "Imported shared reminder",
          description: "Synthetic imported reminder",
          status: "open",
          dueAt: "2026-06-24T23:59:00+09:00",
          ownerUserId: "imported-owner",
          updatedAt: "2026-06-16T23:00:18.653Z",
        },
        {
          workspaceId: "T1",
          taskId: "task_user_owned",
          title: "User-owned weekend reminder",
          description: "Synthetic user-owned reminder",
          status: "open",
          dueAt: "2026-06-28T09:50:00+09:00",
          ownerUserId: "U1",
          updatedAt: "2026-06-20T23:00:18.360Z",
        },
      ]),
    };
    const executor = new CustomToolExecutor(
      {
        tasks,
        taskEvents: {},
        memoryItems: {},
      } as never,
      {
        source: "scheduler",
        workspaceId: "T1",
        userId: "U1",
        logger: new Logger({ test: "scheduled-list-tasks-owner-filter" }),
      } as never,
    );

    const result = await executor.execute({
      id: "tool-list-tasks-scheduled",
      type: "agent.tool_use",
      name: "list_tasks",
      input: { statuses: ["open", "in_progress"] },
    });

    expect(tasks.list).toHaveBeenCalledWith({
      workspaceId: "T1",
      statuses: ["open", "in_progress"],
      dueBefore: undefined,
      limit: undefined,
      ownerUserId: undefined,
    });
    expect(toolPayload(result)).toMatchObject({
      count: 2,
      tasks: [
        {
          task_id: "task_imported",
          title: "Imported shared reminder",
        },
        {
          task_id: "task_user_owned",
          title: "User-owned weekend reminder",
        },
      ],
    });
  });

  it("searches saved tasks and memories through one read-only tool", async () => {
    const memoryItems = {
      search: vi.fn().mockResolvedValue([
        {
          memoryId: "mem_synthetic",
          entityKey: "topic:synthetic-reference",
          text: "Synthetic reference details live in durable memory.",
          attributes: { source: "test" },
          tags: ["reference"],
          importance: 0.7,
          updatedAt: "2026-06-05T00:00:00.000Z",
        },
      ]),
    };
    const tasks = {
      search: vi.fn().mockResolvedValue([
        {
          workspaceId: "T1",
          taskId: "task_synthetic",
          title: "Synthetic reference follow-up",
          description: "Follow up on the synthetic reference.",
          status: "done",
          priority: "medium",
          updatedAt: "2026-06-05T00:05:00.000Z",
        },
      ]),
    };
    const webProvider = {
      search: vi.fn(),
      extract: vi.fn(),
    };
    const executor = new CustomToolExecutor(
      {
        memoryItems,
        tasks,
        taskEvents: {},
      } as never,
      {
        workspaceId: "T1",
        userId: "U1",
        logger: new Logger({ test: "search-context" }),
      },
      {
        webProvider,
      } as never,
    );

    const result = await executor.execute({
      id: "tool-search-context",
      type: "agent.tool_use",
      name: "search_context",
      input: { query: "synthetic reference", limit: 3 },
    });

    expect(tasks.search).toHaveBeenCalledWith({
      workspaceId: "T1",
      query: "synthetic reference",
      statuses: undefined,
      dueBefore: undefined,
      limit: 3,
    });
    expect(memoryItems.search).toHaveBeenCalledWith({
      workspaceId: "T1",
      query: "synthetic reference",
      entityKey: undefined,
      limit: 3,
    });
    expect(webProvider.search).not.toHaveBeenCalled();
    expect(toolPayload(result)).toMatchObject({
      query: "synthetic reference",
      count: 2,
      tasks: [
        {
          task_id: "task_synthetic",
          title: "Synthetic reference follow-up",
          status: "done",
        },
      ],
      memories: [
        {
          scope: "workspace",
          memory_id: "mem_synthetic",
          text: "Synthetic reference details live in durable memory.",
        },
      ],
    });
  });

  it("runs agent-provided context queries without generating variants", async () => {
    const memoryItems = {
      search: vi.fn(async (input: { query: string }) =>
        input.query === "alpha-card"
          ? [
              {
                memoryId: "mem_alpha_card",
                entityKey: "topic:alpha-card",
                text: "Synthetic alpha-card reference is scheduled on the second Friday.",
                tags: ["synthetic", "reference"],
                importance: 0.8,
                updatedAt: "2026-04-17T05:51:07.963Z",
              },
            ]
          : [],
      ),
    };
    const tasks = {
      search: vi.fn().mockResolvedValue([]),
    };
    const recurringTasks = {
      list: vi.fn().mockResolvedValue([
        {
          recurringTaskId: "rt_alpha_card",
          workspaceId: "T1",
          title: "Alpha-card recurring reminder",
          description: "Synthetic recurring reminder for alpha-card",
          recurrence: {
            frequency: "monthly",
            interval: 1,
            daysOfWeek: ["friday"],
            weekOfMonth: 2,
          },
          dueTime: "23:59",
          timezone: "Asia/Tokyo",
          enabled: true,
          ownerUserId: "U1",
          priority: "medium",
          sourceType: "agent",
          updatedAt: "2026-05-11T13:30:28.010Z",
        },
      ]),
    };
    const executor = new CustomToolExecutor(
      {
        memoryItems,
        tasks,
        taskEvents: {},
        recurringTasks,
      } as never,
      {
        workspaceId: "T1",
        userId: "U1",
        logger: new Logger({ test: "search-context-recurring-fallback" }),
      },
    );

    const result = await executor.execute({
      id: "tool-search-context-alpha-card",
      type: "agent.tool_use",
      name: "search_context",
      input: {
        query: "registered alpha-card reference",
        queries: ["alpha-card"],
        limit: 5,
      },
    });

    expect(memoryItems.search).toHaveBeenCalledTimes(2);
    expect(memoryItems.search).toHaveBeenCalledWith({
      workspaceId: "T1",
      query: "registered alpha-card reference",
      entityKey: undefined,
      limit: 5,
    });
    expect(memoryItems.search).toHaveBeenCalledWith({
      workspaceId: "T1",
      query: "alpha-card",
      entityKey: undefined,
      limit: 5,
    });
    expect(toolPayload(result)).toMatchObject({
      query: "registered alpha-card reference",
      searched_queries: ["registered alpha-card reference", "alpha-card"],
      count: 2,
      memories: [
        {
          scope: "workspace",
          memory_id: "mem_alpha_card",
          text: "Synthetic alpha-card reference is scheduled on the second Friday.",
        },
      ],
      recurring_tasks: [
        {
          recurring_task_id: "rt_alpha_card",
          title: "Alpha-card recurring reminder",
          recurrence: {
            frequency: "monthly",
            interval: 1,
            days_of_week: ["friday"],
            week_of_month: 2,
          },
        },
      ],
    });
  });

  it("adds public web results only when explicitly requested", async () => {
    const memoryItems = {
      search: vi.fn().mockResolvedValue([]),
    };
    const tasks = {
      search: vi.fn().mockResolvedValue([]),
    };
    const webProvider = {
      search: vi.fn().mockResolvedValue({
        provider: "brave",
        query: "synthetic release notes",
        count: 1,
        results: [
          {
            title: "Synthetic release notes",
            url: "https://example.com/release-notes",
            description: "Example public result.",
          },
        ],
      }),
      extract: vi.fn(),
    };
    const executor = new CustomToolExecutor(
      {
        memoryItems,
        tasks,
        taskEvents: {},
      } as never,
      {
        workspaceId: "T1",
        logger: new Logger({ test: "search-context-web" }),
      },
      {
        webProvider,
      } as never,
    );

    const result = await executor.execute({
      id: "tool-search-context-web",
      type: "agent.tool_use",
      name: "search_context",
      input: { query: "synthetic release notes", include_web: true, limit: 12, language: "en" },
    });

    expect(webProvider.search).toHaveBeenCalledWith({
      query: "synthetic release notes",
      limit: 10,
      country: undefined,
      language: "en",
      freshness: undefined,
      domains: undefined,
    });
    expect(toolPayload(result)).toMatchObject({
      count: 1,
      web: {
        provider: "brave",
        count: 1,
        results: [
          {
            title: "Synthetic release notes",
            url: "https://example.com/release-notes",
          },
        ],
      },
    });
  });
});
