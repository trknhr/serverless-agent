import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimeRequest } from "../src/agentcore/contracts";
import { AgentRunnerAi, runAgentTurn } from "../src/agentcore/runAgentTurn";
import { FileStateStore } from "../src/local/fileStateStore";
import { createLocalRepositories } from "../src/local/localRepositories";
import { Logger } from "../src/shared/logger";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempStateStore(): Promise<FileStateStore> {
  const dir = await mkdtemp(join(tmpdir(), "serverless-agent-local-"));
  tempDirs.push(dir);
  return new FileStateStore(join(dir, "state.json"));
}

describe("local development state", () => {
  it("serializes concurrent file-backed updates in one process", async () => {
    const store = await createTempStateStore();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = store.update(async (state) => {
      order.push("first:start");
      markFirstStarted();
      await firstGate;
      state.sessionHistories.first = [];
      order.push("first:end");
    });
    const second = store.update((state) => {
      order.push("second:start");
      state.sessionHistories.second = [];
      order.push("second:end");
    });

    await firstStarted;
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    await expect(store.load()).resolves.toMatchObject({
      sessionHistories: { first: [], second: [] },
    });
  });

  it("persists memory, task, and session history in a file-backed state store", async () => {
    const store = await createTempStateStore();
    const repositories = createLocalRepositories(store);

    const memory = await repositories.memoryItems.save({
      workspaceId: "local-workspace",
      text: "Local development uses file-backed state.",
      tags: ["local"],
      importance: 0.8,
    });
    const task = await repositories.tasks.upsert({
      workspaceId: "local-workspace",
      title: "Run local smoke test",
      status: "open",
      ownerUserId: "local-user",
    });
    await store.set("local-session", [
      { role: "user", content: "remember local state" },
      { role: "assistant", content: "stored" },
    ]);

    const reloaded = createLocalRepositories(store);
    await expect(
      reloaded.memoryItems.search({
        workspaceId: "local-workspace",
        query: "file-backed",
      }),
    ).resolves.toMatchObject([{ memoryId: memory.memoryId }]);
    await expect(reloaded.tasks.get("local-workspace", task.taskId)).resolves.toMatchObject({
      taskId: task.taskId,
      title: "Run local smoke test",
    });
    await expect(store.get("local-session")).resolves.toHaveLength(2);
  });

  it("runs an agent turn with file-backed local session history", async () => {
    const store = await createTempStateStore();
    const streamInputs: unknown[] = [];
    class FakeToolLoopAgent {
      constructor(_options: unknown) {}

      async stream(input: unknown): Promise<{ fullStream: AsyncIterable<Record<string, unknown>> }> {
        streamInputs.push(input);
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: "local ok" };
          })(),
        };
      }
    }
    const ai: AgentRunnerAi = {
      ToolLoopAgent: FakeToolLoopAgent,
      jsonSchema: (schema) => schema,
      tool: (options) => options,
    };
    const request: AgentRuntimeRequest = {
      content: [{ type: "text", text: "hello" }],
      context: {
        source: "local_dev_cli",
        workspaceId: "local-workspace",
        userId: "local-user",
      },
      disableTools: true,
    };

    const events = [];
    for await (const event of runAgentTurn({
      request,
      sessionId: "local-session",
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "local-runner" }),
      sessionHistoryStore: store,
      useSessionHistory: () => true,
    })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { event: "message", data: { text: "local ok" } },
      { event: "metadata", data: { taskIds: [], recurringTaskIds: [], savedMemoryIds: [] } },
    ]);
    await expect(store.get("local-session")).resolves.toMatchObject([
      { role: "user", content: "hello" },
      { role: "assistant", content: "local ok" },
    ]);

    for await (const _event of runAgentTurn({
      request,
      sessionId: "local-session",
      ai,
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "local-runner" }),
      sessionHistoryStore: store,
      useSessionHistory: () => true,
    })) {
      // Consume the stream so the second call captures its input.
    }

    expect(streamInputs[1]).toMatchObject({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "local ok" },
        { role: "user" },
      ],
    });
  });
});
