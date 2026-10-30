import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeRequest } from "../src/agentcore/contracts";
import { AgentRunnerAi, runAgentTurn } from "../src/agentcore/runAgentTurn";
import { FileStateStore } from "../src/local/fileStateStore";
import { Logger } from "../src/shared/logger";
import { bearerMatches } from "../src/webchat/access";
import { FileWebChatStore } from "../src/webchat/fileWebChatStore";
import { collectWebChatEvents, routeWebChat } from "../src/webchat/http";
import { renderMarkdown } from "../src/webchat/markdown";
import { consumeSseBuffer, formatSse, parseSseDocument } from "../src/webchat/sse";
import { WebChatAgent } from "../src/webchat/turn";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("web chat markdown", () => {
  it("renders code, links, and lists without injecting html", () => {
    const html = renderMarkdown(
      [
        "Hello **there**",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "- one",
        "- `two`",
        "",
        "See [docs](https://example.com/docs) and https://example.com/raw",
        "",
        "<script>alert(1)</script>",
        "",
        "[bad](javascript:alert(1))",
      ].join("\n"),
    );

    expect(html).toContain("<strong>there</strong>");
    expect(html).toContain('<pre><code class="language-ts">const value = 1;</code></pre>');
    expect(html).toContain("<ul><li>one</li><li><code>two</code></li></ul>");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="https://example.com/raw"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("[bad](javascript:alert(1))");
  });

  it("keeps an unfinished fence as code while a reply is still streaming", () => {
    expect(renderMarkdown("```js\nconsole.log(1)")).toContain("<pre><code");
  });
});

describe("sse parsing", () => {
  it("keeps a partial event until the blank line arrives", () => {
    const first = consumeSseBuffer('event: delta\ndata: {"te');
    expect(first.events).toEqual([]);
    const second = consumeSseBuffer(`${first.rest}xt":"Hi"}\n\n`);
    expect(second.events).toEqual([{ event: "delta", data: '{"text":"Hi"}' }]);
    expect(parseSseDocument(formatSse("message", { text: "Hi" }))).toEqual([
      { event: "message", data: '{"text":"Hi"}' },
    ]);
  });
});

describe("web chat access key", () => {
  it("accepts only the exact bearer token", () => {
    expect(bearerMatches("Bearer secret-key", "secret-key")).toBe(true);
    expect(bearerMatches("bearer secret-key", "secret-key")).toBe(true);
    expect(bearerMatches("Bearer other-key", "secret-key")).toBe(false);
    expect(bearerMatches(undefined, "secret-key")).toBe(false);
  });
});

describe("web chat routes", () => {
  it("requires the configured bearer token and stores multi-turn history", async () => {
    const store = await createStore();
    const seen: Array<{ history: Array<{ role: string; content: string }>; sessionId: string }> = [];
    const agent: WebChatAgent = {
      async *run(input) {
        seen.push({ history: input.history, sessionId: input.sessionId });
        yield { event: "status", data: { text: "Searching the web" } };
        yield { event: "delta", data: { text: "Hel" } };
        yield { event: "delta", data: { text: "lo" } };
        yield { event: "message", data: { text: "Hello" } };
        yield {
          event: "metadata",
          data: {
            taskIds: [],
            recurringTaskIds: [],
            savedMemoryIds: [],
            calendarDraftIds: [],
            runtimeSessionId: "runtime-session-id-12345678901234567890",
          },
        };
      },
    };
    const deps = {
      store,
      agent,
      accessKey: "secret-key",
      allowUnauthenticated: false,
      now: (() => {
        let tick = 0;
        return () => new Date(Date.parse("2026-10-26T00:00:00.000Z") + tick++ * 1000);
      })(),
    };

    const denied = await routeWebChat(request("GET", "/api/conversations", { workspaceId: "local", userId: "user" }), deps);
    expect(denied).toMatchObject({ kind: "json", status: 401 });

    const created = await routeWebChat(
      request("POST", "/api/conversations", undefined, { workspaceId: "local", userId: "user" }, { authorization: "Bearer secret-key" }),
      deps,
    );
    expect(created).toMatchObject({ kind: "json", status: 201 });
    const conversationId = (created as { body: { conversation: { conversationId: string } } }).body.conversation.conversationId;

    const streamed = await routeWebChat(
      request(
        "POST",
        `/api/conversations/${conversationId}/messages`,
        undefined,
        { workspaceId: "local", userId: "user", text: "Hello there" },
        { authorization: "Bearer secret-key" },
      ),
      deps,
    );
    expect(streamed.kind).toBe("sse");
    if (streamed.kind !== "sse") {
      return;
    }
    const body = await collectWebChatEvents(streamed.events);
    expect(body).toContain("event: delta");
    expect(body).toContain("event: message");
    expect(seen[0]?.history).toEqual([]);
    expect(seen[0]?.sessionId).toBe(conversationId);

    const followUp = await routeWebChat(
      request(
        "POST",
        `/api/conversations/${conversationId}/messages`,
        undefined,
        { workspaceId: "local", userId: "user", text: "Second" },
        { authorization: "Bearer secret-key" },
      ),
      deps,
    );
    if (followUp.kind === "sse") {
      await collectWebChatEvents(followUp.events);
    }
    expect(seen[1]?.history).toEqual([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hello" },
    ]);

    const listed = await routeWebChat(
      request("GET", "/api/conversations", { workspaceId: "local", userId: "user" }, undefined, {
        authorization: "Bearer secret-key",
      }),
      deps,
    );
    expect(listed).toMatchObject({
      kind: "json",
      status: 200,
      body: { conversations: [expect.objectContaining({ title: "Hello there" })] },
    });

    const messages = await routeWebChat(
      request("GET", `/api/conversations/${conversationId}/messages`, { workspaceId: "local", userId: "user" }, undefined, {
        authorization: "Bearer secret-key",
      }),
      deps,
    );
    expect(messages).toMatchObject({
      kind: "json",
      body: {
        messages: [
          expect.objectContaining({ role: "user", text: "Hello there" }),
          expect.objectContaining({ role: "assistant", text: "Hello" }),
          expect.objectContaining({ role: "user", text: "Second" }),
          expect.objectContaining({ role: "assistant", text: "Hello" }),
        ],
      },
    });
  });

  it("fails closed when no access key is configured", async () => {
    const result = await routeWebChat(request("GET", "/api/conversations"), {
      store: await createStore(),
      agent: { async *run() { /* unused */ } },
      allowUnauthenticated: false,
    });
    expect(result).toMatchObject({ kind: "json", status: 503 });
  });

  it("uses the authenticated owner instead of caller-supplied owner fields", async () => {
    const store = await createStore();
    const deps = {
      store,
      agent: { async *run() { /* unused */ } },
      authenticatedOwner: { workspaceId: "cognito:pool", userId: "verified-sub" },
    };
    const created = await routeWebChat(
      request("POST", "/api/conversations", undefined, { workspaceId: "spoofed", userId: "attacker" }),
      deps,
    );
    expect(created).toMatchObject({
      status: 201,
      body: {
        conversation: { workspaceId: "cognito:pool", userId: "verified-sub" },
      },
    });
    const listed = await routeWebChat(
      request("GET", "/api/conversations", { workspaceId: "spoofed", userId: "attacker" }),
      deps,
    );
    expect(listed).toMatchObject({ status: 200, body: { conversations: [expect.any(Object)] } });
  });

  it("returns 400 for an empty message and 404 for an unknown conversation", async () => {
    const deps = {
      store: await createStore(),
      agent: { async *run() { /* unused */ } },
      allowUnauthenticated: true,
    };
    await expect(routeWebChat(request("POST", "/api/conversations/missing/messages", undefined, { workspaceId: "w", userId: "u", text: "" }), deps)).resolves.toMatchObject({
      status: 400,
    });
    const missing = await routeWebChat(
      request("POST", "/api/conversations/missing/messages", undefined, { workspaceId: "w", userId: "u", text: "hi" }),
      deps,
    );
    expect(missing.kind).toBe("sse");
    if (missing.kind === "sse") {
      const body = await collectWebChatEvents(missing.events);
      expect(body).toContain("Conversation was not found");
    }
    await expect(routeWebChat(request("GET", "/nope"), deps)).resolves.toMatchObject({ status: 404 });
  });
});

describe("web chat model streaming", () => {
  it("streams deltas for web chat and still replaces an unverified write claim", async () => {
    const events = [];
    for await (const event of runAgentTurn({
      request: webRequest("保存しました"),
      ai: fakeAgent(async function* () {
        yield { type: "tool-call", toolName: "save_memory" };
        yield { type: "text-delta", text: "保存しました" };
      }),
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "web-delta" }),
      createExecutor: () =>
        ({
          execute: vi.fn().mockResolvedValue({
            isError: true,
            content: [{ type: "text", text: "save failed" }],
          }),
          getSummary: () => ({ taskIds: [], recurringTaskIds: [], savedMemoryIds: [], calendarDraftIds: [] }),
        }) as never,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.event)).toEqual(["status", "delta", "message", "metadata"]);
    expect(events[1]).toMatchObject({ event: "delta", data: { text: "保存しました" } });
    expect(events[2]).toMatchObject({
      event: "message",
      data: { text: expect.stringContaining("確認できませんでした") },
    });
  });

  it("passes stored history as model messages and does not write the process-local session map", async () => {
    let captured: Array<{ role: string; content: unknown }> = [];
    const store = {
      get: vi.fn(async () => [{ role: "user" as const, content: "from-store" }]),
      set: vi.fn(async () => undefined),
    };
    const events = [];
    for await (const event of runAgentTurn({
      request: {
        ...webRequest("next"),
        history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
      },
      sessionId: "conv_123",
      sessionHistoryStore: store,
      ai: fakeAgent(async function* () {
        yield { type: "text-delta", text: "ok" };
      }, (messages) => {
        captured = messages;
      }),
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "web-history" }),
    })) {
      events.push(event);
    }

    expect(captured.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(captured[0]).toMatchObject({ content: "earlier" });
    expect(captured[1]).toMatchObject({ content: "reply" });
    expect(store.set).not.toHaveBeenCalled();
    expect(events.some((event) => event.event === "delta")).toBe(true);
  });

  it("keeps slack replies as a single message event", async () => {
    const events = [];
    for await (const event of runAgentTurn({
      request: {
        content: [{ type: "text", text: "hello" }],
        context: { source: "slack", workspaceId: "T1" },
      },
      ai: fakeAgent(async function* () {
        yield { type: "text-delta", text: "Hel" };
        yield { type: "text-delta", text: "lo" };
      }),
      modelProvider: () => ({}),
      modelId: "test-model",
      log: new Logger({ test: "slack-buffered" }),
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.event)).toEqual(["message", "metadata"]);
    expect(events[0]).toMatchObject({ data: { text: "Hello" } });
  });
});

async function createStore(): Promise<FileWebChatStore> {
  const dir = await mkdtemp(join(tmpdir(), "web-chat-"));
  tempDirs.push(dir);
  return new FileWebChatStore(new FileStateStore(join(dir, "state.json")));
}

function request(
  method: string,
  path: string,
  query?: Record<string, string>,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return { method, path, query: query ?? {}, body, headers };
}

function webRequest(text: string): AgentRuntimeRequest {
  return {
    content: [{ type: "text", text }],
    context: { source: "web_chat", workspaceId: "local", userId: "user" },
    toolContext: { workspaceId: "local", userId: "user" },
  };
}

function fakeAgent(
  stream: () => AsyncGenerator<Record<string, unknown>>,
  onMessages?: (messages: Array<{ role: string; content: unknown }>) => void,
): AgentRunnerAi {
  return {
    ToolLoopAgent: class {
      async stream(options: { messages?: Array<{ role: string; content: unknown }> }) {
        onMessages?.(options.messages ?? []);
        return { fullStream: stream() };
      }
    } as unknown as AgentRunnerAi["ToolLoopAgent"],
    jsonSchema: (schema) => schema,
    tool: (options) => options,
  };
}
