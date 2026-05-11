import { AgentContentBlock } from "../agent/types";
import { buildAgentContentBlocksForDocument } from "../documents/contentBlocks";
import { SlackFileReference } from "../shared/contracts";
import {
  inferMimeTypeFromName,
  isSupportedSlackArchiveMimeType,
} from "./fileSupport";

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
}

export class SlackFilesClient {
  constructor(
    private readonly tokenProvider: () => Promise<string>,
    private readonly maxFileBytes: number,
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

    if (resolved.size && resolved.size > this.maxFileBytes) {
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
    if (buffer.byteLength > this.maxFileBytes) {
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

    return {
      file: resolved,
      label,
      mimeType,
      status: "ready",
      contentBytes: buffer,
      contentBlocks: buildAgentContentBlocksForDocument(label, mimeType, buffer),
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
