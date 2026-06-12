import { createHash } from "node:crypto";
import type { SQSEvent } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { loadImportWorkerEnv } from "../../config/env";
import { SourceDocument } from "../../documents/sourceDocument";
import {
  buildAgentContentBlocksForDocument,
  buildAgentContentBlocksForDocumentUrl,
} from "../../documents/contentBlocks";
import { DocumentImportQueueMessage, documentImportQueueMessageSchema } from "../../imports/contracts";
import { DOCUMENT_IMPORT_MEMORY_INSTRUCTIONS } from "../../memory/instructions";
import { SourceDocumentRepository } from "../../repo/sourceDocumentRepository";
import { logger } from "../../shared/logger";
import { defaultExtensionForMimeType } from "../../slack/fileSupport";

const DEFAULT_IMPORT_PROMPT = [
  "Analyze the uploaded document.",
  DOCUMENT_IMPORT_MEMORY_INSTRUCTIONS,
].join(" ");

const DEFAULT_MARKDOWN_EXTRACTION_PROMPT = [
  "Transcribe the attached PDF into clean Markdown.",
  "Preserve the document structure with headings, paragraphs, lists, and tables when possible.",
  "Do not summarize, omit sections, or add commentary.",
  "If text is unreadable, keep the surrounding structure and mark the uncertain span with [unclear].",
  "Return only Markdown.",
].join(" ");

const env = loadImportWorkerEnv();
const s3 = new S3Client({});
const agentClient = new AgentCoreRuntimeClient({
  runtimeArn: env.AGENTCORE_RUNTIME_ARN,
  qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
});
const sourceDocumentRepository = new SourceDocumentRepository(env.SOURCE_DOCUMENTS_TABLE_NAME);

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const queueMessage = documentImportQueueMessageSchema.parse(JSON.parse(record.body));
    const log = logger.child({
      correlationId: queueMessage.correlationId,
      sourceId: queueMessage.sourceId,
      component: "document-import-worker",
    });

    const source = await sourceDocumentRepository.get(queueMessage.workspaceId, queueMessage.sourceId);
    if (!source) {
      throw new Error(`Source document ${queueMessage.sourceId} was not found`);
    }
    if (!source.s3Bucket || !source.s3Key) {
      throw new Error(`Source document ${queueMessage.sourceId} is missing archive coordinates`);
    }

    try {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: source.s3Bucket,
          Key: source.s3Key,
        }),
      );
      if (!object.Body) {
        throw new Error("S3 object body is empty");
      }

      const bytes = Buffer.from(await object.Body.transformToByteArray());
      if (queueMessage.operation === "extract_markdown") {
        await extractMarkdown(source, queueMessage, bytes, log);
      } else {
        await importDocument(source, queueMessage, bytes, log);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import worker error";
      await sourceDocumentRepository.save(
        queueMessage.operation === "extract_markdown"
          ? {
              ...source,
              extractionStatus: "failed",
              extractionErrorMessage: message,
              updatedAt: new Date().toISOString(),
            }
          : {
              ...source,
              status: "failed",
              errorMessage: message,
              updatedAt: new Date().toISOString(),
            },
      );
      log.error(
        queueMessage.operation === "extract_markdown"
          ? "Markdown extraction failed"
          : "Document import failed",
        { error: message },
      );
      throw error;
    }
  }
}

function buildImportPrompt(sourceRef: string, prompt?: string): string {
  return `${prompt ?? DEFAULT_IMPORT_PROMPT}\n\nSource path: ${sourceRef}`;
}

function buildMarkdownExtractionPrompt(sourceRef: string, prompt?: string): string {
  return `${prompt ?? DEFAULT_MARKDOWN_EXTRACTION_PROMPT}\n\nSource path: ${sourceRef}`;
}

async function importDocument(
  source: SourceDocument,
  queueMessage: DocumentImportQueueMessage,
  bytes: Buffer,
  log: typeof logger,
): Promise<void> {
  await sourceDocumentRepository.save({
    ...source,
    status: "processing",
    errorMessage: undefined,
    updatedAt: new Date().toISOString(),
  });

  const completion = await agentClient.invoke({
    runtimeUserId: queueMessage.userId,
    request: {
      content: [
        {
          type: "text",
          text: buildImportPrompt(source.sourceRef, queueMessage.prompt),
        },
        ...(await buildAgentContentBlocksForArchivedDocument(source, bytes)),
      ],
      context: {
        source: "local_import",
        workspaceId: source.workspaceId,
        userId: queueMessage.userId,
        sourceId: source.sourceId,
        traceId: queueMessage.correlationId,
        turnId: `${source.sourceId}:import`,
        correlationId: queueMessage.correlationId,
      },
      resources: buildAgentRuntimeResources(env),
      toolContext: {
        workspaceId: queueMessage.workspaceId,
        userId: queueMessage.userId,
      },
    },
  });

  await sourceDocumentRepository.save({
    ...source,
    status: "imported",
    summary: completion.text,
    importedTaskIds: completion.taskIds,
    importedRecurringTaskIds: completion.recurringTaskIds,
    savedMemoryIds: completion.savedMemoryIds,
    errorMessage: undefined,
    updatedAt: new Date().toISOString(),
  });

  log.info("Document imported", {
    sessionId: completion.sessionId,
    taskCount: completion.taskIds.length,
    recurringTaskCount: completion.recurringTaskIds.length,
    memoryCount: completion.savedMemoryIds.length,
  });
}

async function extractMarkdown(
  source: SourceDocument,
  queueMessage: DocumentImportQueueMessage,
  bytes: Buffer,
  log: typeof logger,
): Promise<void> {
  await sourceDocumentRepository.save({
    ...source,
    extractionStatus: "processing",
    extractionErrorMessage: undefined,
    updatedAt: new Date().toISOString(),
  });

  const completion = await agentClient.invoke({
    runtimeUserId: queueMessage.userId,
    request: {
      content: [
        {
          type: "text",
          text: buildMarkdownExtractionPrompt(source.sourceRef, queueMessage.prompt),
        },
        ...(await buildAgentContentBlocksForArchivedDocument(source, bytes)),
      ],
      context: {
        source: "markdown_extraction",
        workspaceId: source.workspaceId,
        userId: queueMessage.userId,
        sourceId: source.sourceId,
        traceId: queueMessage.correlationId,
        turnId: `${source.sourceId}:extract_markdown`,
        correlationId: queueMessage.correlationId,
      },
      resources: buildAgentRuntimeResources(env),
      disableTools: true,
    },
  });

  const markdown = completion.text.trim();
  const now = new Date().toISOString();
  const checksum = createHash("sha256").update(markdown, "utf8").digest("hex");
  const s3Key = buildExtractedMarkdownS3Key(source.workspaceId, source.sourceId, source.title, now);

  await s3.send(
    new PutObjectCommand({
      Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
      Key: s3Key,
      Body: markdown,
      ContentType: "text/markdown; charset=utf-8",
      Metadata: {
        source_id: source.sourceId,
        workspace_id: source.workspaceId,
        checksum,
      },
    }),
  );

  await sourceDocumentRepository.save({
    ...source,
    extractionStatus: "extracted",
    extractionErrorMessage: undefined,
    extractedMarkdownS3Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
    extractedMarkdownS3Key: s3Key,
    extractedMarkdownChecksum: checksum,
    extractedMarkdownSize: Buffer.byteLength(markdown, "utf-8"),
    updatedAt: now,
  });

  log.info("Markdown extracted", {
    sessionId: completion.sessionId,
    extractedMarkdownS3Key: s3Key,
  });
}

async function buildAgentContentBlocksForArchivedDocument(
  source: SourceDocument,
  bytes: Buffer,
) {
  if (source.s3Bucket && source.s3Key && shouldPassDocumentByUrl(source.mimeType)) {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: source.s3Bucket,
        Key: source.s3Key,
      }),
      { expiresIn: 15 * 60 },
    );
    return buildAgentContentBlocksForDocumentUrl(source.title, source.mimeType, url);
  }

  return buildAgentContentBlocksForDocument(source.title, source.mimeType, bytes);
}

function shouldPassDocumentByUrl(mimeType: string | undefined): boolean {
  return mimeType === "application/pdf" || Boolean(mimeType?.startsWith("image/"));
}

function buildExtractedMarkdownS3Key(
  workspaceId: string,
  sourceId: string,
  title: string,
  timestamp: string,
): string {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const safeName = sanitizeFileName(title, sourceId, "text/markdown");
  return `derived/private/extractions/${workspaceId}/${year}/${month}/${sourceId}/${safeName}`;
}

function sanitizeFileName(fileName: string, sourceId: string, mimeType: string): string {
  const trimmed = fileName.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safeBase = normalized.length > 0 ? normalized : sourceId;
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(safeBase);
  return hasExtension ? safeBase : `${safeBase}${defaultExtensionForMimeType(mimeType)}`;
}
