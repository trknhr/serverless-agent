import { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { ArchivedAttachmentImageReader } from "../src/attachments/attachmentImageReader";
import { SourceDocument } from "../src/documents/sourceDocument";

function buildDocument(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    sourceId: "src_image",
    workspaceId: "T1",
    sourceType: "line_message_image",
    sourceRef: "line:message:message-1",
    title: "image.png",
    mimeType: "image/png",
    size: 12,
    s3Bucket: "archive-bucket",
    s3Key: "raw/private/image.png",
    status: "archived",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildReader(document: SourceDocument | null, bytes = Buffer.from("image-bytes")) {
  const repository = {
    get: vi.fn().mockResolvedValue(document),
  };
  const s3 = {
    send: vi.fn().mockResolvedValue({
      Body: {
        transformToByteArray: vi.fn().mockResolvedValue(Uint8Array.from(bytes)),
      },
    }),
  };
  return { reader: new ArchivedAttachmentImageReader(repository, s3), repository, s3 };
}

describe("ArchivedAttachmentImageReader", () => {
  it("reads archived image bytes and returns text plus base64 image blocks", async () => {
    const document = buildDocument();
    const bytes = Buffer.from("image-bytes");
    const { reader, repository, s3 } = buildReader(document, bytes);

    await expect(reader.readImage({ workspaceId: "T1", sourceId: "src_image" })).resolves.toEqual([
      { type: "text", text: "Attached archived image: image.png" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: bytes.toString("base64"),
        },
      },
    ]);

    expect(repository.get).toHaveBeenCalledWith("T1", "src_image");
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(s3.send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(s3.send.mock.calls[0][0].input).toMatchObject({
      Bucket: "archive-bucket",
      Key: "raw/private/image.png",
    });
  });

  it("returns a note when the source is missing", async () => {
    const { reader, s3 } = buildReader(null);

    await expect(reader.readImage({ workspaceId: "T1", sourceId: "missing" })).resolves.toEqual([
      { type: "text", text: "Attachment note: Archived image missing was not found." },
    ]);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("returns a note when the source is expired", async () => {
    const { reader, s3 } = buildReader(buildDocument({ expiresAt: "2026-06-01T00:00:00.000Z" }));

    await expect(
      reader.readImage({
        workspaceId: "T1",
        sourceId: "src_image",
        now: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual([{ type: "text", text: "Attachment note: Archived image src_image has expired." }]);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("returns a note when the source is not an image", async () => {
    const { reader, s3 } = buildReader(buildDocument({ mimeType: "application/pdf" }));

    await expect(reader.readImage({ workspaceId: "T1", sourceId: "src_image" })).resolves.toEqual([
      { type: "text", text: "Attachment note: Archived source src_image is not an image." },
    ]);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("returns a note when the archived source is not available", async () => {
    const { reader, s3 } = buildReader(buildDocument({ status: "archive_failed", s3Bucket: undefined }));

    await expect(reader.readImage({ workspaceId: "T1", sourceId: "src_image" })).resolves.toEqual([
      { type: "text", text: "Attachment note: Archived source src_image is not available." },
    ]);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("returns a note when the image exceeds the byte limit", async () => {
    const { reader } = buildReader(buildDocument(), Buffer.from("too-large"));

    await expect(reader.readImage({ workspaceId: "T1", sourceId: "src_image", maxBytes: 4 })).resolves.toEqual([
      { type: "text", text: "Attachment note: Archived image src_image is larger than 4 bytes." },
    ]);
  });
});
