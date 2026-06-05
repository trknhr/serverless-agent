import { describe, expect, it, vi } from "vitest";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import { Logger } from "../src/shared/logger";

function toolPayload(result: Awaited<ReturnType<CustomToolExecutor["execute"]>>): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("search_context tool", () => {
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
