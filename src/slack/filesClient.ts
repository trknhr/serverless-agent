import { AgentContentBlock } from "../agent/types";
import {
  buildAgentContentBlocksForDocument,
  buildAgentContentBlocksForDocumentUrl,
} from "../documents/contentBlocks";
import { SourceDocument } from "../documents/sourceDocument";
import { SlackFileReference } from "../shared/contracts";
import {
  inferMimeTypeFromName,
  isSupportedSlackArchiveMimeType,
} from "./fileSupport";
import {
  compressSlackImageForModel,
  isCompressibleSlackImageMimeType,
} from "./imageCompression";

const defaultMaxCompressibleImageBytes = 25_000_000;

interface SlackApiFileInfoResponse {
  ok: boolean;
  error?: string;
  file?: {
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    file_access?: string;
    url_private?: string;
    url_private_download?: string;
    permalink?: string;
    is_external?: boolean;
    external_url?: string;
    size?: number;
  };
}

export type PreparedSlackAttachmentStatus =
  | "ready"
  | "external_link"
  | "skipped_missing_url"
  | "skipped_oversize"
  | "skipped_unsupported"
  | "download_failed";

export interface PreparedSlackAttachment {
  file: SlackFileReference;
  label: string;
  mimeType?: string;
  status: PreparedSlackAttachmentStatus;
  contentBlocks: AgentContentBlock[];
  contentBytes?: Buffer;
  modelContentBytes?: Buffer;
  modelMimeType?: string;
}

export class SlackFilesClient {
  constructor(
    private readonly tokenProvider: () => Promise<string>,
    private readonly maxFileBytes: number,
    private readonly maxCompressibleImageBytes = defaultMaxCompressibleImageBytes,
  ) {}

  async prepareAttachments(files: SlackFileReference[]): Promise<PreparedSlackAttachment[]> {
    const attachments: PreparedSlackAttachment[] = [];

    for (const file of files) {
      try {
        attachments.push(await this.prepareAttachment(file));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown attachment error";
        attachments.push({
          file,
          label: file.name ?? file.title ?? file.id,
          mimeType: file.mimetype ?? inferMimeTypeFromName(file.name),
          status: "download_failed",
          contentBlocks: [
            {
              type: "text",
              text: `Attachment note: Could not read ${file.name ?? file.title ?? file.id}. ${message}`,
            },
          ],
        });
      }
    }

    return attachments;
  }

  buildContentBlocks(attachments: PreparedSlackAttachment[], maxInlineFiles = 3): AgentContentBlock[] {
    const blocks: AgentContentBlock[] = [];

    for (const attachment of attachments.slice(0, maxInlineFiles)) {
      blocks.push(...attachment.contentBlocks);
    }

    if (attachments.length > maxInlineFiles) {
      blocks.push({
        type: "text",
        text: `Attachment note: ${attachments.length - maxInlineFiles} additional file(s) were archived but omitted from inline analysis to keep the request bounded.`,
      });
    }

    return blocks;
  }

  async buildContentBlocksFromArchive(
    attachments: PreparedSlackAttachment[],
    archivedDocuments: SourceDocument[],
    input: {
      presignUrl: (document: SourceDocument) => Promise<string>;
      maxInlineFiles?: number;
      maxInlineBase64Bytes?: number;
    },
  ): Promise<AgentContentBlock[]> {
    const blocks: AgentContentBlock[] = [];
    const maxInlineFiles = input.maxInlineFiles ?? 3;
    const maxInlineBase64Bytes = input.maxInlineBase64Bytes ?? 750_000;
    const documentsByFileId = new Map(
      archivedDocuments
        .filter((document) => document.slackFileId)
        .map((document) => [document.slackFileId!, document]),
    );

    for (const attachment of attachments.slice(0, maxInlineFiles)) {
      const document = documentsByFileId.get(attachment.file.id);
      if (document?.status === "archived" && document.s3Bucket && document.s3Key) {
        if (isArchivedImage(document, attachment)) {
          blocks.push({
            type: "text",
            text: buildSlackImageAttachmentManifestLine(attachment.label, document.sourceId),
          });
          continue;
        }

        try {
          const url = await input.presignUrl(document);
          blocks.push(...buildAgentContentBlocksForDocumentUrl(attachment.label, attachment.mimeType, url));
          continue;
        } catch (error) {
          blocks.push({
            type: "text",
            text: `Attachment note: ${attachment.label} was archived but could not be attached by URL. ${
              error instanceof Error ? error.message : "Unknown presign error"
            }`,
          });
          continue;
        }
      }

      const modelBytes = attachment.modelContentBytes ?? attachment.contentBytes;
      if (attachment.status === "ready" && isCompressibleSlackImageMimeType(attachment.modelMimeType ?? attachment.mimeType)) {
        if (modelBytes && modelBytes.byteLength <= maxInlineBase64Bytes) {
          blocks.push(...attachment.contentBlocks);
        } else {
          blocks.push({
            type: "text",
            text: `Attachment note: ${attachment.label} could not be attached inline because it was too large after image compression.`,
          });
        }
        continue;
      }

      if (modelBytes && modelBytes.byteLength > maxInlineBase64Bytes) {
        blocks.push({
          type: "text",
          text: `Attachment note: ${attachment.label} was archived but omitted from inline analysis because it would make the request too large.`,
        });
        continue;
      }

      blocks.push(...attachment.contentBlocks);
    }

    if (attachments.length > maxInlineFiles) {
      blocks.push({
        type: "text",
        text: `Attachment note: ${attachments.length - maxInlineFiles} additional file(s) were archived but omitted from inline analysis to keep the request bounded.`,
      });
    }

    return blocks;
  }

  private async prepareAttachment(file: SlackFileReference): Promise<PreparedSlackAttachment> {
    const resolved = await this.resolveFile(file);
    const label = resolved.name ?? resolved.title ?? resolved.id;
    const mimeType = resolved.mimetype ?? inferMimeTypeFromName(resolved.name);

    if (resolved.isExternal && resolved.externalUrl) {
      return {
        file: resolved,
        label,
        mimeType,
        status: "external_link",
        contentBlocks: [
          {
            type: "text",
            text: `Attached external file: ${label}. URL: ${resolved.externalUrl}`,
          },
        ],
      };
    }

    const isCompressibleImage = isCompressibleSlackImageMimeType(mimeType);

    if (resolved.size && resolved.size > this.maxFileBytes && !isCompressibleImage) {
      return {
        file: resolved,
        label,
        mimeType,
        status: "skipped_oversize",
        contentBlocks: [
          {
            type: "text",
            text: `Attachment note: ${label} was skipped because it is larger than ${this.maxFileBytes} bytes.`,
          },
        ],
      };
    }

    if (resolved.size && resolved.size > this.maxCompressibleImageBytes) {
      return {
        file: resolved,
        label,
        mimeType,
        status: "skipped_oversize",
        contentBlocks: [
          {
            type: "text",
            text: `Attachment note: ${label} was skipped because it is larger than ${this.maxCompressibleImageBytes} bytes.`,
          },
        ],
      };
    }

    const downloadUrl = resolved.urlPrivateDownload ?? resolved.urlPrivate;
    if (!downloadUrl) {
      return {
        file: resolved,
        label,
        mimeType,
        status: "skipped_missing_url",
        contentBlocks: [
          {
            type: "text",
            text: `Attachment note: ${label} did not include a downloadable URL.`,
          },
        ],
      };
    }

    if (!isSupportedSlackArchiveMimeType(mimeType)) {
      return {
        file: resolved,
        label,
        mimeType,
        status: "skipped_unsupported",
        contentBlocks: [
          {
            type: "text",
            text: `Attachment note: ${label} (${mimeType ?? "unknown mime type"}) is not yet supported for inline analysis.`,
          },
        ],
      };
    }

    const buffer = await this.downloadFile(downloadUrl);
    if (buffer.byteLength > this.maxFileBytes && !isCompressibleImage) {
      return {
        file: resolved,
        label,
        mimeType,
        status: "skipped_oversize",
        contentBlocks: [
          {
            type: "text",
            text: `Attachment note: ${label} exceeded the ${this.maxFileBytes} byte limit after download.`,
          },
        ],
      };
    }

    if (buffer.byteLength > this.maxCompressibleImageBytes) {
      return {
        file: resolved,
        label,
        mimeType,
        status: "skipped_oversize",
        contentBlocks: [
          {
            type: "text",
            text: `Attachment note: ${label} exceeded the ${this.maxCompressibleImageBytes} byte limit after download.`,
          },
        ],
      };
    }

    const modelInput = await buildModelInputContent(label, mimeType, buffer);

    return {
      file: resolved,
      label,
      mimeType,
      status: "ready",
      contentBytes: buffer,
      modelContentBytes: modelInput.bytes,
      modelMimeType: modelInput.mimeType,
      contentBlocks: buildAgentContentBlocksForDocument(label, modelInput.mimeType, modelInput.bytes),
    };
  }

  private async resolveFile(file: SlackFileReference): Promise<SlackFileReference> {
    if (file.fileAccess !== "check_file_info" && (file.urlPrivate || file.urlPrivateDownload)) {
      return file;
    }

    const token = await this.tokenProvider();
    const response = await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(file.id)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`files.info failed with status ${response.status}. Ensure the app has files:read.`);
    }

    const payload = (await response.json()) as SlackApiFileInfoResponse;
    if (!payload.ok || !payload.file) {
      throw new Error(
        `files.info returned error: ${payload.error ?? "missing file object"}. Ensure the app has files:read.`,
      );
    }

    return {
      id: payload.file.id ?? file.id,
      name: payload.file.name ?? file.name,
      title: payload.file.title ?? file.title,
      mimetype: payload.file.mimetype ?? file.mimetype,
      fileAccess: payload.file.file_access ?? file.fileAccess,
      urlPrivate: payload.file.url_private ?? file.urlPrivate,
      urlPrivateDownload: payload.file.url_private_download ?? file.urlPrivateDownload,
      permalink: payload.file.permalink ?? file.permalink,
      isExternal: payload.file.is_external ?? file.isExternal,
      externalUrl: payload.file.external_url ?? file.externalUrl,
      size: payload.file.size ?? file.size,
    };
  }

  private async downloadFile(downloadUrl: string): Promise<Buffer> {
    const token = await this.tokenProvider();
    const response = await fetch(downloadUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `download failed with status ${response.status}. Ensure the app has files:read and access to this channel.`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }
}

async function buildModelInputContent(
  label: string,
  mimeType: string | undefined,
  buffer: Buffer,
): Promise<{ bytes: Buffer; mimeType: string | undefined }> {
  try {
    const compressed = await compressSlackImageForModel(buffer, mimeType);
    if (compressed) {
      return {
        bytes: compressed.bytes,
        mimeType: compressed.mimeType,
      };
    }
  } catch {
    return {
      bytes: buffer,
      mimeType,
    };
  }

  return {
    bytes: buffer,
    mimeType,
  };
}

function isArchivedImage(document: SourceDocument, attachment: PreparedSlackAttachment): boolean {
  const mimeType = document.mimeType ?? attachment.modelMimeType ?? attachment.mimeType;
  return mimeType?.startsWith("image/") ?? false;
}

function buildSlackImageAttachmentManifestLine(label: string, sourceId: string): string {
  const safeLabel = label.replace(/\s+/g, " ").trim() || sourceId;
  return `Available image attachment: Slack image ${safeLabel} sourceId=${sourceId}. Use read_attachment_image with this sourceId only when the current user request needs the image.`;
}
