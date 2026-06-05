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
          taskId: "task_pool_card",
          title: "Submit swimming form",
          description: "Prepare the pool card before the swimming lesson.",
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
        currentRequestText: "タスクからプールカードを検索できる？",
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
      query: "プールカード",
      statuses: undefined,
      dueBefore: undefined,
      limit: undefined,
    });
    expect(tasks.list).not.toHaveBeenCalled();
    expect(toolPayload(result)).toMatchObject({
      mode: "keyword_search",
      query: "プールカード",
      count: 1,
      tasks: [
        {
          task_id: "task_pool_card",
          title: "Submit swimming form",
          status: "open",
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
