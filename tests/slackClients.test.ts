import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretsProvider } from "../src/aws/secretsProvider";
import { SlackAuthClient, SlackApiError } from "../src/slack/authTest";
import { SlackConversationsClient } from "../src/slack/conversationsClient";
import { SlackFilesClient } from "../src/slack/filesClient";
import { SlackAttachmentArchiveService } from "../src/slack/slackAttachmentArchiveService";
import { SlackWebClient } from "../src/slack/postMessage";

const { s3SendMock } = vi.hoisted(() => ({
  s3SendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class S3Client {
    send = s3SendMock;
  },
  PutObjectCommand: class PutObjectCommand {
    input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  s3SendMock.mockReset();
});

function okJson(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("SlackWebClient", () => {
  it("posts normalized chunks and returns the first message timestamp", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ ok: true, ts: "100.1" }))
      .mockResolvedValueOnce(okJson({ ok: true, ts: "100.2" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlackWebClient(async () => "token");

    const text = `${"x".repeat(2500)}\n\n**bold** ${"y".repeat(1000)}`;
    await expect(
      client.postMessage({
        channel: "C1",
        threadTs: "99.9",
        text,
        blocks: [{ type: "section" }],
      }),
    ).resolves.toEqual({ ts: "100.1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      channel: "C1",
      thread_ts: "99.9",
      text: "x".repeat(2500),
      blocks: [{ type: "section" }],
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      text: expect.stringMatching(/^\*bold\* y+/),
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("blocks");
  });

  it("updates the first chunk and posts overflow chunks into a thread", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ ok: true }))
      .mockResolvedValueOnce(okJson({ ok: true, ts: "101.2" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlackWebClient(async () => "token");

    await client.updateMessage({
      channel: "C1",
      ts: "101.1",
      text: `${"x".repeat(2500)}\n\nfirst ${"y".repeat(1000)}`,
      blocks: [{ type: "section" }],
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      ts: "101.1",
      text: "x".repeat(2500),
      blocks: [{ type: "section" }],
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      thread_ts: "101.1",
      text: expect.stringMatching(/^first y+/),
    });
  });

  it("throws on HTTP and Slack API errors", async () => {
    const client = new SlackWebClient(async () => "token");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad", { status: 500 })));
    await expect(client.postMessage({ channel: "C1", text: "hello" })).rejects.toThrow(
      "failed with status 500",
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(okJson({ ok: false, error: "invalid_auth" })));
    await expect(client.postMessage({ channel: "C1", text: "hello" })).rejects.toThrow(
      "invalid_auth",
    );
  });
});

describe("SlackConversationsClient", () => {
  it("paginates replies, filters unusable messages, maps files, and sorts by ts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({
          ok: true,
          response_metadata: { next_cursor: "next" },
          messages: [
            { ts: "102.0", text: "later", user: "U2" },
            { ts: "101.0", text: " ", files: [{ id: "F1", name: "doc.pdf", size: 12 }] },
            { ts: "101.5", text: " ", files: "not-an-array" },
            { ts: "101.6", text: " ", files: [null] },
            { text: "missing ts" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okJson({
          ok: true,
          messages: [
            {
              ts: "100.0",
              text: "earlier",
              thread_ts: "99.0",
              bot_id: "B1",
              subtype: "bot_message",
              files: [{ name: "bad" }],
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlackConversationsClient(async () => "token");

    await expect(client.listReplies("C1", "99.0")).resolves.toEqual([
      {
        ts: "100.0",
        threadTs: "99.0",
        text: "earlier",
        botId: "B1",
        subtype: "bot_message",
        files: [],
      },
      {
        ts: "101.0",
        text: " ",
        files: [{ id: "F1", name: "doc.pdf", size: 12 }],
      },
      {
        ts: "102.0",
        text: "later",
        userId: "U2",
        files: [],
      },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ cursor: "next" });
  });

  it("throws on replies HTTP and Slack API failures", async () => {
    const client = new SlackConversationsClient(async () => "token");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad", { status: 429 })));
    await expect(client.listReplies("C1", "99")).rejects.toThrow("failed with status 429");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(okJson({ ok: false, error: "channel_not_found" })));
    await expect(client.listReplies("C1", "99")).rejects.toThrow("channel_not_found");
  });
});

describe("SlackFilesClient", () => {
  it("prepares external, missing-url, unsupported, oversize, and ready attachments", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({
          ok: true,
          file: {
            id: "F-missing",
            name: "missing.pdf",
            mimetype: "application/pdf",
          },
        }),
      )
      .mockResolvedValueOnce(
        okJson({
          ok: true,
          file: {
            id: "F-ready",
            name: "ready.txt",
            mimetype: "text/plain",
            url_private_download: "https://download/ready",
            size: 5,
          },
        }),
      )
      .mockResolvedValueOnce(new Response("hello", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlackFilesClient(async () => "token", 10);

    const attachments = await client.prepareAttachments([
      {
        id: "F-external",
        name: "external.pdf",
        isExternal: true,
        externalUrl: "https://external.example/doc.pdf",
        urlPrivate: "https://private/external.pdf",
      },
      { id: "F-missing", name: "missing.pdf", mimetype: "application/pdf" },
      { id: "F-unsupported", name: "archive.zip", urlPrivate: "https://download/zip" },
      { id: "F-large", name: "large.pdf", mimetype: "application/pdf", urlPrivate: "https://download/large", size: 99 },
      { id: "F-ready", fileAccess: "check_file_info" },
    ]);

    expect(attachments.map((attachment) => attachment.status)).toEqual([
      "external_link",
      "skipped_missing_url",
      "skipped_unsupported",
      "skipped_oversize",
      "ready",
    ]);
    expect(attachments[4]).toMatchObject({
      label: "ready.txt",
      mimeType: "text/plain",
      contentBytes: Buffer.from("hello"),
      contentBlocks: [
        {
          type: "document",
          title: "ready.txt",
          source: {
            type: "text",
            media_type: "text/plain",
            data: "hello",
          },
        },
      ],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://slack.com/api/files.info?file=F-missing",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://slack.com/api/files.info?file=F-ready",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://download/ready",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("captures resolution and download failures as attachment status", async () => {
    const client = new SlackFilesClient(async () => "token", 10);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad", { status: 403 })));
    await expect(client.prepareAttachments([{ id: "F-info", fileAccess: "check_file_info" }])).resolves.toMatchObject([
      {
        status: "download_failed",
        contentBlocks: [{ type: "text", text: expect.stringContaining("files.info failed") }],
      },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad", { status: 500 })));
    await expect(
      client.prepareAttachments([
        { id: "F-download", name: "doc.pdf", mimetype: "application/pdf", urlPrivate: "https://download/doc" },
      ]),
    ).resolves.toMatchObject([
      {
        status: "download_failed",
        contentBlocks: [{ type: "text", text: expect.stringContaining("download failed") }],
      },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(okJson({ ok: false, error: "not_found" })));
    await expect(client.prepareAttachments([{ id: "F-info-error", fileAccess: "check_file_info" }])).resolves.toMatchObject([
      {
        status: "download_failed",
        contentBlocks: [{ type: "text", text: expect.stringContaining("not_found") }],
      },
    ]);

    const throwingClient = new SlackFilesClient(async () => {
      throw "no token";
    }, 10);
    await expect(
      throwingClient.prepareAttachments([
        { id: "F-unknown", name: "doc.pdf", mimetype: "application/pdf", urlPrivate: "https://download/doc" },
      ]),
    ).resolves.toMatchObject([
      {
        status: "download_failed",
        contentBlocks: [{ type: "text", text: expect.stringContaining("Unknown attachment error") }],
      },
    ]);
  });

  it("skips files that exceed the byte limit after download and uses title/id label fallbacks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("too large", { status: 200 })));
    const client = new SlackFilesClient(async () => "token", 3);

    await expect(
      client.prepareAttachments([
        {
          id: "F-large-after",
          title: "Downloaded title",
          mimetype: "text/plain",
          urlPrivateDownload: "https://download/large-after",
        },
      ]),
    ).resolves.toMatchObject([
      {
        label: "Downloaded title",
        status: "skipped_oversize",
        contentBlocks: [{ type: "text", text: expect.stringContaining("exceeded the 3 byte limit") }],
      },
    ]);

    await expect(
      client.prepareAttachments([
        {
          id: "F-id-label",
          mimetype: "application/zip",
          urlPrivate: "https://download/zip",
        },
      ]),
    ).resolves.toMatchObject([
      {
        label: "F-id-label",
        status: "skipped_unsupported",
      },
    ]);
  });

  it("limits inline content blocks and reports omitted attachments", () => {
    const client = new SlackFilesClient(async () => "token", 10);

    expect(
      client.buildContentBlocks(
        [
          { file: { id: "F1" }, label: "one", status: "external_link", contentBlocks: [{ type: "text", text: "one" }] },
          { file: { id: "F2" }, label: "two", status: "external_link", contentBlocks: [{ type: "text", text: "two" }] },
          { file: { id: "F3" }, label: "three", status: "external_link", contentBlocks: [{ type: "text", text: "three" }] },
        ],
        2,
      ),
    ).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      {
        type: "text",
        text: "Attachment note: 1 additional file(s) were archived but omitted from inline analysis to keep the request bounded.",
      },
    ]);

    expect(
      client.buildContentBlocks([
        { file: { id: "F1" }, label: "one", status: "external_link", contentBlocks: [{ type: "text", text: "one" }] },
      ]),
    ).toEqual([{ type: "text", text: "one" }]);
  });
});

describe("SlackAuthClient", () => {
  it("returns auth.test payloads and raises typed Slack API errors", async () => {
    const client = new SlackAuthClient(async () => "token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(okJson({ ok: true, team: "Team", user_id: "U1" })));

    await expect(client.authTest()).resolves.toMatchObject({ ok: true, team: "Team" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad", { status: 503 })));
    await expect(client.authTest()).rejects.toBeInstanceOf(SlackApiError);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(okJson({ ok: false, error: "invalid_auth" })));
    await expect(client.authTest()).rejects.toThrow("invalid_auth");
  });
});

describe("SlackAttachmentArchiveService", () => {
  it("persists non-ready attachments using mapped source statuses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const repository = { save: vi.fn().mockResolvedValue(undefined) };
    const logger = { warn: vi.fn() };
    const service = new SlackAttachmentArchiveService("bucket", repository as any);

    await service.archiveAttachments({
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100",
      messageTs: "101",
      userId: "U1",
      logger: logger as any,
      attachments: [
        { file: { id: "F1" }, label: "ext", status: "external_link", contentBlocks: [] },
        { file: { id: "F2" }, label: "missing", status: "skipped_missing_url", contentBlocks: [] },
        { file: { id: "F3" }, label: "large", status: "skipped_oversize", contentBlocks: [] },
        { file: { id: "F4" }, label: "zip", status: "skipped_unsupported", contentBlocks: [] },
        { file: { id: "F5" }, label: "failed", status: "download_failed", contentBlocks: [] },
      ],
    });

    expect(repository.save.mock.calls.map(([document]) => document.status)).toEqual([
      "external_link",
      "skipped_missing_url",
      "skipped_oversize",
      "skipped_unsupported",
      "download_failed",
    ]);
    expect(repository.save.mock.calls[0][0]).toMatchObject({
      workspaceId: "T1",
      sourceType: "slack_file",
      channelId: "C1",
      threadTs: "100",
      messageTs: "101",
      uploadedByUserId: "U1",
      createdAt: "2026-05-14T00:00:00.000Z",
    });
  });

  it("uploads ready attachments and saves archived metadata with checksums", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    s3SendMock.mockResolvedValueOnce({});
    const repository = { save: vi.fn().mockResolvedValue(undefined) };
    const logger = { warn: vi.fn() };
    const service = new SlackAttachmentArchiveService("bucket", repository as any);

    await service.archiveAttachments({
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100",
      messageTs: "101",
      userId: "U1",
      logger: logger as any,
      attachments: [
        {
          file: { id: "F1", permalink: "https://slack/files/F1" },
          label: " Report 2026 ",
          mimeType: "application/pdf",
          status: "ready",
          contentBytes: Buffer.from("pdf"),
          contentBlocks: [],
        },
      ],
    });

    expect(s3SendMock.mock.calls[0][0].input).toMatchObject({
      Bucket: "bucket",
      Key: expect.stringMatching(/^raw\/private\/slack\/T1\/2026\/05\/src_.+\/Report_2026\.pdf$/),
      Body: Buffer.from("pdf"),
      ContentType: "application/pdf",
      Metadata: {
        workspace_id: "T1",
        channel_id: "C1",
        slack_file_id: "F1",
      },
    });
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "archived",
        checksum: "c35b21d6ca39aa7cc3b79a705d989f1a6e88b99ab43988d74048799e3db926a3",
        s3Bucket: "bucket",
        sourceRef: "https://slack/files/F1",
      }),
    );
  });

  it("persists archive failures and logs repository save failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    s3SendMock.mockRejectedValueOnce(new Error("s3 down"));
    const repository = {
      save: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ddb down")),
    };
    const logger = { warn: vi.fn() };
    const service = new SlackAttachmentArchiveService("bucket", repository as any);

    await service.archiveAttachments({
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100",
      messageTs: "101",
      userId: "U1",
      logger: logger as any,
      attachments: [
        {
          file: { id: "F1" },
          label: "ready.bin",
          mimeType: undefined,
          status: "ready",
          contentBytes: Buffer.from("data"),
          contentBlocks: [],
        },
        {
          file: { id: "F2" },
          label: "missing",
          status: "skipped_missing_url",
          contentBlocks: [],
        },
      ],
    });

    expect(repository.save.mock.calls[0][0]).toMatchObject({
      status: "archive_failed",
      errorMessage: "s3 down",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Slack attachment archive failed",
      expect.objectContaining({ slackFileId: "F1", error: "s3 down" }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Source document metadata persist failed",
      expect.objectContaining({ slackFileId: "F2", error: "ddb down" }),
    );
  });

  it("handles non-Error archive failures and blank labels", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    s3SendMock.mockRejectedValueOnce("string failure");
    const repository = {
      save: vi.fn().mockRejectedValueOnce("repository failure"),
    };
    const logger = { warn: vi.fn() };
    const service = new SlackAttachmentArchiveService("bucket", repository as any);

    await service.archiveAttachments({
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "100",
      messageTs: "101",
      userId: "U1",
      logger: logger as any,
      attachments: [
        {
          file: { id: "F1" },
          label: "   ",
          mimeType: "image/png",
          status: "ready",
          contentBytes: Buffer.from("png"),
          contentBlocks: [],
        },
      ],
    });

    expect(s3SendMock.mock.calls[0][0].input.Key).toMatch(/\/src_[^/]+\/src_[^/]+\.png$/);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "archive_failed",
        errorMessage: "Unknown archive error",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Source document metadata persist failed",
      expect.objectContaining({ error: "Unknown repository error" }),
    );
  });
});

describe("SecretsProvider", () => {
  it("caches secret fetches and rejects secrets without strings", async () => {
    const send = vi.fn().mockResolvedValueOnce({ SecretString: "value" });
    const provider = new SecretsProvider({ send } as any);

    await expect(provider.getSecretString("secret")).resolves.toBe("value");
    await expect(provider.getSecretString("secret")).resolves.toBe("value");
    expect(send).toHaveBeenCalledTimes(1);

    const emptyProvider = new SecretsProvider({ send: vi.fn().mockResolvedValue({}) } as any);
    await expect(emptyProvider.getSecretString("empty")).rejects.toThrow("does not contain SecretString");
  });
});
