import type { SQSEvent } from "aws-lambda";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { SecretsProvider } from "../../aws/secretsProvider";
import { buildLineContextBlocks } from "../../conversations/buildLineContextBlocks";
import { loadLineWorkerEnv } from "../../config/env";
import { LineAttachmentArchiveService } from "../../line/lineAttachmentArchiveService";
import { AgentTurnDisplayedOutput, hashTraceIdentifier } from "../../eval/agentTurnTrace";
import { LineMessagingClient } from "../../line/postMessage";
import { AgentTurnTraceRepository } from "../../repo/agentTurnTraceRepository";
import { ConversationSessionRepository } from "../../repo/conversationSessionRepository";
import { ConversationTurnRepository } from "../../repo/conversationTurnRepository";
import { SourceDocumentRepository } from "../../repo/sourceDocumentRepository";
import { ConversationSessionRecord, lineQueueMessageSchema } from "../../shared/contracts";
import { logger } from "../../shared/logger";
import { normalizeTextForLine } from "../../shared/text";

const env = loadLineWorkerEnv();
const secretsProvider = new SecretsProvider();
const agentClient = new AgentCoreRuntimeClient({
  runtimeArn: env.AGENTCORE_RUNTIME_ARN,
  qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
});
const lineClient = new LineMessagingClient(() =>
  secretsProvider.getSecretString(env.LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID),
);
const conversationSessionRepository = new ConversationSessionRepository(env.CONVERSATION_SESSIONS_TABLE_NAME);
const conversationTurnRepository = new ConversationTurnRepository(env.CONVERSATION_TURNS_TABLE_NAME);
const agentTurnTraceRepository = env.AGENT_TURN_TRACES_TABLE_NAME
  ? new AgentTurnTraceRepository(env.AGENT_TURN_TRACES_TABLE_NAME)
  : null;
const sourceDocumentRepository = new SourceDocumentRepository(env.SOURCE_DOCUMENTS_TABLE_NAME);
const attachmentArchiveService = new LineAttachmentArchiveService(
  env.LINE_ATTACHMENT_ARCHIVE_BUCKET_NAME,
  sourceDocumentRepository,
);

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const queueMessage = lineQueueMessageSchema.parse(JSON.parse(record.body));
    const log = logger.child({
      correlationId: queueMessage.correlationId,
      eventId: queueMessage.eventId,
      component: "line-events-worker",
    });

    const now = new Date().toISOString();
    const existingSession = await conversationSessionRepository.findByConversation(
      queueMessage.workspaceId,
      queueMessage.channelId,
      queueMessage.conversationTs,
    );
    const sessionRecord =
      existingSession ??
      createConversationSession(
        queueMessage.workspaceId,
        queueMessage.channelId,
        queueMessage.conversationTs,
      );

    if (!existingSession) {
      await conversationSessionRepository.save(sessionRecord);
    }

    const archivedAttachments = await attachmentArchiveService.archiveAttachments({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      messageTs: queueMessage.messageTs,
      userId: queueMessage.userId,
      attachments: queueMessage.attachments,
      lineClient,
      logger: log,
      ttlSeconds: 86_400,
      maxImages: 3,
    });
    const attachmentBlocks = archivedAttachments.manifestBlocks;
    const attachmentSourceIds = archivedAttachments.documents
      .filter((document) => document.status === "archived" && document.s3Bucket && document.s3Key)
      .map((document) => document.sourceId);
    const priorTurns = await conversationTurnRepository.listRecentChannelTopLevelTurns(
      queueMessage.workspaceId,
      queueMessage.channelId,
      env.TOP_LEVEL_CONTEXT_TURN_LIMIT,
    );

    const userTurn = await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: "channel_top_level",
      role: "user",
      source: "line",
      sourceEvent: "line_message",
      messageTs: queueMessage.messageTs,
      turnTs: queueMessage.messageTs,
      userId: queueMessage.userId,
      text: queueMessage.text,
    });

    const completion = await agentClient.invoke({
      sessionId: sessionRecord.agentRuntimeSessionId,
      runtimeUserId: queueMessage.userId,
      request: {
        content: buildLineContextBlocks({
          priorTurns,
          currentText: queueMessage.text,
          attachmentBlocks,
          receivedAt: queueMessage.receivedAt,
          timeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
        }),
        context: {
          source: "line",
          workspaceId: queueMessage.workspaceId,
          userId: queueMessage.userId,
          channelId: queueMessage.channelId,
          conversationTs: queueMessage.conversationTs,
          traceId: queueMessage.correlationId,
          turnId: userTurn.turnId,
          correlationId: queueMessage.correlationId,
        },
        resources: buildAgentRuntimeResources(env),
        toolContext: {
          workspaceId: queueMessage.workspaceId,
          userId: queueMessage.userId,
          channelId: queueMessage.channelId,
          attachmentSourceIds,
          memoryWritePolicy: {
            allowWorkspaceMemory: false,
            channelInferredStatus: "candidate",
            defaultOrigin: "inferred",
          },
        },
      },
    });
    const completionText = normalizeTextForLine(completion.text) || "処理は完了しましたが、返答テキストが空でした。";

    await lineClient.pushText(queueMessage.responseTargetId, completionText);

    const assistantMessageTs = createSyntheticLineTs();
    await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: "channel_top_level",
      role: "assistant",
      source: "line",
      sourceEvent: "line_assistant_reply",
      messageTs: assistantMessageTs,
      turnTs: assistantMessageTs,
      text: completionText,
    });

    await updateLineDisplayedOutputTrace({
      traceId: completion.traceId ?? queueMessage.correlationId,
      turnId: completion.turnId ?? userTurn.turnId,
      channelId: queueMessage.channelId,
      messageTs: assistantMessageTs,
      text: completionText,
      log,
    });

    await conversationSessionRepository.save({
      ...sessionRecord,
      agentRuntimeSessionId: completion.sessionId ?? sessionRecord.agentRuntimeSessionId,
      lastUsedAt: now,
    });

    log.info("LINE conversation processed", {
      agentRuntimeSessionId: completion.sessionId ?? sessionRecord.agentRuntimeSessionId,
      conversationTs: queueMessage.conversationTs,
      status: completion.status,
      responseTargetType: queueMessage.responseTargetType,
    });
  }
}

async function updateLineDisplayedOutputTrace(input: {
  traceId: string;
  turnId: string;
  channelId: string;
  messageTs?: string;
  text: string;
  log: ReturnType<typeof logger.child>;
}): Promise<void> {
  if (!agentTurnTraceRepository) {
    return;
  }

  const displayedOutput: AgentTurnDisplayedOutput = {
    surface: "line",
    text: input.text,
    messageTs: input.messageTs,
    channelIdHash: hashTraceIdentifier(input.channelId),
    postedAt: new Date().toISOString(),
  };

  try {
    const updated = await agentTurnTraceRepository.updateDisplayedOutput({
      traceId: input.traceId,
      turnId: input.turnId,
      displayedOutput,
    });
    if (!updated) {
      input.log.warn("Agent turn trace was not found for LINE displayed output update", {
        traceId: input.traceId,
        turnId: input.turnId,
      });
    }
  } catch (error) {
    input.log.warn("Failed to update LINE displayed output trace", {
      traceId: input.traceId,
      turnId: input.turnId,
      error: error instanceof Error ? error.message : "Unknown trace update error",
    });
  }
}

function createConversationSession(
  workspaceId: string,
  channelId: string,
  conversationTs: string,
): ConversationSessionRecord {
  const now = new Date().toISOString();
  return {
    workspaceId,
    channelId,
    conversationTs,
    createdAt: now,
    lastUsedAt: now,
  };
}

function createSyntheticLineTs(): string {
  return `${Date.now()}.${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`;
}
