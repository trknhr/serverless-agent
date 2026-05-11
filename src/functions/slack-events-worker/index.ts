import type { SQSEvent } from "aws-lambda";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { SecretsProvider } from "../../aws/secretsProvider";
import { CalendarDraft } from "../../calendar/calendarDraft";
import { buildSlackContextBlocks, buildTurnText } from "../../conversations/buildSlackContextBlocks";
import { loadWorkerEnv } from "../../config/env";
import { CalendarDraftRepository } from "../../repo/calendarDraftRepository";
import { ConversationSessionRepository } from "../../repo/conversationSessionRepository";
import { ConversationTurnRepository } from "../../repo/conversationTurnRepository";
import { SourceDocumentRepository } from "../../repo/sourceDocumentRepository";
import { ConversationSessionRecord, ConversationTurnRecord, slackQueueMessageSchema } from "../../shared/contracts";
import { logger } from "../../shared/logger";
import { SlackConversationsClient, SlackThreadMessage } from "../../slack/conversationsClient";
import { SlackFilesClient } from "../../slack/filesClient";
import { SlackAttachmentArchiveService } from "../../slack/slackAttachmentArchiveService";
import { SlackBlock, SlackWebClient } from "../../slack/postMessage";

const env = loadWorkerEnv();
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
        await backfillThreadHistory(queueMessage, log);
      }
    }

    const preparedAttachments = await slackFilesClient.prepareAttachments(queueMessage.files);
    await attachmentArchiveService.archiveAttachments({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      threadTs: queueMessage.replyThreadTs ?? queueMessage.conversationTs,
      messageTs: queueMessage.messageTs,
      userId: queueMessage.userId,
      attachments: preparedAttachments,
      logger: log,
    });
    const attachmentBlocks = slackFilesClient.buildContentBlocks(preparedAttachments);

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

    await conversationTurnRepository.save({
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

    const thinkingMessage = await slackClient.postMessage({
      channel: queueMessage.channelId,
      threadTs: queueMessage.replyThreadTs,
      text: "考え中です...",
    });

    const completion = await agentClient.invoke({
      sessionId: sessionRecord.agentRuntimeSessionId,
      runtimeUserId: queueMessage.userId,
      request: {
        content: buildSlackContextBlocks({
          contextScope: queueMessage.contextScope,
          priorTurns,
          currentText: queueMessage.text,
          attachmentBlocks,
        }),
        context: {
          source: "slack",
          workspaceId: queueMessage.workspaceId,
          userId: queueMessage.userId,
          channelId: queueMessage.channelId,
          conversationTs: queueMessage.conversationTs,
        },
        resources: buildAgentRuntimeResources(env),
        toolContext: {
          workspaceId: queueMessage.workspaceId,
          userId: queueMessage.userId,
          channelId: queueMessage.channelId,
          memoryWritePolicy: {
            allowWorkspaceMemory: false,
            channelInferredStatus: "candidate",
            defaultOrigin: "inferred",
          },
        },
      },
    });

    if (thinkingMessage.ts) {
      try {
        await slackClient.updateMessage({
          channel: queueMessage.channelId,
          ts: thinkingMessage.ts,
          threadTs: queueMessage.replyThreadTs,
          text: completion.text,
        });
      } catch (error) {
        log.warn("Failed to replace Slack thinking message; posting final response separately", {
          error: error instanceof Error ? error.message : "Unknown Slack update error",
        });
        await slackClient.postMessage({
          channel: queueMessage.channelId,
          threadTs: queueMessage.replyThreadTs,
          text: completion.text,
        });
      }
    } else {
      await slackClient.postMessage({
        channel: queueMessage.channelId,
        threadTs: queueMessage.replyThreadTs,
        text: completion.text,
      });
    }

    const assistantMessageTs = thinkingMessage.ts ?? createSyntheticSlackTs();
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
      text: completion.text,
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
