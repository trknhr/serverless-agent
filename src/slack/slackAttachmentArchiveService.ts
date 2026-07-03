import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SourceDocument, SourceDocumentStatus } from "../documents/sourceDocument";
import { SourceDocumentRepository } from "../repo/sourceDocumentRepository";
import { Logger } from "../shared/logger";
import { defaultExtensionForMimeType } from "./fileSupport";
import { PreparedSlackAttachment } from "./filesClient";

interface ArchiveSlackAttachmentsInput {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  attachments: PreparedSlackAttachment[];
  logger: Logger;
}

export class SlackAttachmentArchiveService {
  private readonly s3 = new S3Client({});

  constructor(
    private readonly bucketName: string,
    private readonly repository: SourceDocumentRepository,
  ) {}

  async archiveAttachments(input: ArchiveSlackAttachmentsInput): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = [];
    for (const attachment of input.attachments) {
      documents.push(await this.archiveAttachment(input, attachment));
    }
    return documents;
  }

  private async archiveAttachment(
    input: Omit<ArchiveSlackAttachmentsInput, "attachments">,
    attachment: PreparedSlackAttachment,
  ): Promise<SourceDocument> {
    const sourceId = `src_${randomUUID()}`;
    const now = new Date().toISOString();
    const archivePayload = selectArchivePayload(attachment);
    const baseDocument: SourceDocument = {
      sourceId,
      workspaceId: input.workspaceId,
      sourceType: "slack_file",
      sourceRef: attachment.file.permalink ?? attachment.file.id,
      title: attachment.label,
      slackFileId: attachment.file.id,
      slackPermalink: attachment.file.permalink,
      channelId: input.channelId,
      threadTs: input.threadTs,
      messageTs: input.messageTs,
      uploadedByUserId: input.userId,
      mimeType: archivePayload?.mimeType ?? attachment.mimeType,
      size: archivePayload?.bytes.byteLength ?? attachment.contentBytes?.byteLength ?? attachment.file.size,
      status: mapAttachmentStatus(attachment.status),
      createdAt: now,
      updatedAt: now,
    };

    if (attachment.status !== "ready" || !archivePayload) {
      return this.persistDocument(baseDocument, input.logger);
    }

    const checksum = createHash("sha256").update(archivePayload.bytes).digest("hex");
    const s3Key = buildS3Key(input.workspaceId, sourceId, archivePayload.label, archivePayload.mimeType, now);

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
          Body: archivePayload.bytes,
          ContentType: archivePayload.mimeType,
          Metadata: {
            source_id: sourceId,
            workspace_id: input.workspaceId,
            channel_id: input.channelId,
            slack_file_id: attachment.file.id,
          },
        }),
      );

      return this.persistDocument(
        {
          ...baseDocument,
          checksum,
          s3Bucket: this.bucketName,
          s3Key,
          status: "archived",
        },
        input.logger,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown archive error";
      input.logger.warn("Slack attachment archive failed", {
        slackFileId: attachment.file.id,
        sourceId,
        error: message,
      });

      return this.persistDocument(
        {
          ...baseDocument,
          checksum,
          status: "archive_failed",
          errorMessage: message,
        },
        input.logger,
      );
    }
  }

  private async persistDocument(document: SourceDocument, logger: Logger): Promise<SourceDocument> {
    try {
      return await this.repository.save(document);
    } catch (error) {
      logger.warn("Source document metadata persist failed", {
        sourceId: document.sourceId,
        slackFileId: document.slackFileId,
        error: error instanceof Error ? error.message : "Unknown repository error",
      });
      return document;
    }
  }
}

function mapAttachmentStatus(status: PreparedSlackAttachment["status"]): SourceDocumentStatus {
  switch (status) {
    case "external_link":
      return "external_link";
    case "skipped_missing_url":
      return "skipped_missing_url";
    case "skipped_oversize":
      return "skipped_oversize";
    case "skipped_unsupported":
      return "skipped_unsupported";
    case "download_failed":
      return "download_failed";
    case "ready":
      return "archived";
  }
}

function buildS3Key(
  workspaceId: string,
  sourceId: string,
  label: string,
  mimeType: string | undefined,
  timestamp: string,
): string {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const fileName = sanitizeFileName(label, sourceId, mimeType);
  return `raw/private/slack/${workspaceId}/${year}/${month}/${sourceId}/${fileName}`;
}

function sanitizeFileName(label: string, sourceId: string, mimeType?: string): string {
  const trimmed = label.trim();
  const rawName = trimmed.length > 0 ? trimmed : sourceId;
  const normalized = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safeBase = normalized.length > 0 ? normalized : sourceId;
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(safeBase);
  return hasExtension ? safeBase : `${safeBase}${defaultExtensionForMimeType(mimeType)}`;
}

interface ArchivePayload {
  bytes: Buffer;
  mimeType?: string;
  label: string;
}

function selectArchivePayload(attachment: PreparedSlackAttachment): ArchivePayload | undefined {
  if (!attachment.contentBytes) {
    return undefined;
  }

  if (attachment.modelContentBytes && attachment.modelMimeType?.startsWith("image/")) {
    return {
      bytes: attachment.modelContentBytes,
      mimeType: attachment.modelMimeType,
      label: replaceExtensionForMimeType(attachment.label, attachment.modelMimeType),
    };
  }

  return {
    bytes: attachment.contentBytes,
    mimeType: attachment.mimeType,
    label: attachment.label,
  };
}

function replaceExtensionForMimeType(label: string, mimeType?: string): string {
  const extension = defaultExtensionForMimeType(mimeType);
  const trimmed = label.trim();
  if (!extension || !trimmed) {
    return label;
  }

  const withoutExtension = trimmed.replace(/\.[a-zA-Z0-9]+$/, "");
  return `${withoutExtension || trimmed}${extension}`;
}
