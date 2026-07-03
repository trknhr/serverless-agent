import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLineContextBlocks } from "../src/conversations/buildLineContextBlocks";
import { LineAttachmentArchiveService } from "../src/line/lineAttachmentArchiveService";
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

  it("includes the local received date when provided", () => {
    const [promptBlock] = buildLineContextBlocks({
      currentText: "Show my upcoming schedule.",
      priorTurns: [],
      receivedAt: "2026-06-08T07:52:00.000Z",
      timeZone: "Asia/Tokyo",
    });

    expect(promptBlock.text).toContain("Current local date: 2026-06-08 (Asia/Tokyo)");
    expect(promptBlock.text).toContain("Use this date for relative dates");
    expect(promptBlock.text).toContain("Format the final answer as LINE plain text");
    expect(promptBlock.text).toContain("Current user message:\nShow my upcoming schedule.");
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
        text: expect.stringContaining("Read the available image attachment"),
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
    expect(text).toContain("Format the final answer as LINE plain text");
    expect(text).toContain("1. user:U1: first");
    expect(text).toContain("Current user message:\nwhat changed?");
    expect(attachmentBlock).toEqual({ type: "text", text: "Attached image: img-1" });
  });

  it("omits archived attachment manifests from prior chat context", () => {
    const [promptBlock] = buildLineContextBlocks({
      currentText: "continue",
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
          text: [
            "Please inspect the attached file.",
            "Available image attachment: LINE image img-1 sourceId=src_previous expiresAt=2026-06-06T00:00:00.000Z.",
            "Use read_attachment_image with this sourceId only when the current user request needs the image.",
          ].join("\n"),
          createdAt: "created",
        },
      ],
    });

    expect(promptBlock.text).toContain("Please inspect the attached file.");
    expect(promptBlock.text).not.toContain("src_previous");
    expect(promptBlock.text).not.toContain("Available image attachment");
    expect(promptBlock.text).not.toContain("read_attachment_image");
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

describe("LineAttachmentArchiveService", () => {
  it("archives up to three image attachments and returns lightweight manifest blocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T03:04:05.000Z"));
    const repository = { save: vi.fn(async (document) => document) };
    const s3 = { send: vi.fn().mockResolvedValue({}) };
    const lineClient = {
      downloadMessageContent: vi
        .fn()
        .mockResolvedValueOnce({ bytes: Buffer.from("image-one"), contentType: "IMAGE/JPEG; charset=binary" })
        .mockResolvedValueOnce({ bytes: Buffer.from("image-two"), contentType: "image/png" })
        .mockResolvedValueOnce({ bytes: Buffer.from("image-three"), contentType: undefined }),
    };
    const logger = { warn: vi.fn() };
    const service = new LineAttachmentArchiveService("bucket", repository as any, s3);

    const result = await service.archiveAttachments({
      workspaceId: "line:group:G1",
      channelId: "line:group:G1",
      messageTs: "msg-root",
      userId: "line:user:U1",
      attachments: [
        { id: "img-1", type: "image", contentType: "image/jpeg" },
        { id: "img-2", type: "image", contentType: "image/png" },
        { id: "img-3", type: "image" },
        { id: "img-4", type: "image", contentType: "image/webp" },
      ],
      lineClient: lineClient as any,
      logger: logger as any,
      ttlSeconds: 86_400,
      maxImages: 3,
    });

    expect(lineClient.downloadMessageContent).toHaveBeenCalledTimes(3);
    expect(lineClient.downloadMessageContent.mock.calls.map(([messageId]) => messageId)).toEqual([
      "img-1",
      "img-2",
      "img-3",
    ]);
    expect(s3.send).toHaveBeenCalledTimes(3);
    expect(repository.save).toHaveBeenCalledTimes(3);

    const firstPut = s3.send.mock.calls[0][0].input;
    expect(firstPut).toMatchObject({
      Bucket: "bucket",
      Key: expect.stringMatching(
        /^raw\/private\/line\/line:group:G1\/2026\/06\/src_.+\/line-image-img-1\.jpg$/,
      ),
      Body: Buffer.from("image-one"),
      ContentType: "image/jpeg",
      Metadata: {
        workspace_id: "line:group:G1",
        channel_id: "line:group:G1",
        line_message_id: "img-1",
      },
    });
    expect(firstPut.Metadata.source_id).toMatch(/^src_/);

    expect(repository.save.mock.calls[0][0]).toMatchObject({
      workspaceId: "line:group:G1",
      sourceType: "line_message_image",
      sourceRef: "line:message:img-1",
      title: "LINE image img-1",
      lineMessageId: "img-1",
      channelId: "line:group:G1",
      messageTs: "msg-root",
      uploadedByUserId: "line:user:U1",
      mimeType: "image/jpeg",
      size: Buffer.byteLength("image-one"),
      checksum: "8f81413241884229c9135da4ae01c0753131bf403587455763d667ee025cb129",
      s3Bucket: "bucket",
      status: "archived",
      expiresAt: "2026-06-03T03:04:05.000Z",
      ttl: 1780455845,
      createdAt: "2026-06-02T03:04:05.000Z",
      updatedAt: "2026-06-02T03:04:05.000Z",
    });
    expect(repository.save.mock.calls[0][0].s3Key).toBe(firstPut.Key);

    expect(result.documents).toHaveLength(3);
    expect(result.manifestBlocks).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Available image attachment"),
      },
    ]);
    const manifestText = result.manifestBlocks[0].type === "text" ? result.manifestBlocks[0].text : "";
    expect(manifestText).toContain(`sourceId=${repository.save.mock.calls[0][0].sourceId}`);
    expect(manifestText).toContain("expiresAt=2026-06-03T03:04:05.000Z");
    expect(manifestText).toContain("Use read_attachment_image with this sourceId only when");
    expect(manifestText).toContain("Ignored 1 extra LINE image attachment beyond maxImages=3.");
    expect(manifestText).not.toContain("image-one");
  });

  it("returns a note and skips persistence when LINE image download fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T03:04:05.000Z"));
    const repository = { save: vi.fn(async (document) => document) };
    const s3 = { send: vi.fn().mockResolvedValue({}) };
    const lineClient = {
      downloadMessageContent: vi.fn().mockRejectedValue(new Error("line expired")),
    };
    const logger = { warn: vi.fn() };
    const service = new LineAttachmentArchiveService("bucket", repository as any, s3);

    const result = await service.archiveAttachments({
      workspaceId: "line:user:U1",
      channelId: "line:user:U1",
      messageTs: "img-1",
      userId: "line:user:U1",
      attachments: [{ id: "img-1", type: "image", contentType: "image/jpeg" }],
      lineClient: lineClient as any,
      logger: logger as any,
      ttlSeconds: 86_400,
      maxImages: 3,
    });

    expect(result.documents).toEqual([]);
    expect(result.manifestBlocks).toEqual([
      { type: "text", text: "Attachment note: Could not archive LINE image img-1. line expired" },
    ]);
    expect(repository.save).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "LINE image archive download failed",
      expect.objectContaining({ lineMessageId: "img-1", error: "line expired" }),
    );
  });

  it("does not advertise archived images when source metadata cannot be saved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T03:04:05.000Z"));
    const repository = { save: vi.fn().mockRejectedValue(new Error("ddb down")) };
    const s3 = { send: vi.fn().mockResolvedValue({}) };
    const lineClient = {
      downloadMessageContent: vi.fn().mockResolvedValue({
        bytes: Buffer.from("image-one"),
        contentType: "image/jpeg",
      }),
    };
    const logger = { warn: vi.fn() };
    const service = new LineAttachmentArchiveService("bucket", repository as any, s3);

    const result = await service.archiveAttachments({
      workspaceId: "line:user:U1",
      channelId: "line:user:U1",
      messageTs: "img-1",
      userId: "line:user:U1",
      attachments: [{ id: "img-1", type: "image", contentType: "image/jpeg" }],
      lineClient: lineClient as any,
      logger: logger as any,
      ttlSeconds: 86_400,
      maxImages: 3,
    });

    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(result.documents).toEqual([]);
    expect(result.manifestBlocks).toEqual([
      { type: "text", text: "Attachment note: Could not archive LINE image img-1. metadata unavailable" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "LINE source document metadata persist failed",
      expect.objectContaining({ lineMessageId: "img-1", error: "ddb down" }),
    );
  });
});
