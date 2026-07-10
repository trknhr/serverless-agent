import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(function BedrockAgentCoreClient() {
    return {
      send: mocks.send,
    };
  }),
  InvokeAgentRuntimeCommand: vi.fn().mockImplementation(function InvokeAgentRuntimeCommand(input) {
    return { input };
  }),
}));

beforeEach(() => {
  mocks.send.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentCoreRuntimeClient", () => {
  it("aborts and rejects when the runtime response exceeds the configured timeout", async () => {
    vi.useFakeTimers();
    mocks.send.mockReturnValueOnce(new Promise(() => undefined));

    const { AgentCoreRuntimeClient } = await import("../src/agentcore/client");
    const client = new AgentCoreRuntimeClient({
      runtimeArn: "arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/test",
      responseTimeoutMs: 1000,
    });

    const result = client.invoke({
      request: {
        content: [{ type: "text", text: "hello" }],
        context: {
          source: "scheduler",
          workspaceId: "T1",
        },
      },
    });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const sendOptions = mocks.send.mock.calls[0][1] as { abortSignal: AbortSignal };
    expect(sendOptions.abortSignal.aborted).toBe(false);

    const expectation = expect(result).rejects.toThrow(
      "AgentCore runtime response timed out after 1000ms",
    );
    await vi.advanceTimersByTimeAsync(1000);

    await expectation;
    expect(sendOptions.abortSignal.aborted).toBe(true);
  });

  it("parses a successful SSE response before the timeout fires", async () => {
    vi.useFakeTimers();
    mocks.send.mockResolvedValueOnce({
      runtimeSessionId: "session-2",
      response: {
        transformToString: async () =>
          [
            "event: message",
            'data: {"text":"hello"}',
            "",
            "event: metadata",
            'data: {"taskIds":["task-1"],"traceId":"trace-1","turnId":"turn-1"}',
            "",
          ].join("\n"),
      },
    });

    const { AgentCoreRuntimeClient } = await import("../src/agentcore/client");
    const client = new AgentCoreRuntimeClient({
      runtimeArn: "arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/test",
      responseTimeoutMs: 1000,
    });

    await expect(
      client.invoke({
        request: {
          content: [{ type: "text", text: "hello" }],
          context: {
            source: "scheduler",
            workspaceId: "T1",
          },
        },
      }),
    ).resolves.toMatchObject({
      text: "hello",
      sessionId: "session-2",
      taskIds: ["task-1"],
      traceId: "trace-1",
      turnId: "turn-1",
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
