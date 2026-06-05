import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AgentContentBlock } from "../agent/types";
import { SourceDocument } from "../documents/sourceDocument";
import { SourceDocumentRepository } from "../repo/sourceDocumentRepository";
import { Logger } from "../shared/logger";
import { LineQueueMessage } from "../shared/contracts";
import { compressSlackImageForModel } from "../slack/imageCompression";
import { defaultExtensionForMimeType } from "../slack/fileSupport";
import { LineMessagingClient } from "./postMessage";

const maxArchiveBytes = 750_000;

type S3ClientLike = Pick<S3Client, "send">;

interface ArchiveLineAttachmentsInput {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  userId: string;
  attachments: LineQueueMessage["attachments"];
  lineClient: Pick<LineMessagingClient, "downloadMessageContent">;
  logger: Logger;
  ttlSeconds: number;
  maxImages: number;
}

export class LineAttachmentArchiveService {
  private readonly s3: S3ClientLike;

  constructor(
    private readonly bucketName: string,
    private readonly repository: SourceDocumentRepository,
    s3?: S3ClientLike,
  ) {
    this.s3 = s3 ?? new S3Client({});
  }

  async archiveAttachments(input: ArchiveLineAttachmentsInput): Promise<{
    documents: SourceDocument[];
    manifestBlocks: AgentContentBlock[];
  }> {
    const documents: SourceDocument[] = [];
    const manifestLines: string[] = [];
    const maxImages = Math.max(0, input.maxImages);
    const selectedAttachments = input.attachments.slice(0, maxImages);

    for (const attachment of selectedAttachments) {
      const result = await this.archiveAttachment(input, attachment);
      if (result.document) {
        documents.push(result.document);
      }
      manifestLines.push(result.manifestLine);
    }

    const ignoredCount = Math.max(0, input.attachments.length - maxImages);
    if (ignoredCount > 0) {
      manifestLines.push(`Ignored ${ignoredCount} extra LINE image attachment beyond maxImages=${maxImages}.`);
    }

    return {
      documents,
      manifestBlocks: manifestLines.length > 0 ? [{ type: "text", text: manifestLines.join("\n") }] : [],
    };
  }

  private async archiveAttachment(
    input: ArchiveLineAttachmentsInput,
    attachment: LineQueueMessage["attachments"][number],
  ): Promise<{ document?: SourceDocument; manifestLine: string }> {
    const sourceId = `src_${randomUUID()}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAtDate = new Date(now.getTime() + input.ttlSeconds * 1000);
    const expiresAt = expiresAtDate.toISOString();
    const ttl = Math.floor(expiresAtDate.getTime() / 1000);

    let downloaded: Awaited<ReturnType<LineMessagingClient["downloadMessageContent"]>>;
    try {
      downloaded = await input.lineClient.downloadMessageContent(attachment.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown LINE download error";
      input.logger.warn("LINE image archive download failed", {
        lineMessageId: attachment.id,
        sourceId,
        error: message,
      });
      return { manifestLine: `Attachment note: Could not archive LINE image ${attachment.id}. ${message}` };
    }

    const requestedMimeType = normalizeImageMimeType(downloaded.contentType ?? attachment.contentType);
    const archiveInput = await prepareArchiveBytes(downloaded.bytes, requestedMimeType, input.logger, attachment.id);
    const mimeType = archiveInput.mimeType;
    const baseDocument: SourceDocument = {
      sourceId,
      workspaceId: input.workspaceId,
      sourceType: "line_message_image",
      sourceRef: `line:message:${attachment.id}`,
      title: `LINE image ${attachment.id}`,
      lineMessageId: attachment.id,
      channelId: input.channelId,
      messageTs: input.messageTs,
      uploadedByUserId: input.userId,
      mimeType,
      size: archiveInput.bytes.byteLength,
      status: "archived",
      expiresAt,
      ttl,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const checksum = createHash("sha256").update(archiveInput.bytes).digest("hex");

    if (archiveInput.bytes.byteLength > maxArchiveBytes) {
      const document = await this.persistDocument(
        {
          ...baseDocument,
          checksum,
          status: "skipped_oversize",
          errorMessage: `LINE image archive bytes exceed ${maxArchiveBytes} byte limit`,
        },
        input.logger,
      );
      return {
        document,
        manifestLine: `Attachment note: Could not archive LINE image ${attachment.id}. image exceeds archive limit`,
      };
    }

    const s3Key = buildS3Key(input.workspaceId, sourceId, attachment.id, mimeType, nowIso);
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
          Body: archiveInput.bytes,
          ContentType: mimeType,
          Metadata: {
            source_id: sourceId,
            workspace_id: input.workspaceId,
            channel_id: input.channelId,
            line_message_id: attachment.id,
          },
        }),
      );

      const document = await this.persistDocument(
        {
          ...baseDocument,
          checksum,
          s3Bucket: this.bucketName,
          s3Key,
          status: "archived",
        },
        input.logger,
      );
      return {
        document,
        manifestLine: `Available image attachment: LINE image ${attachment.id} sourceId=${sourceId} expiresAt=${expiresAt}. Use read_attachment_image with this sourceId only when the current user request needs the image.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown archive error";
      input.logger.warn("LINE image archive failed", {
        lineMessageId: attachment.id,
        sourceId,
        error: message,
      });
      const document = await this.persistDocument(
        {
          ...baseDocument,
          checksum,
          status: "archive_failed",
          errorMessage: message,
        },
        input.logger,
      );
      return { document, manifestLine: `Attachment note: Could not archive LINE image ${attachment.id}. ${message}` };
    }
  }

  private async persistDocument(document: SourceDocument, logger: Logger): Promise<SourceDocument> {
    try {
      return await this.repository.save(document);
    } catch (error) {
      logger.warn("LINE source document metadata persist failed", {
        sourceId: document.sourceId,
        lineMessageId: document.lineMessageId,
        error: error instanceof Error ? error.message : "Unknown repository error",
      });
      return document;
    }
  }
}

async function prepareArchiveBytes(
  bytes: Buffer,
  mimeType: string,
  logger: Logger,
  lineMessageId: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    const compressed = await compressSlackImageForModel(bytes, mimeType);
    if (compressed) {
      return { bytes: compressed.bytes, mimeType: compressed.mimeType };
    }
  } catch (error) {
    logger.warn("LINE image compression failed; archiving original bytes", {
      lineMessageId,
      error: error instanceof Error ? error.message : "Unknown compression error",
    });
  }

  return { bytes, mimeType };
}

function normalizeImageMimeType(contentType?: string): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  return normalized?.startsWith("image/") ? normalized : "image/jpeg";
}

function buildS3Key(
  workspaceId: string,
  sourceId: string,
  lineMessageId: string,
  mimeType: string,
  timestamp: string,
): string {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  return `raw/private/line/${workspaceId}/${year}/${month}/${sourceId}/line-image-${safeMessageId(lineMessageId)}${defaultExtensionForMimeType(mimeType)}`;
}

function safeMessageId(lineMessageId: string): string {
  const normalized = lineMessageId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "message";
}
