import { z } from "zod";

export const slackQueueMessageSchema = z.object({
  correlationId: z.string().min(1),
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  conversationTs: z.string().min(1),
  replyThreadTs: z.string().min(1).optional(),
  messageTs: z.string().min(1),
  userId: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(["app_mention", "dm", "thread_reply"]),
  contextScope: z.enum(["channel_top_level", "thread"]),
  receivedAt: z.string().min(1),
  files: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        title: z.string().optional(),
        mimetype: z.string().optional(),
        fileAccess: z.string().optional(),
        urlPrivate: z.string().url().optional(),
        urlPrivateDownload: z.string().url().optional(),
        permalink: z.string().url().optional(),
        isExternal: z.boolean().optional(),
        externalUrl: z.string().url().optional(),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
});

export type SlackQueueMessage = z.infer<typeof slackQueueMessageSchema>;

export type SlackFileReference = SlackQueueMessage["files"][number];

export const lineQueueMessageSchema = z.object({
  correlationId: z.string().min(1),
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  providerAccountId: z.string().min(1),
  channelId: z.string().min(1),
  conversationTs: z.string().min(1),
  messageTs: z.string().min(1),
  userId: z.string().min(1),
  text: z.string().min(1),
  replyToken: z.string().min(1).optional(),
  responseTargetId: z.string().min(1),
  responseTargetType: z.enum(["user", "group", "room"]),
  source: z.literal("message"),
  contextScope: z.literal("channel_top_level"),
  receivedAt: z.string().min(1),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum(["image"]),
        contentType: z.string().min(1).optional(),
      }),
    )
    .default([]),
});

export type LineQueueMessage = z.infer<typeof lineQueueMessageSchema>;

export interface ConversationSessionRecord {
  workspaceId: string;
  channelId: string;
  conversationTs: string;
  agentRuntimeSessionId?: string;
  memoryStoreId?: string;
  createdAt: string;
  lastUsedAt: string;
}

export type WorkSessionKind = "browser" | "sandbox";

export type WorkSessionStatus = "active" | "completed" | "expired";

export interface WorkSessionRecord {
  workspaceId: string;
  ownerUserId: string;
  workSessionId: string;
  runtimeSessionId: string;
  kind: WorkSessionKind;
  status: WorkSessionStatus;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  ttl: number;
}

export interface ConversationTurnRecord {
  turnId: string;
  workspaceId: string;
  channelId: string;
  conversationTs: string;
  contextScope: "channel_top_level" | "thread";
  role: "user" | "assistant" | "tool" | "system";
  source: "slack" | "line";
  sourceEvent:
    | "app_mention"
    | "dm"
    | "thread_reply"
    | "assistant_reply"
    | "scheduled_reminder"
    | "thread_backfill"
    | "line_message"
    | "line_assistant_reply";
  threadTs?: string;
  messageTs: string;
  turnTs: string;
  userId?: string;
  text: string;
  createdAt: string;
}

export interface ThreadSessionRecord {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  sessionId: string;
  memoryStoreId?: string;
  createdAt: string;
  lastUsedAt: string;
}
