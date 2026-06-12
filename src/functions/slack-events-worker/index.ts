import type { SQSEvent } from "aws-lambda";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AgentRunResult } from "../../agent/types";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { SecretsProvider } from "../../aws/secretsProvider";
import { CalendarDraft } from "../../calendar/calendarDraft";
import { buildSlackContextBlocks, buildTurnText } from "../../conversations/buildSlackContextBlocks";
import { loadWorkerEnv } from "../../config/env";
import { SourceDocument } from "../../documents/sourceDocument";
import {
  AgentTurnDisplayedOutput,
  buildTraceExpiresAt,
  hashTraceIdentifier,
  summarizeAgentContentBlocks,
} from "../../eval/agentTurnTrace";
import { AgentTurnTraceRepository } from "../../repo/agentTurnTraceRepository";
import { CalendarDraftRepository } from "../../repo/calendarDraftRepository";
import { ConversationSessionRepository } from "../../repo/conversationSessionRepository";
import { ConversationTurnRepository } from "../../repo/conversationTurnRepository";
import { SourceDocumentRepository } from "../../repo/sourceDocumentRepository";
import { ConversationSessionRecord, ConversationTurnRecord, slackQueueMessageSchema } from "../../shared/contracts";
import { logger } from "../../shared/logger";
import { stripModelThinking } from "../../shared/text";
import { SlackConversationsClient, SlackThreadMessage } from "../../slack/conversationsClient";
import { SlackFilesClient } from "../../slack/filesClient";
import { SlackAttachmentArchiveService } from "../../slack/slackAttachmentArchiveService";
import { SlackBlock, SlackWebClient } from "../../slack/postMessage";

const env = loadWorkerEnv();
const s3Client = new S3Client({});
const secretsProvider = new SecretsProvider();
const agentClient = new AgentCoreRuntimeClient({
  runtimeArn: env.AGENTCORE_RUNTIME_ARN,
  qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
});
const slackClient = new SlackWebClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const slackConversationsClient = new SlackConversationsClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const slackFilesClient = new SlackFilesClient(
  () => secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
  env.MAX_SLACK_FILE_BYTES,
);
const calendarDraftRepository = new CalendarDraftRepository(env.CALENDAR_DRAFTS_TABLE_NAME);
const conversationSessionRepository = new ConversationSessionRepository(env.CONVERSATION_SESSIONS_TABLE_NAME);
const conversationTurnRepository = new ConversationTurnRepository(env.CONVERSATION_TURNS_TABLE_NAME);
const agentTurnTraceRepository = env.AGENT_TURN_TRACES_TABLE_NAME
  ? new AgentTurnTraceRepository(env.AGENT_TURN_TRACES_TABLE_NAME)
  : null;
const sourceDocumentRepository = new SourceDocumentRepository(env.SOURCE_DOCUMENTS_TABLE_NAME);
const attachmentArchiveService = new SlackAttachmentArchiveService(
  env.SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME,
  sourceDocumentRepository,
);

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const queueMessage = slackQueueMessageSchema.parse(JSON.parse(record.body));
    const log = logger.child({
      correlationId: queueMessage.correlationId,
      eventId: queueMessage.eventId,
      component: "slack-events-worker",
    });

    const now = new Date().toISOString();
    const existingSession = await conversationSessionRepository.findByConversation(
      queueMessage.workspaceId,
      queueMessage.channelId,
      queueMessage.conversationTs,
    );

    if (queueMessage.source === "thread_reply" && !existingSession) {
      log.info("Slack thread reply ignored because no assistant session exists", {
        channelId: queueMessage.channelId,
        conversationTs: queueMessage.conversationTs,
        messageTs: queueMessage.messageTs,
      });
      continue;
    }

    const sessionRecord =
      existingSession ??
      createConversationSession(
        queueMessage.workspaceId,
        queueMessage.channelId,
        queueMessage.conversationTs,
      );

    if (!existingSession) {
      await conversationSessionRepository.save(sessionRecord);

      if (queueMessage.contextScope === "thread") {
        try {
          await backfillThreadHistory(queueMessage, log);
        } catch (error) {
          log.warn("Slack thread history backfill failed; continuing without prior thread context", {
            error: error instanceof Error ? error.message : "Unknown Slack backfill error",
            channelId: queueMessage.channelId,
            conversationTs: queueMessage.conversationTs,
          });
        }
      }
    }

    const thinkingMessage = await slackClient.postMessage({
      channel: queueMessage.channelId,
      threadTs: queueMessage.replyThreadTs,
      text: "考え中です...",
    });

    const preparedAttachments = await slackFilesClient.prepareAttachments(queueMessage.files);
    const archivedDocuments = await attachmentArchiveService.archiveAttachments({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      threadTs: queueMessage.replyThreadTs ?? queueMessage.conversationTs,
      messageTs: queueMessage.messageTs,
      userId: queueMessage.userId,
      attachments: preparedAttachments,
      logger: log,
    });
    const attachmentBlocks = await slackFilesClient.buildContentBlocksFromArchive(
      preparedAttachments,
      archivedDocuments,
      {
        presignUrl: presignSourceDocument,
      },
    );

    const priorTurns =
      queueMessage.contextScope === "thread"
        ? await conversationTurnRepository.listByConversation(
            queueMessage.workspaceId,
            queueMessage.channelId,
            queueMessage.conversationTs,
          )
        : await conversationTurnRepository.listRecentChannelTopLevelTurns(
            queueMessage.workspaceId,
            queueMessage.channelId,
            env.TOP_LEVEL_CONTEXT_TURN_LIMIT,
          );

    const userTurn = await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: queueMessage.contextScope,
      role: "user",
      source: "slack",
      sourceEvent: queueMessage.source,
      threadTs: queueMessage.replyThreadTs,
      messageTs: queueMessage.messageTs,
      turnTs: queueMessage.messageTs,
      userId: queueMessage.userId,
      text: buildTurnText(queueMessage.text, queueMessage.files),
    });

    const completion = await invokeAgentOrRespondWithError({
      queueMessage,
      sessionRecord,
      thinkingMessageTs: thinkingMessage.ts,
      content: buildSlackContextBlocks({
        contextScope: queueMessage.contextScope,
        priorTurns,
        currentText: queueMessage.text,
        attachmentBlocks,
        receivedAt: queueMessage.receivedAt,
        timeZone: "Asia/Tokyo",
      }),
      log,
      userTurnId: userTurn.turnId,
    });
    if (!completion) {
      await conversationSessionRepository.save({
        ...sessionRecord,
        lastUsedAt: now,
      });
      continue;
    }
    const completionText = stripModelThinking(completion.text) || "処理は完了しましたが、返答テキストが空でした。";

    let displayedMessageTs = thinkingMessage.ts;
    if (thinkingMessage.ts) {
      try {
        await slackClient.updateMessage({
          channel: queueMessage.channelId,
          ts: thinkingMessage.ts,
          threadTs: queueMessage.replyThreadTs,
          text: completionText,
        });
      } catch (error) {
        log.warn("Failed to replace Slack thinking message; posting final response separately", {
          error: error instanceof Error ? error.message : "Unknown Slack update error",
        });
        const postedMessage = await slackClient.postMessage({
          channel: queueMessage.channelId,
          threadTs: queueMessage.replyThreadTs,
          text: completionText,
        });
        displayedMessageTs = postedMessage.ts ?? displayedMessageTs;
      }
    } else {
      const postedMessage = await slackClient.postMessage({
        channel: queueMessage.channelId,
        threadTs: queueMessage.replyThreadTs,
        text: completionText,
      });
      displayedMessageTs = postedMessage.ts;
    }

    const assistantMessageTs = displayedMessageTs ?? createSyntheticSlackTs();
    await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: queueMessage.contextScope,
      role: "assistant",
      source: "slack",
      sourceEvent: "assistant_reply",
      threadTs: queueMessage.replyThreadTs,
      messageTs: assistantMessageTs,
      turnTs: assistantMessageTs,
      text: completionText,
    });

    await updateSlackDisplayedOutputTrace({
      traceId: completion.traceId ?? queueMessage.correlationId,
      turnId: completion.turnId ?? userTurn.turnId,
      channelId: queueMessage.channelId,
      threadTs: queueMessage.replyThreadTs,
      messageTs: displayedMessageTs,
      text: completionText,
      log,
    });

    for (const draftId of completion.calendarDraftIds) {
      const draft = await calendarDraftRepository.get(queueMessage.workspaceId, queueMessage.userId, draftId);
      if (!draft) {
        continue;
      }
      await slackClient.postMessage({
        channel: queueMessage.channelId,
        threadTs: queueMessage.replyThreadTs ?? assistantMessageTs,
        text: buildCalendarDraftApprovalText(draft),
        blocks: buildCalendarDraftApprovalBlocks(draft, {
          channelId: queueMessage.channelId,
          messageTs: assistantMessageTs,
        }),
      });
    }

    await conversationSessionRepository.save({
      ...sessionRecord,
      agentRuntimeSessionId: completion.sessionId ?? sessionRecord.agentRuntimeSessionId,
      lastUsedAt: now,
    });

    log.info("Slack conversation processed", {
      agentRuntimeSessionId: completion.sessionId ?? sessionRecord.agentRuntimeSessionId,
      conversationTs: queueMessage.conversationTs,
      contextScope: queueMessage.contextScope,
      status: completion.status,
      attachmentCount: queueMessage.files.length,
      archivedAttachmentCount: preparedAttachments.filter((attachment) => attachment.status === "ready").length,
    });
  }
}

async function invokeAgentOrRespondWithError(input: {
  queueMessage: {
    correlationId: string;
    workspaceId: string;
    channelId: string;
    conversationTs: string;
    replyThreadTs?: string;
    userId: string;
    contextScope: "thread" | "channel_top_level";
  };
  sessionRecord: ConversationSessionRecord;
  thinkingMessageTs?: string;
  content: ReturnType<typeof buildSlackContextBlocks>;
  log: ReturnType<typeof logger.child>;
  userTurnId: string;
}): Promise<AgentRunResult | null> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    return await agentClient.invoke({
      sessionId: input.sessionRecord.agentRuntimeSessionId,
      runtimeUserId: input.queueMessage.userId,
      request: {
        content: input.content,
        context: {
          source: "slack",
          workspaceId: input.queueMessage.workspaceId,
          userId: input.queueMessage.userId,
          channelId: input.queueMessage.channelId,
          conversationTs: input.queueMessage.conversationTs,
          traceId: input.queueMessage.correlationId,
          turnId: input.userTurnId,
          correlationId: input.queueMessage.correlationId,
        },
        resources: buildAgentRuntimeResources(env),
        toolContext: {
          workspaceId: input.queueMessage.workspaceId,
          userId: input.queueMessage.userId,
          channelId: input.queueMessage.channelId,
          memoryWritePolicy: {
            allowWorkspaceMemory: false,
            channelInferredStatus: "candidate",
            defaultOrigin: "inferred",
          },
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown AgentCore invocation error";
    input.log.error("AgentCore invocation failed", { error: message });
    const responseText = buildAgentInvocationErrorText(message);
    let displayedMessageTs = input.thinkingMessageTs;

    if (input.thinkingMessageTs) {
      try {
        await slackClient.updateMessage({
          channel: input.queueMessage.channelId,
          ts: input.thinkingMessageTs,
          threadTs: input.queueMessage.replyThreadTs,
          text: responseText,
        });
      } catch (error) {
        input.log.warn("Failed to replace Slack thinking message after AgentCore failure", {
          error: error instanceof Error ? error.message : "Unknown Slack update error",
        });
        const postedMessage = await slackClient.postMessage({
          channel: input.queueMessage.channelId,
          threadTs: input.queueMessage.replyThreadTs,
          text: responseText,
        });
        displayedMessageTs = postedMessage.ts ?? displayedMessageTs;
      }
    } else {
      const postedMessage = await slackClient.postMessage({
        channel: input.queueMessage.channelId,
        threadTs: input.queueMessage.replyThreadTs,
        text: responseText,
      });
      displayedMessageTs = postedMessage.ts;
    }

    const errorMessageTs = displayedMessageTs ?? createSyntheticSlackTs();
    await conversationTurnRepository.save({
      workspaceId: input.queueMessage.workspaceId,
      channelId: input.queueMessage.channelId,
      conversationTs: input.queueMessage.conversationTs,
      contextScope: input.queueMessage.contextScope,
      role: "assistant",
      source: "slack",
      sourceEvent: "assistant_reply",
      threadTs: input.queueMessage.replyThreadTs,
      messageTs: errorMessageTs,
      turnTs: errorMessageTs,
      text: responseText,
    });

    await saveSlackInvocationFailureTrace({
      traceId: input.queueMessage.correlationId,
      turnId: input.userTurnId,
      queueMessage: input.queueMessage,
      content: input.content,
      startedAt,
      latencyMs: Date.now() - started,
      error: message,
      displayedOutput: buildSlackDisplayedOutput({
        channelId: input.queueMessage.channelId,
        threadTs: input.queueMessage.replyThreadTs,
        messageTs: displayedMessageTs,
        text: responseText,
      }),
      log: input.log,
    });

    return null;
  }
}

async function updateSlackDisplayedOutputTrace(input: {
  traceId: string;
  turnId: string;
  channelId: string;
  threadTs?: string;
  messageTs?: string;
  text: string;
  log: ReturnType<typeof logger.child>;
}): Promise<void> {
  if (!agentTurnTraceRepository) {
    return;
  }

  try {
    const updated = await agentTurnTraceRepository.updateDisplayedOutput({
      traceId: input.traceId,
      turnId: input.turnId,
      displayedOutput: buildSlackDisplayedOutput(input),
    });
    if (!updated) {
      input.log.warn("Agent turn trace was not found for displayed output update", {
        traceId: input.traceId,
        turnId: input.turnId,
      });
    }
  } catch (error) {
    input.log.warn("Failed to update agent turn displayed output trace", {
      traceId: input.traceId,
      turnId: input.turnId,
      error: error instanceof Error ? error.message : "Unknown trace update error",
    });
  }
}

async function saveSlackInvocationFailureTrace(input: {
  traceId: string;
  turnId: string;
  queueMessage: {
    workspaceId: string;
    channelId: string;
    conversationTs: string;
    userId: string;
  };
  content: ReturnType<typeof buildSlackContextBlocks>;
  startedAt: string;
  latencyMs: number;
  error: string;
  displayedOutput: AgentTurnDisplayedOutput;
  log: ReturnType<typeof logger.child>;
}): Promise<void> {
  if (!agentTurnTraceRepository) {
    return;
  }

  try {
    await agentTurnTraceRepository.save({
      traceId: input.traceId,
      turnId: input.turnId,
      workspaceId: input.queueMessage.workspaceId,
      source: "slack",
      status: "failed",
      createdAt: input.startedAt,
      updatedAt: new Date().toISOString(),
      expiresAt: buildTraceExpiresAt(input.startedAt),
      userIdHash: hashTraceIdentifier(input.queueMessage.userId),
      channelIdHash: hashTraceIdentifier(input.queueMessage.channelId),
      conversationId: input.queueMessage.conversationTs,
      input: summarizeAgentContentBlocks(input.content),
      displayedOutput: input.displayedOutput,
      toolCalls: [],
      summary: {
        taskIds: [],
        recurringTaskIds: [],
        savedMemoryIds: [],
        calendarDraftIds: [],
      },
      error: input.error,
      latencyMs: input.latencyMs,
    });
  } catch (error) {
    input.log.warn("Failed to save AgentCore invocation failure trace", {
      traceId: input.traceId,
      turnId: input.turnId,
      error: error instanceof Error ? error.message : "Unknown trace save error",
    });
  }
}

function buildSlackDisplayedOutput(input: {
  channelId: string;
  threadTs?: string;
  messageTs?: string;
  text: string;
}): AgentTurnDisplayedOutput {
  return {
    surface: "slack",
    text: input.text,
    messageTs: input.messageTs,
    threadTs: input.threadTs,
    channelIdHash: hashTraceIdentifier(input.channelId),
    postedAt: new Date().toISOString(),
  };
}

async function presignSourceDocument(document: SourceDocument): Promise<string> {
  if (!document.s3Bucket || !document.s3Key) {
    throw new Error("Archived document does not have an S3 location.");
  }

  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: document.s3Bucket,
      Key: document.s3Key,
    }),
    { expiresIn: 15 * 60 },
  );
}

function buildAgentInvocationErrorText(message: string): string {
  if (message.includes("413") || message.includes("length limit exceeded")) {
    return [
      "添付ファイルの内容が大きすぎて処理できませんでした。",
      "ファイルは保存済みなので、少し小さい画像/PDFで再送するか、必要な箇所を本文で指定してください。",
    ].join("\n");
  }

  if (message.includes("use case details have not been submitted")) {
    return "添付ファイル解析用のBedrockモデルがAWS側でまだ有効化されていません。設定を確認してください。";
  }

  return "処理中にエラーが発生しました。もう一度試してください。";
}

function buildCalendarDraftApprovalText(draft: CalendarDraft): string {
  const candidateLines = draft.candidates
    .filter((candidate) => candidate.status === "pending")
    .slice(0, 5)
    .map((candidate) => `- ${candidate.summary} (${formatCalendarCandidateTime(candidate)})`);
  return [
    `カレンダー下書き「${draft.title}」を作成しました。`,
    ...candidateLines,
    "作成してよければ承認してください。",
  ].join("\n");
}

function buildCalendarDraftApprovalBlocks(
  draft: CalendarDraft,
  context: { channelId: string; messageTs: string },
): SlackBlock[] {
  const pendingCandidates = draft.candidates.filter((candidate) => candidate.status === "pending");
  const candidateText = pendingCandidates
    .slice(0, 5)
    .map((candidate) => `• ${candidate.summary} (${formatCalendarCandidateTime(candidate)})`)
    .join("\n");
  const suffix = pendingCandidates.length > 5 ? `\n他 ${pendingCandidates.length - 5} 件` : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*カレンダー下書き*: ${draft.title}\n${candidateText || "承認待ち候補はありません。"}${suffix}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "承認して作成" },
          style: "primary",
          action_id: "calendar_draft_approve",
          value: JSON.stringify({
            action: "approve",
            workspaceId: draft.workspaceId,
            userId: draft.userId,
            draftId: draft.draftId,
            channelId: context.channelId,
            messageTs: context.messageTs,
          }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "却下" },
          style: "danger",
          action_id: "calendar_draft_reject",
          value: JSON.stringify({
            action: "reject",
            workspaceId: draft.workspaceId,
            userId: draft.userId,
            draftId: draft.draftId,
            channelId: context.channelId,
            messageTs: context.messageTs,
          }),
        },
      ],
    },
  ];
}

function formatCalendarCandidateTime(candidate: CalendarDraft["candidates"][number]): string {
  if (candidate.allDay) {
    return candidate.endDate && candidate.endDate !== candidate.startDate
      ? `${candidate.startDate} - ${candidate.endDate}`
      : candidate.startDate ?? "日時未定";
  }

  return candidate.endAt ? `${candidate.startAt} - ${candidate.endAt}` : candidate.startAt ?? "日時未定";
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

async function backfillThreadHistory(
  queueMessage: {
    workspaceId: string;
    channelId: string;
    conversationTs: string;
    messageTs: string;
  },
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  const threadMessages = await slackConversationsClient.listReplies(
    queueMessage.channelId,
    queueMessage.conversationTs,
  );
  const priorMessages = threadMessages.filter((message) => compareSlackTs(message.ts, queueMessage.messageTs) < 0);

  for (const message of priorMessages) {
    const text = buildTurnText(message.text, message.files);
    if (!text.trim()) {
      continue;
    }

    await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: "thread",
      role: inferBackfillRole(message),
      source: "slack",
      sourceEvent: "thread_backfill",
      threadTs: queueMessage.conversationTs,
      messageTs: message.ts,
      turnTs: message.ts,
      userId: message.userId,
      text,
    });
  }

  log.info("Slack thread history backfilled", {
    channelId: queueMessage.channelId,
    conversationTs: queueMessage.conversationTs,
    backfilledTurnCount: priorMessages.length,
  });
}

function inferBackfillRole(message: SlackThreadMessage): ConversationTurnRecord["role"] {
  return message.botId || message.subtype ? "system" : "user";
}

function compareSlackTs(left: string, right: string): number {
  return parseFloat(left) - parseFloat(right);
}

function createSyntheticSlackTs(): string {
  const milliseconds = Date.now();
  const seconds = Math.floor(milliseconds / 1000);
  const micros = `${milliseconds % 1000}`.padStart(3, "0");
  return `${seconds}.${micros}000`;
}
