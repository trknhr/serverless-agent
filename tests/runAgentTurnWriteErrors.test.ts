import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeRequest } from "../src/agentcore/contracts";
import { AgentRunnerAi, runAgentTurn } from "../src/agentcore/runAgentTurn";
import { ToolExecutionResult } from "../src/agent/types";
import { Logger } from "../src/shared/logger";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";

describe("runAgentTurn write tool errors", () => {
  it("streams a failure notice when a write tool fails even if the model claims success", async () => {
    let agentOptions: {
      tools?: Record<string, { execute: (input: Record<string, unknown>) => Promise<ToolExecutionResult> }>;
    } = {};
    class FakeToolLoopAgent {
      constructor(options: unknown) {
        agentOptions = options as typeof agentOptions;
      }

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        await agentOptions.tools?.save_memory.execute({
          text: "テスト申請Aの期限7月7日（火）",
          scope: "channel",
        });

        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "保存しました" };
          })(),
        };
      }
    }
    const ai: AgentRunnerAi = {
      ToolLoopAgent: FakeToolLoopAgent,
      jsonSchema: (schema) => schema,
      tool: (options) => options,
    };
    const executor = {
      execute: vi.fn().mockResolvedValue({
        isError: true,
        content: [
          {
            type: "text",
            text: "save_memory for date-bearing text requires attributes.date_validation from normalize_date.",
          },
        ],
      }),
      getSummary: () => ({
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "一旦日程だけ覚えといて" }],
      context: {
        source: "slack",
        workspaceId: "T1",
        userId: "U1",
        channelId: "C1",
      },
      toolContext: {
        workspaceId: "T1",
        userId: "U1",
        channelId: "C1",
      },
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "write-tool-error-notice" }),
      createExecutor: () => executor,
    })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { event: "message", data: { text: "保存しました" } },
      {
        event: "message",
        data: {
          text: expect.stringContaining("保存できませんでした"),
        },
      },
      { event: "metadata", data: { taskIds: [], recurringTaskIds: [], savedMemoryIds: [] } },
    ]);
    expect(events[1]).toMatchObject({
      event: "message",
      data: {
        text: expect.stringContaining(
          "save_memory for date-bearing text requires attributes.date_validation from normalize_date.",
        ),
      },
    });
  });

  it("does not stream a failure notice when a failed write is corrected by a later successful write", async () => {
    let agentOptions: {
      tools?: Record<string, { execute: (input: Record<string, unknown>) => Promise<ToolExecutionResult> }>;
    } = {};
    class FakeToolLoopAgent {
      constructor(options: unknown) {
        agentOptions = options as typeof agentOptions;
      }

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        await agentOptions.tools?.upsert_task.execute({
          title: "テスト申請A",
          due_at: "2026-07-07T18:00:00+09:00",
        });
        await agentOptions.tools?.upsert_task.execute({
          title: "テスト申請A",
          due_at: "2026-07-07T18:00:00+09:00",
          metadata: {
            date_validation: {
              source_text: "7月7日（火）",
              normalized_date: "2026-07-07",
              basis_date: "2026-07-06",
              timezone: "Asia/Tokyo",
              is_past: false,
              is_today: false,
              weekday_text: "（火）",
              weekday_matches: true,
            },
          },
        });

        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "保存したよ" };
          })(),
        };
      }
    }
    const ai: AgentRunnerAi = {
      ToolLoopAgent: FakeToolLoopAgent,
      jsonSchema: (schema) => schema,
      tool: (options) => options,
    };
    const executor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          isError: true,
          content: [
            {
              type: "text",
              text: "upsert_task with due_at requires metadata.date_validation from normalize_date.",
            },
          ],
        })
        .mockResolvedValueOnce({
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                saved: true,
                task_id: "task_1",
                title: "テスト申請A",
                due_at: "2026-07-07T18:00:00+09:00",
              }),
            },
          ],
        }),
      getSummary: () => ({
        taskIds: ["task_1"],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "テスト申請Aを覚えて 7月7日（火）" }],
      context: {
        source: "slack",
        workspaceId: "T1",
        userId: "U1",
        channelId: "C1",
      },
      toolContext: {
        workspaceId: "T1",
        userId: "U1",
        channelId: "C1",
      },
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "write-tool-error-notice-corrected" }),
      createExecutor: () => executor,
    })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { event: "message", data: { text: "保存したよ" } },
      { event: "metadata", data: { taskIds: ["task_1"], recurringTaskIds: [], savedMemoryIds: [] } },
    ]);
    expect(events).toHaveLength(2);
  });
});
