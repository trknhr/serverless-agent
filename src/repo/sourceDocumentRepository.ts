import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SourceDocument } from "../documents/sourceDocument";
import { documentClient } from "./documentClient";

function buildWorkspacePk(workspaceId: string): string {
  return `WORKSPACE#${workspaceId}`;
}

function buildSourceSk(sourceId: string): string {
  return `SOURCE#${sourceId}`;
}

export class SourceDocumentRepository {
  constructor(private readonly tableName: string) {}

  async save(document: SourceDocument): Promise<SourceDocument> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildWorkspacePk(document.workspaceId),
          sk: buildSourceSk(document.sourceId),
          sourceId: document.sourceId,
          workspaceId: document.workspaceId,
          sourceType: document.sourceType,
          sourceRef: document.sourceRef,
          title: document.title,
          slackFileId: document.slackFileId,
          slackPermalink: document.slackPermalink,
          lineMessageId: document.lineMessageId,
          channelId: document.channelId,
          threadTs: document.threadTs,
          messageTs: document.messageTs,
          uploadedByUserId: document.uploadedByUserId,
          mimeType: document.mimeType,
          size: document.size,
          checksum: document.checksum,
          s3Bucket: document.s3Bucket,
          s3Key: document.s3Key,
          status: document.status,
          summary: document.summary,
          importedTaskIds: document.importedTaskIds,
          importedRecurringTaskIds: document.importedRecurringTaskIds,
          savedMemoryIds: document.savedMemoryIds,
          errorMessage: document.errorMessage,
          extractionStatus: document.extractionStatus,
          extractionErrorMessage: document.extractionErrorMessage,
          extractedMarkdownS3Bucket: document.extractedMarkdownS3Bucket,
          extractedMarkdownS3Key: document.extractedMarkdownS3Key,
          extractedMarkdownChecksum: document.extractedMarkdownChecksum,
          extractedMarkdownSize: document.extractedMarkdownSize,
          expiresAt: document.expiresAt,
          ttl: document.ttl,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
        },
      }),
    );

    return document;
  }

  async get(workspaceId: string, sourceId: string): Promise<SourceDocument | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildWorkspacePk(workspaceId),
          sk: buildSourceSk(sourceId),
        },
      }),
    );

    if (!response.Item) {
      return null;
    }

    return {
      sourceId: response.Item.sourceId as string,
      workspaceId: response.Item.workspaceId as string,
      sourceType: response.Item.sourceType as SourceDocument["sourceType"],
      sourceRef: response.Item.sourceRef as string,
      title: response.Item.title as string,
      slackFileId: response.Item.slackFileId as string | undefined,
      slackPermalink: response.Item.slackPermalink as string | undefined,
      lineMessageId: response.Item.lineMessageId as string | undefined,
      channelId: response.Item.channelId as string | undefined,
      threadTs: response.Item.threadTs as string | undefined,
      messageTs: response.Item.messageTs as string | undefined,
      uploadedByUserId: response.Item.uploadedByUserId as string | undefined,
      mimeType: response.Item.mimeType as string | undefined,
      size: response.Item.size as number | undefined,
      checksum: response.Item.checksum as string | undefined,
      s3Bucket: response.Item.s3Bucket as string | undefined,
      s3Key: response.Item.s3Key as string | undefined,
      status: response.Item.status as SourceDocument["status"],
      summary: response.Item.summary as string | undefined,
      importedTaskIds: response.Item.importedTaskIds as string[] | undefined,
      importedRecurringTaskIds: response.Item.importedRecurringTaskIds as string[] | undefined,
      savedMemoryIds: response.Item.savedMemoryIds as string[] | undefined,
      errorMessage: response.Item.errorMessage as string | undefined,
      extractionStatus: response.Item.extractionStatus as SourceDocument["extractionStatus"],
      extractionErrorMessage: response.Item.extractionErrorMessage as string | undefined,
      extractedMarkdownS3Bucket: response.Item.extractedMarkdownS3Bucket as string | undefined,
      extractedMarkdownS3Key: response.Item.extractedMarkdownS3Key as string | undefined,
      extractedMarkdownChecksum: response.Item.extractedMarkdownChecksum as string | undefined,
      extractedMarkdownSize: response.Item.extractedMarkdownSize as number | undefined,
      expiresAt: response.Item.expiresAt as string | undefined,
      ttl: response.Item.ttl as number | undefined,
      createdAt: response.Item.createdAt as string,
      updatedAt: response.Item.updatedAt as string,
    };
  }
}
