import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLineContextBlocks } from "../src/conversations/buildLineContextBlocks";
import { LineMessagingClient, splitTextForLine } from "../src/line/postMessage";
import { extractLineQueueMessages, parseLineWebhook } from "../src/line/parseEvent";
import { verifyLineSignature } from "../src/line/verifySignature";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LINE request signatures", () => {
  it("accepts valid signatures and rejects missing or mismatched signatures", () => {
    const rawBody = JSON.stringify({ destination: "Ubot", events: [] });
    const signature = createHmac("sha256", "secret").update(rawBody).digest("base64");

    expect(
      verifyLineSignature({
        rawBody,
        signature,
        channelSecret: "secret",
      }),
    ).toBe(true);
    expect(
      verifyLineSignature({
        rawBody,
        channelSecret: "secret",
      }),
    ).toBe(false);
    expect(
      verifyLineSignature({
        rawBody,
        signature,
        channelSecret: "wrong",
      }),
    ).toBe(false);
    expect(
      verifyLineSignature({
        rawBody,
        signature: "short",
        channelSecret: "secret",
      }),
    ).toBe(false);
  });
});

describe("LINE webhook parsing", () => {
  it("extracts supported text message events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));
    const webhook = parseLineWebhook(
      JSON.stringify({
        destination: "Ubot",
        events: [
          {
            type: "message",
            webhookEventId: "event-1",
            replyToken: "reply-1",
            timestamp: 1710000000000,
            source: { type: "user", userId: "U1" },
            message: { id: "msg-1", type: "text", text: "  hello LINE  " },
          },
          {
            type: "message",
            webhookEventId: "event-2",
            source: { type: "group", groupId: "G1", userId: "U2" },
            message: { id: "msg-2", type: "sticker" },
          },
        ],
      }),
    );

    expect(extractLineQueueMessages(webhook, "corr")).toEqual([
      {
        correlationId: "corr:0",
        eventId: "event-1",
        workspaceId: "line:user:U1",
        providerAccountId: "Ubot",
        channelId: "line:user:U1",
        conversationTs: "line:user:U1",
        messageTs: "msg-1",
        userId: "line:user:U1",
        text: "hello LINE",
        replyToken: "reply-1",
        responseTargetId: "U1",
        responseTargetType: "user",
        source: "message",
        contextScope: "channel_top_level",
        receivedAt: "2026-05-18T00:00:00.000Z",
        attachments: [],
      },
    ]);
  });

  it("extracts image message events for worker-side content download", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));
    const webhook = parseLineWebhook(
      JSON.stringify({
        destination: "Ubot",
        events: [
          {
            type: "message",
            webhookEventId: "event-image",
            source: { type: "user", userId: "U1" },
            message: { id: "img-1", type: "image" },
          },
        ],
      }),
    );

    expect(extractLineQueueMessages(webhook, "corr")).toEqual([
      {
        correlationId: "corr:0",
        eventId: "event-image",
        workspaceId: "line:user:U1",
        providerAccountId: "Ubot",
        channelId: "line:user:U1",
        conversationTs: "line:user:U1",
        messageTs: "img-1",
        userId: "line:user:U1",
        text: expect.stringContaining("Analyze the image content directly"),
        responseTargetId: "U1",
        responseTargetType: "user",
        source: "message",
        contextScope: "channel_top_level",
        receivedAt: "2026-05-18T00:00:00.000Z",
        attachments: [{ id: "img-1", type: "image", contentType: "image/jpeg" }],
      },
    ]);
  });

  it("uses group and room ids as response targets", () => {
    const groupWebhook = parseLineWebhook(
      JSON.stringify({
        destination: "Ubot",
        events: [
          {
            type: "message",
            source: { type: "group", groupId: "G1", userId: "U1" },
            message: { id: "msg-1", type: "text", text: "group hello" },
          },
          {
            type: "message",
            source: { type: "room", roomId: "R1" },
            message: { id: "msg-2", type: "text", text: "room hello" },
          },
        ],
      }),
    );

    expect(extractLineQueueMessages(groupWebhook, "corr")).toMatchObject([
      {
        workspaceId: "line:group:G1",
        channelId: "line:group:G1",
        responseTargetId: "G1",
        responseTargetType: "group",
        userId: "line:user:U1",
      },
      {
        workspaceId: "line:room:R1",
        channelId: "line:room:R1",
        responseTargetId: "R1",
        responseTargetType: "room",
        userId: "line:room:R1",
      },
    ]);
  });

  it("ignores blank text and sources without usable response targets", () => {
    const webhook = parseLineWebhook(
      JSON.stringify({
        destination: "Ubot",
        events: [
          {
            type: "message",
            source: { type: "user" },
            message: { id: "msg-1", type: "text", text: "hello" },
          },
          {
            type: "message",
            source: { type: "group", groupId: "G1" },
            message: { id: "msg-2", type: "text", text: "   " },
          },
        ],
      }),
    );

    expect(extractLineQueueMessages(webhook, "corr")).toEqual([]);
  });

  it("falls back to timestamp-derived ids when webhook and message ids are missing", () => {
    const webhook = parseLineWebhook(
      JSON.stringify({
        destination: "Ubot",
        events: [
          {
            type: "message",
            timestamp: 1710000000000,
            source: { type: "group", groupId: "G1" },
            message: { type: "text", text: "hello" },
          },
        ],
      }),
    );

    expect(extractLineQueueMessages(webhook, "corr")).toMatchObject([
      {
        eventId: "Ubot:line:group:G1:1710000000000",
        messageTs: "1710000000000",
      },
    ]);
  });
});

describe("LINE conversation prompt blocks", () => {
  it("renders prior chat turns into same-chat context", () => {
    const [promptBlock, attachmentBlock] = buildLineContextBlocks({
      currentText: "what changed?",
      attachmentBlocks: [{ type: "text", text: "Attached image: img-1" }],
      priorTurns: [
        {
          turnId: "turn-1",
          workspaceId: "line:user:U1",
          channelId: "line:user:U1",
          conversationTs: "line:user:U1",
          contextScope: "channel_top_level",
          role: "user",
          source: "line",
          sourceEvent: "line_message",
          messageTs: "1",
          turnTs: "1",
          userId: "U1",
          text: "first",
          createdAt: "created",
        },
      ],
    });
    const text = promptBlock.text;

    expect(text).toContain("LINE conversation context");
    expect(text).toContain("1. user:U1: first");
    expect(text).toContain("Current user message:\nwhat changed?");
    expect(attachmentBlock).toEqual({ type: "text", text: "Attached image: img-1" });
  });
});

describe("LINE messaging client", () => {
  it("pushes text messages with bearer auth and line chunking", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new LineMessagingClient(async () => "token");
    const text = `${"x".repeat(4500)}\n\n${"y".repeat(800)}`;

    await client.pushText("U1", text);

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.line.me/v2/bot/message/push");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      authorization: "Bearer token",
      "content-type": "application/json",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      to: "U1",
      messages: [
        { type: "text", text: "x".repeat(4500) },
        { type: "text", text: "y".repeat(800) },
      ],
    });
  });

  it("supports reply messages and throws on LINE API errors", async () => {
    const client = new LineMessagingClient(async () => "token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("bad", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.replyText("reply", "hello");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.line.me/v2/bot/message/reply");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      replyToken: "reply",
      messages: [{ type: "text", text: "hello" }],
    });

    await expect(client.pushText("U1", "hello")).rejects.toThrow("LINE API call failed with status 500");
  });

  it("downloads message content with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LineMessagingClient(async () => "token");

    await expect(client.downloadMessageContent("img-1")).resolves.toEqual({
      bytes: Buffer.from([1, 2, 3]),
      contentType: "image/jpeg",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api-data.line.me/v2/bot/message/img-1/content");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      authorization: "Bearer token",
    });
  });

  it("splits text and caps request messages", () => {
    const chunks = splitTextForLine("alpha\n\nbeta\n\ngamma", 8);
    expect(chunks).toEqual(["alpha", "beta", "gamma"]);
  });

  it("truncates LINE requests after five text messages", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new LineMessagingClient(async () => "token");

    await client.pushText("U1", "x".repeat(26_000));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(5);
    expect(body.messages[4].text).toMatch(/\[truncated\]$/);
  });
});
