import { createHmac } from "node:crypto";
import { Jimp, JimpMime } from "jimp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSlackContextBlocks,
  buildTurnText,
} from "../src/conversations/buildSlackContextBlocks";
import {
  buildAgentContentBlocksForDocument,
  buildAgentContentBlocksForDocumentUrl,
} from "../src/documents/contentBlocks";
import {
  defaultExtensionForMimeType,
  inferMimeTypeFromName,
  isSupportedLocalImportMimeType,
  isSupportedSlackArchiveMimeType,
  isTextLikeMimeType,
} from "../src/slack/fileSupport";
import {
  compressSlackImageForModel,
  isCompressibleSlackImageMimeType,
} from "../src/slack/imageCompression";
import {
  extractSlackQueueMessage,
  parseSlackEnvelope,
} from "../src/slack/parseEvent";
import { verifySlackSignature } from "../src/slack/verifySignature";
import {
  normalizeTextForLine,
  normalizeTextForSlack,
  splitTextForSlack,
  stripModelThinking,
} from "../src/shared/text";

afterEach(() => {
  vi.useRealTimers();
});

describe("Slack text formatting", () => {
  it("splits long text on paragraph boundaries when possible", () => {
    const chunks = splitTextForSlack("  alpha beta\n\nsecond part\n\nthird  ", 18);

    expect(chunks).toEqual(["alpha beta", "second part", "third"]);
  });

  it("falls back to hard chunks and removes empty whitespace chunks", () => {
    expect(splitTextForSlack("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(splitTextForSlack("    ")).toEqual([""]);
  });

  it("normalizes markdown outside code spans and fenced blocks", () => {
    const normalized = normalizeTextForSlack(
      [
        "## Heading",
        "---",
        "**bold** __em__ ~~gone~~ [site](https://example.com/a)",
        "`**literal** [x](https://example.com)`",
        "```",
        "__literal__",
        "```",
      ].join("\n"),
    );

    expect(normalized).toContain("*Heading*");
    expect(normalized).not.toContain("---");
    expect(normalized).toContain("*bold* _em_ ~gone~ <https://example.com/a|site>");
    expect(normalized).toContain("`**literal** [x](https://example.com)`");
    expect(normalized).toContain("```\n__literal__\n```");
  });

  it("strips model thinking tags before Slack formatting", () => {
    expect(stripModelThinking("<thinking>hidden</thinking>\nVisible")).toBe("Visible");
    expect(normalizeTextForSlack("<think>hidden</think>\n**Visible**")).toBe("*Visible*");
  });

  it("normalizes markdown for LINE plain text", () => {
    const normalized = normalizeTextForLine(
      [
        "## Schedule",
        "**Today**",
        "- [Calendar](https://example.com/calendar)",
        "| day | item |",
        "| --- | --- |",
        "| Mon | prep |",
        "`**literal**`",
      ].join("\n"),
    );

    expect(normalized).toContain("Schedule");
    expect(normalized).toContain("Today");
    expect(normalized).toContain("Calendar\nhttps://example.com/calendar");
    expect(normalized).not.toContain("**Today**");
    expect(normalized).not.toContain("| --- | --- |");
    expect(normalized).toContain("`**literal**`");
  });
});

describe("file support helpers", () => {
  it("infers common mime types from file names", () => {
    expect(inferMimeTypeFromName("REPORT.PDF")).toBe("application/pdf");
    expect(inferMimeTypeFromName("photo.jpeg")).toBe("image/jpeg");
    expect(inferMimeTypeFromName("diagram.webp")).toBe("image/webp");
    expect(inferMimeTypeFromName("notes.md")).toBe("text/plain");
    expect(inferMimeTypeFromName("data.json")).toBe("application/json");
    expect(inferMimeTypeFromName("archive.zip")).toBeUndefined();
    expect(inferMimeTypeFromName()).toBeUndefined();
  });

  it("classifies supported archive and local import mime types", () => {
    expect(isTextLikeMimeType("text/csv")).toBe(true);
    expect(isTextLikeMimeType("application/javascript")).toBe(true);
    expect(isTextLikeMimeType()).toBe(false);
    expect(isSupportedSlackArchiveMimeType("image/gif")).toBe(true);
    expect(isSupportedSlackArchiveMimeType("application/json")).toBe(true);
    expect(isSupportedSlackArchiveMimeType("application/zip")).toBe(false);
    expect(isSupportedSlackArchiveMimeType()).toBe(false);
    expect(isSupportedLocalImportMimeType("application/pdf")).toBe(true);
    expect(isSupportedLocalImportMimeType("image/webp")).toBe(false);
    expect(isSupportedLocalImportMimeType()).toBe(false);
  });

  it("maps mime types to stable default extensions", () => {
    expect(defaultExtensionForMimeType("application/pdf")).toBe(".pdf");
    expect(defaultExtensionForMimeType("image/png")).toBe(".png");
    expect(defaultExtensionForMimeType("image/jpeg")).toBe(".jpg");
    expect(defaultExtensionForMimeType("image/webp")).toBe(".webp");
    expect(defaultExtensionForMimeType("image/gif")).toBe(".gif");
    expect(defaultExtensionForMimeType("application/json")).toBe(".json");
    expect(defaultExtensionForMimeType("text/markdown")).toBe(".md");
    expect(defaultExtensionForMimeType("text/csv")).toBe(".csv");
    expect(defaultExtensionForMimeType("text/plain")).toBe(".txt");
    expect(defaultExtensionForMimeType("application/zip")).toBe("");
  });
});

describe("document content blocks", () => {
  it("builds inline blocks for pdf, image, text, and unsupported buffers", () => {
    const buffer = Buffer.from("hello");

    expect(buildAgentContentBlocksForDocument("doc.pdf", "application/pdf", buffer)).toEqual([
      {
        type: "document",
        title: "doc.pdf",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: buffer.toString("base64"),
        },
      },
    ]);
    expect(buildAgentContentBlocksForDocument("img.png", "image/png", buffer)).toEqual([
      { type: "text", text: "Attached image: img.png" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: buffer.toString("base64"),
        },
      },
    ]);
    expect(buildAgentContentBlocksForDocument("notes.txt", "text/plain", buffer)).toEqual([
      {
        type: "document",
        title: "notes.txt",
        source: {
          type: "text",
          media_type: "text/plain",
          data: "hello",
        },
      },
    ]);
    expect(buildAgentContentBlocksForDocument("archive", undefined, buffer)).toEqual([
      {
        type: "text",
        text: "Attachment note: archive (unknown mime type) is not supported for inline analysis.",
      },
    ]);
  });

  it("builds URL blocks for supported documents, images, and unsupported files", () => {
    expect(buildAgentContentBlocksForDocumentUrl("doc.pdf", "application/pdf", "https://file")).toEqual([
      {
        type: "document",
        title: "doc.pdf",
        source: {
          type: "url",
          url: "https://file",
          media_type: "application/pdf",
        },
      },
    ]);
    expect(buildAgentContentBlocksForDocumentUrl("photo", "image/jpeg", "https://image")).toEqual([
      { type: "text", text: "Attached image: photo" },
      {
        type: "image",
        source: {
          type: "url",
          url: "https://image",
        },
      },
    ]);
    expect(buildAgentContentBlocksForDocumentUrl("zip", "application/zip", "https://zip")).toEqual([
      {
        type: "text",
        text: "Attachment note: zip (application/zip) is not supported for inline analysis.",
      },
    ]);
  });
});

describe("Slack image compression", () => {
  it("compresses supported images into bounded JPEG model input", async () => {
    const image = new Jimp({ width: 240, height: 120, color: 0x336699ff });
    const bytes = Buffer.from(await image.getBuffer(JimpMime.png));

    const compressed = await compressSlackImageForModel(bytes, "image/png", {
      maxDimension: 64,
      targetBytes: 20_000,
    });

    expect(compressed).toMatchObject({
      mimeType: "image/jpeg",
      originalBytes: bytes.byteLength,
      originalWidth: 240,
      originalHeight: 120,
      width: 64,
      height: 32,
    });
    expect(compressed!.compressedBytes).toBeLessThanOrEqual(20_000);
    expect(compressed!.bytes.byteLength).toBe(compressed!.compressedBytes);
  });

  it("keeps reducing large detailed images until they fit the target byte budget", async () => {
    const image = new Jimp({ width: 1000, height: 750, color: 0xffffffff });
    for (let y = 0; y < image.bitmap.height; y += 1) {
      for (let x = 0; x < image.bitmap.width; x += 1) {
        const value = ((x * 1103515245 + y * 12345) >>> 0) & 0xffffff;
        image.setPixelColor(((value << 8) | 0xff) >>> 0, x, y);
      }
    }
    const bytes = Buffer.from(await image.getBuffer(JimpMime.png));

    const compressed = await compressSlackImageForModel(bytes, "image/png", {
      maxDimension: 1000,
      targetBytes: 120_000,
    });

    expect(compressed).not.toBeNull();
    expect(compressed!.compressedBytes).toBeLessThanOrEqual(120_000);
    expect(Math.max(compressed!.width!, compressed!.height!)).toBeLessThan(750);
  }, 10_000);

  it("uses a conservative default byte budget for inline model images", async () => {
    const image = new Jimp({ width: 1600, height: 1200, color: 0xffffffff });
    for (let y = 0; y < image.bitmap.height; y += 1) {
      for (let x = 0; x < image.bitmap.width; x += 1) {
        const value = ((x * 1103515245 + y * 12345) >>> 0) & 0xffffff;
        image.setPixelColor(((value << 8) | 0xff) >>> 0, x, y);
      }
    }
    const bytes = Buffer.from(await image.getBuffer(JimpMime.png));

    const compressed = await compressSlackImageForModel(bytes, "image/png");

    expect(compressed).not.toBeNull();
    expect(compressed!.compressedBytes).toBeLessThanOrEqual(400_000);
  }, 10_000);

  it("only treats static web image formats as compressible", async () => {
    expect(isCompressibleSlackImageMimeType("image/jpeg")).toBe(true);
    expect(isCompressibleSlackImageMimeType("image/png")).toBe(true);
    expect(isCompressibleSlackImageMimeType("image/webp")).toBe(true);
    expect(isCompressibleSlackImageMimeType("image/gif")).toBe(false);
    await expect(compressSlackImageForModel(Buffer.from("gif"), "image/gif")).resolves.toBeNull();
  });
});

describe("Slack request signatures", () => {
  it("accepts a valid current Slack signature", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const timestamp = `${Math.floor(Date.now() / 1000)}`;
    const rawBody = "{\"type\":\"event_callback\"}";
    const digest = createHmac("sha256", "secret")
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");

    expect(
      verifySlackSignature({
        rawBody,
        timestamp,
        signature: `v0=${digest}`,
        signingSecret: "secret",
      }),
    ).toBe(true);
  });

  it("rejects missing, stale, malformed, and mismatched signatures", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));

    expect(
      verifySlackSignature({
        rawBody: "{}",
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        signingSecret: "secret",
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: "{}",
        timestamp: "not-a-number",
        signature: "v0=abc",
        signingSecret: "secret",
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: "{}",
        timestamp: `${Math.floor(Date.now() / 1000) - 301}`,
        signature: "v0=abc",
        signingSecret: "secret",
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: "{}",
        timestamp: `${Math.floor(Date.now() / 1000)}`,
        signature: "bad-length",
        signingSecret: "secret",
      }),
    ).toBe(false);
  });
});

describe("Slack event parsing", () => {
  it("parses envelopes and extracts app mention queue messages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00Z"));
    const envelope = parseSlackEnvelope(
      JSON.stringify({
        type: "event_callback",
        event_id: "Ev1",
        team_id: "T1",
        event: {
          type: "app_mention",
          channel: "C1",
          user: "U1",
          text: "<@BOT> summarize this",
          event_ts: "171.000",
          files: [
            {
              id: "F1",
              name: "doc.pdf",
              title: "Doc",
              mimetype: "application/pdf",
              file_access: "visible",
              url_private: "https://private",
              url_private_download: "https://download",
              permalink: "https://permalink",
              is_external: false,
              external_url: "https://external",
              size: 123,
            },
            { name: "missing-id" },
          ],
        },
      }),
    );

    expect(extractSlackQueueMessage(envelope, "corr")).toMatchObject({
      correlationId: "corr",
      eventId: "Ev1",
      workspaceId: "T1",
      channelId: "C1",
      conversationTs: "171.000",
      replyThreadTs: "171.000",
      messageTs: "171.000",
      userId: "U1",
      text: "summarize this",
      source: "app_mention",
      contextScope: "channel_top_level",
      files: [
        {
          id: "F1",
          name: "doc.pdf",
          title: "Doc",
          mimetype: "application/pdf",
          fileAccess: "visible",
          urlPrivate: "https://private",
          urlPrivateDownload: "https://download",
          permalink: "https://permalink",
          isExternal: false,
          externalUrl: "https://external",
          size: 123,
        },
      ],
    });
  });

  it("extracts direct messages, thread replies, and file-only fallback text", () => {
    const base = {
      type: "event_callback",
      event_id: "Ev2",
      authorizations: [{ team_id: "TAUTH" }],
    };

    expect(
      extractSlackQueueMessage(
        {
          ...base,
          event: {
            type: "message",
            channel_type: "im",
            channel: "D1",
            user: "U1",
            text: " hello ",
            event_ts: "172.000",
          },
        },
        "corr",
      ),
    ).toMatchObject({
      workspaceId: "TAUTH",
      source: "dm",
      contextScope: "channel_top_level",
      text: "hello",
    });

    expect(
      extractSlackQueueMessage(
        {
          ...base,
          event: {
            type: "message",
            channel_type: "channel",
            channel: "C1",
            user: "U1",
            text: "",
            event_ts: "173.000",
            thread_ts: "170.000",
            files: [{ id: "F2" }],
          },
        },
        "corr",
      ),
    ).toMatchObject({
      source: "thread_reply",
      contextScope: "thread",
      conversationTs: "170.000",
      replyThreadTs: "170.000",
      text: "Please analyze the attached file(s).",
    });

    expect(
      extractSlackQueueMessage(
        {
          ...base,
          event: {
            type: "message",
            channel_type: "channel",
            channel: "C1",
            user: "U1",
            text: "<@BOT> delete this reminder",
            event_ts: "174.000",
            thread_ts: "170.000",
          },
        },
        "corr",
      ),
    ).toBeNull();
  });

  it("ignores unsupported Slack events and malformed empty messages", () => {
    expect(extractSlackQueueMessage({ type: "url_verification" }, "corr")).toBeNull();
    expect(
      extractSlackQueueMessage(
        {
          type: "event_callback",
          event_id: "Ev3",
          team_id: "T1",
          event: { type: "message", subtype: "bot_message" },
        },
        "corr",
      ),
    ).toBeNull();
    expect(
      extractSlackQueueMessage(
        {
          type: "event_callback",
          event_id: "Ev4",
          team_id: "T1",
          event: { type: "message", bot_id: "B1" },
        },
        "corr",
      ),
    ).toBeNull();
    expect(
      extractSlackQueueMessage(
        {
          type: "event_callback",
          event_id: "Ev5",
          team_id: "T1",
          event: {
            type: "message",
            channel_type: "im",
            channel: "D1",
            user: "U1",
            text: " ",
            event_ts: "1",
          },
        },
        "corr",
      ),
    ).toBeNull();
  });

  it("throws when processable events miss workspace or message fields", () => {
    expect(() =>
      extractSlackQueueMessage(
        {
          type: "event_callback",
          event_id: "Ev6",
          event: {
            type: "app_mention",
            channel: "C1",
            user: "U1",
            text: "hi",
            event_ts: "1",
          },
        },
        "corr",
      ),
    ).toThrow("team_id");

    expect(() =>
      extractSlackQueueMessage(
        {
          type: "event_callback",
          event_id: "Ev7",
          team_id: "T1",
          event: {
            type: "app_mention",
            user: "U1",
            text: "hi",
            event_ts: "1",
          },
        },
        "corr",
      ),
    ).toThrow("required message fields");
  });
});

describe("Slack context prompt blocks", () => {
  const priorTurns = [
    {
      turnId: "turn1",
      workspaceId: "T1",
      channelId: "C1",
      conversationTs: "100",
      contextScope: "thread" as const,
      role: "user" as const,
      source: "dm" as const,
      messageTs: "100.1",
      turnTs: "100.1",
      userId: "U1",
      text: "first message",
      createdAt: "2026-05-14T00:00:00Z",
    },
    {
      turnId: "turn2",
      workspaceId: "T1",
      channelId: "C1",
      conversationTs: "100",
      contextScope: "thread" as const,
      role: "assistant" as const,
      source: "agent" as const,
      messageTs: "100.2",
      turnTs: "100.2",
      text: "answer",
      createdAt: "2026-05-14T00:01:00Z",
    },
  ];

  it("returns current text with attachment blocks when there is no prior context", () => {
    expect(
      buildSlackContextBlocks({
        contextScope: "thread",
        priorTurns: [],
        currentText: "  now  ",
        attachmentBlocks: [{ type: "text", text: "attachment" }],
      }),
    ).toEqual([
      { type: "text", text: "now" },
      { type: "text", text: "attachment" },
    ]);
  });

  it("adds a default analysis instruction for attachment-only messages", () => {
    expect(
      buildSlackContextBlocks({
        contextScope: "channel_top_level",
        priorTurns: [],
        currentText: "",
        attachmentBlocks: [
          { type: "text", text: "Attached image: IMG_0762.jpg" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "abc",
            },
          },
        ],
      }),
    ).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Analyze the attached content directly"),
      },
      { type: "text", text: "Attached image: IMG_0762.jpg" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "abc",
        },
      },
    ]);
    const [{ text }] = buildSlackContextBlocks({
      contextScope: "channel_top_level",
      priorTurns: [],
      currentText: "",
      attachmentBlocks: [{ type: "text", text: "Attached image: IMG_0762.jpg" }],
    });
    expect(text).toContain("ask whether to save them");
  });

  it("includes the local received date when provided", () => {
    const [{ text }] = buildSlackContextBlocks({
      contextScope: "channel_top_level",
      priorTurns: [],
      currentText: "これ覚えて",
      attachmentBlocks: [],
      receivedAt: "2026-05-28T15:30:00.000Z",
      timeZone: "Asia/Tokyo",
    });

    expect(text).toContain("Current local date: 2026-05-29 (Asia/Tokyo)");
    expect(text).toContain("Current user message:\nこれ覚えて");
  });

  it("renders thread and channel context headings with truncated turns", () => {
    const [{ text }] = buildSlackContextBlocks({
      contextScope: "channel_top_level",
      priorTurns: [
        priorTurns[0],
        {
          ...priorTurns[1],
          text: "x".repeat(1300),
        },
      ],
      currentText: "current",
      attachmentBlocks: [],
    });

    expect(text).toContain("Recent top-level AI conversation turns from this Slack channel:");
    expect(text).toContain("1. user:U1: first message");
    expect(text).toContain("2. assistant: ");
    expect(text).toContain("...");
    expect(text).toContain("Current user message:\ncurrent");
  });

  it("summarizes attachment labels in turn text", () => {
    expect(
      buildTurnText("  review these  ", [
        { id: "F1", title: "Plan" },
        { id: "F2", name: "notes.md" },
        { id: "F3" },
      ]),
    ).toBe("review these\n\nAttachments: Plan, notes.md, F3");
    expect(buildTurnText("", [{ id: "F1", title: "Plan" }])).toBe("Attachments: Plan");
    expect(buildTurnText(" text ", [])).toBe("text");
  });
});
