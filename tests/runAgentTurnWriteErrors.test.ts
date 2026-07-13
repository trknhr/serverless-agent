import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeRequest } from "../src/agentcore/contracts";
import { AgentRunnerAi, runAgentTurn } from "../src/agentcore/runAgentTurn";
import { ToolExecutionResult } from "../src/agent/types";
import { Logger } from "../src/shared/logger";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";

describe("runAgentTurn write tool errors", () => {
  it("replaces an unsupported success claim when a write tool fails", async () => {
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
      {
        event: "message",
        data: {
          text: expect.stringContaining("保存できませんでした"),
        },
      },
      { event: "metadata", data: { taskIds: [], recurringTaskIds: [], savedMemoryIds: [] } },
    ]);
    expect(events[0]).toMatchObject({
      event: "message",
      data: {
        text: expect.stringContaining(
          "save_memory for date-bearing text requires attributes.date_validation from normalize_date.",
        ),
      },
    });
    expect(events[0]).not.toMatchObject({ event: "message", data: { text: "保存しました" } });
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

  it("replaces a write success claim when no write tool ran and separates model output from audited output", async () => {
    class FakeToolLoopAgent {
      constructor(_options: unknown) {}

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
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
      execute: vi.fn(),
      getSummary: () => ({
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const historyStore = {
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const saveTurnTrace = vi.fn().mockResolvedValue(undefined);
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "この内容を覚えておいて" }],
      context: {
        source: "direct_chat_api",
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
      sessionId: "session-write-audit",
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "missing-write-tool-claim" }),
      createExecutor: () => executor,
      sessionHistoryStore: historyStore,
      saveTurnTrace,
    })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      {
        event: "message",
        data: { text: expect.stringContaining("宣言された変更を確認できませんでした") },
      },
      { event: "metadata", data: { taskIds: [], recurringTaskIds: [], savedMemoryIds: [] } },
    ]);
    expect(JSON.stringify(events)).not.toContain("保存しました");
    expect(historyStore.set).toHaveBeenCalledWith("session-write-audit", [
      { role: "user", content: "この内容を覚えておいて" },
      { role: "assistant", content: expect.stringContaining("宣言された変更を確認できませんでした") },
    ]);
    expect(saveTurnTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOutput: { text: "保存しました" },
        output: { text: expect.stringContaining("宣言された変更を確認できませんでした") },
      }),
    );
  });

  it("does not accept a read-only search as evidence that a task was completed", async () => {
    let agentOptions: {
      tools?: Record<string, { execute: (input: Record<string, unknown>) => Promise<ToolExecutionResult> }>;
    } = {};
    class FakeToolLoopAgent {
      constructor(options: unknown) {
        agentOptions = options as typeof agentOptions;
      }

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        await agentOptions.tools?.search_context.execute({
          query: "テスト申請A",
          task_statuses: ["open", "in_progress"],
        });
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "完了にしました" };
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
        content: [{ type: "text", text: JSON.stringify({ tasks: [{ task_id: "task_1" }] }) }],
      }),
      getSummary: () => ({
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "テスト申請Aを完了にして" }],
      context: { source: "slack", workspaceId: "T1", userId: "U1", channelId: "C1" },
      toolContext: { workspaceId: "T1", userId: "U1", channelId: "C1" },
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "read-only-completion-claim" }),
      createExecutor: () => executor,
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      event: "message",
      data: { text: expect.stringContaining("宣言された変更を確認できませんでした") },
    });
    expect(JSON.stringify(events)).not.toContain("完了にしました");
  });

  it("keeps a task completion claim after mark_task_done succeeds", async () => {
    let agentOptions: {
      tools?: Record<string, { execute: (input: Record<string, unknown>) => Promise<ToolExecutionResult> }>;
    } = {};
    class FakeToolLoopAgent {
      constructor(options: unknown) {
        agentOptions = options as typeof agentOptions;
      }

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        await agentOptions.tools?.mark_task_done.execute({ task_id: "task_1" });
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "完了にしました" };
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
        content: [{ type: "text", text: JSON.stringify({ saved: true, task_id: "task_1", status: "done" }) }],
      }),
      getSummary: () => ({
        taskIds: ["task_1"],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "テスト申請Aを完了にして" }],
      context: { source: "slack", workspaceId: "T1", userId: "U1", channelId: "C1" },
      toolContext: { workspaceId: "T1", userId: "U1", channelId: "C1" },
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "successful-completion-claim" }),
      createExecutor: () => executor,
    })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { event: "message", data: { text: "完了にしました" } },
      { event: "metadata", data: { taskIds: ["task_1"] } },
    ]);
  });

  it.each([
    "完了にしました",
    "タスクを作成しました",
  ])("does not use a memory write to support a task-domain claim: %s", async (modelText) => {
    let agentOptions: {
      tools?: Record<string, { execute: (input: Record<string, unknown>) => Promise<ToolExecutionResult> }>;
    } = {};
    class FakeToolLoopAgent {
      constructor(options: unknown) {
        agentOptions = options as typeof agentOptions;
      }

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        await agentOptions.tools?.save_memory.execute({ text: "テスト用メモ", scope: "channel" });
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: modelText };
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
        content: [{ type: "text", text: JSON.stringify({ saved: true, memory_id: "mem_1" }) }],
      }),
      getSummary: () => ({
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: ["mem_1"],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "テスト申請Aを完了にして" }],
      context: { source: "slack", workspaceId: "T1", userId: "U1", channelId: "C1" },
      toolContext: { workspaceId: "T1", userId: "U1", channelId: "C1" },
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "unrelated-write-completion-claim" }),
      createExecutor: () => executor,
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      event: "message",
      data: { text: expect.stringContaining("宣言された変更を確認できませんでした") },
    });
    expect(events[1]).toMatchObject({ event: "metadata", data: { savedMemoryIds: ["mem_1"] } });
  });

  it.each([
    "対象タスクを完了登録しました",
    "購入済みとのこと、メモしておきます",
  ])("blocks an unverified production write-claim form: %s", async (modelText) => {
    class FakeToolLoopAgent {
      constructor(_options: unknown) {}

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: modelText };
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
      execute: vi.fn(),
      getSummary: () => ({
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "更新して" }],
      context: { source: "slack", workspaceId: "T1", userId: "U1", channelId: "C1" },
      toolContext: { workspaceId: "T1", userId: "U1", channelId: "C1" },
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "production-write-claim" }),
      createExecutor: () => executor,
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      event: "message",
      data: { text: expect.stringContaining("宣言された変更を確認できませんでした") },
    });
  });

  it("keeps a memory-domain claim after save_memory succeeds", async () => {
    let agentOptions: {
      tools?: Record<string, { execute: (input: Record<string, unknown>) => Promise<ToolExecutionResult> }>;
    } = {};
    class FakeToolLoopAgent {
      constructor(options: unknown) {
        agentOptions = options as typeof agentOptions;
      }

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        await agentOptions.tools?.save_memory.execute({ text: "購入済み", scope: "channel" });
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "購入済みとのこと、メモしておきます" };
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
        content: [{ type: "text", text: JSON.stringify({ saved: true, memory_id: "mem_1" }) }],
      }),
      getSummary: () => ({
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: ["mem_1"],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "購入済みと覚えておいて" }],
      context: { source: "slack", workspaceId: "T1", userId: "U1", channelId: "C1" },
      toolContext: { workspaceId: "T1", userId: "U1", channelId: "C1" },
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "successful-memory-claim" }),
      createExecutor: () => executor,
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      event: "message",
      data: { text: "購入済みとのこと、メモしておきます" },
    });
  });

  it.each([
    "その情報は既に保存されています。",
    "どのタスクを完了にしますか？",
    "そのタスクは既に完了しました。",
    "作業が完了しました。",
    "作業が完了しましたね。",
  ])("does not flag a read-only state description or clarification: %s", async (modelText) => {
    class FakeToolLoopAgent {
      constructor(_options: unknown) {}

      async stream(): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: modelText };
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
      execute: vi.fn(),
      getSummary: () => ({
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      }),
    } as unknown as CustomToolExecutor;
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "確認して" }],
      context: { source: "slack", workspaceId: "T1", userId: "U1", channelId: "C1" },
      toolContext: { workspaceId: "T1", userId: "U1", channelId: "C1" },
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "non-write-claim" }),
      createExecutor: () => executor,
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ event: "message", data: { text: modelText } });
  });
});
