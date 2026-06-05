import { z } from "zod";
import { LineQueueMessage } from "../shared/contracts";

const lineSourceSchema = z
  .object({
    type: z.enum(["user", "group", "room"]),
    userId: z.string().min(1).optional(),
    groupId: z.string().min(1).optional(),
    roomId: z.string().min(1).optional(),
  })
  .passthrough();

const lineEventSchema = z
  .object({
    type: z.string().min(1),
    mode: z.string().optional(),
    timestamp: z.number().int().optional(),
    webhookEventId: z.string().min(1).optional(),
    replyToken: z.string().min(1).optional(),
    source: lineSourceSchema,
    message: z
      .object({
        id: z.string().min(1).optional(),
        type: z.string().min(1),
        text: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const lineWebhookSchema = z
  .object({
    destination: z.string().min(1),
    events: z.array(lineEventSchema).default([]),
  })
  .passthrough();

export type ParsedLineWebhook = z.infer<typeof lineWebhookSchema>;

export function parseLineWebhook(rawBody: string): ParsedLineWebhook {
  return lineWebhookSchema.parse(JSON.parse(rawBody));
}

export function extractLineQueueMessages(
  webhook: ParsedLineWebhook,
  correlationIdPrefix: string,
): LineQueueMessage[] {
  const receivedAt = new Date().toISOString();
  return webhook.events
    .map((event, index) =>
      toLineQueueMessage(webhook.destination, event, `${correlationIdPrefix}:${index}`, receivedAt),
    )
    .filter((message): message is LineQueueMessage => message !== null);
}

function toLineQueueMessage(
  providerAccountId: string,
  event: ParsedLineWebhook["events"][number],
  correlationId: string,
  receivedAt: string,
): LineQueueMessage | null {
  if (event.type !== "message" || !event.message) {
    return null;
  }

  const attachments = buildLineAttachments(event.message);
  const text = event.message.type === "text"
    ? event.message.text?.trim()
    : buildDefaultAttachmentPrompt(attachments);
  if (!text && attachments.length === 0) {
    return null;
  }
  const normalizedText = text ?? "";

  const target = resolveResponseTarget(event.source);
  if (!target) {
    return null;
  }

  const messageTs = event.message.id ?? String(event.timestamp ?? Date.now());
  const eventId = event.webhookEventId ?? `${providerAccountId}:${target.channelId}:${messageTs}`;

  return {
    correlationId,
    eventId,
    workspaceId: target.workspaceId,
    providerAccountId,
    channelId: target.channelId,
    conversationTs: target.channelId,
    messageTs,
    userId: event.source.userId ? `line:user:${event.source.userId}` : target.channelId,
    text: normalizedText,
    replyToken: event.replyToken,
    responseTargetId: target.responseTargetId,
    responseTargetType: target.responseTargetType,
    source: "message",
    contextScope: "channel_top_level",
    receivedAt,
    attachments,
  };
}

function buildLineAttachments(
  message: NonNullable<ParsedLineWebhook["events"][number]["message"]>,
): LineQueueMessage["attachments"] {
  if (message.type !== "image" || !message.id) {
    return [];
  }
  return [
    {
      id: message.id,
      type: "image",
      contentType: "image/jpeg",
    },
  ];
}

function buildDefaultAttachmentPrompt(attachments: LineQueueMessage["attachments"]): string {
  if (attachments.length === 0) {
    return "";
  }
  return [
    "The user sent image attachment(s) without text.",
    "Read the available image attachment and summarize the visible information.",
    "If the image is a document, read the text as best you can.",
    "Answer in the language of the document or the surrounding conversation.",
  ].join(" ");
}

function resolveResponseTarget(
  source: ParsedLineWebhook["events"][number]["source"],
): {
  workspaceId: string;
  channelId: string;
  responseTargetId: string;
  responseTargetType: LineQueueMessage["responseTargetType"];
} | null {
  if (source.type === "user" && source.userId) {
    const chatKey = `line:user:${source.userId}`;
    return {
      workspaceId: chatKey,
      channelId: chatKey,
      responseTargetId: source.userId,
      responseTargetType: "user",
    };
  }

  if (source.type === "group" && source.groupId) {
    const chatKey = `line:group:${source.groupId}`;
    return {
      workspaceId: chatKey,
      channelId: chatKey,
      responseTargetId: source.groupId,
      responseTargetType: "group",
    };
  }

  if (source.type === "room" && source.roomId) {
    const chatKey = `line:room:${source.roomId}`;
    return {
      workspaceId: chatKey,
      channelId: chatKey,
      responseTargetId: source.roomId,
      responseTargetType: "room",
    };
  }

  return null;
}
