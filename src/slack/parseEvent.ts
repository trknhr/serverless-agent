import { z } from "zod";
import { SlackFileReference, SlackQueueMessage } from "../shared/contracts";

const slackEnvelopeSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  event_id: z.string().optional(),
  team_id: z.string().optional(),
  authorizations: z
    .array(
      z.object({
        team_id: z.string().optional(),
      }),
    )
    .optional(),
  event: z.record(z.string(), z.unknown()).optional(),
});

export type ParsedSlackEnvelope = z.infer<typeof slackEnvelopeSchema>;

export function parseSlackEnvelope(rawBody: string): ParsedSlackEnvelope {
  return slackEnvelopeSchema.parse(JSON.parse(rawBody));
}

export function extractSlackQueueMessage(
  envelope: ParsedSlackEnvelope,
  correlationId: string,
): SlackQueueMessage | null {
  if (envelope.type !== "event_callback" || !envelope.event || !envelope.event_id) {
    return null;
  }

  const event = envelope.event;
  const type = typeof event.type === "string" ? event.type : "";
  const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
  const botId = typeof event.bot_id === "string" ? event.bot_id : undefined;

  if (subtype || botId) {
    return null;
  }

  const workspaceId =
    envelope.team_id ??
    envelope.authorizations?.find((authorization) => authorization.team_id)?.team_id;

  if (!workspaceId) {
    throw new Error("Slack event did not include team_id");
  }

  if (type === "app_mention") {
    return buildQueueMessage(event, envelope.event_id, workspaceId, correlationId, "app_mention");
  }

  const channelType = typeof event.channel_type === "string" ? event.channel_type : "";
  if (type === "message" && channelType === "im") {
    return buildQueueMessage(event, envelope.event_id, workspaceId, correlationId, "dm");
  }
  if (
    type === "message" &&
    typeof event.thread_ts === "string" &&
    event.thread_ts.length > 0 &&
    channelType !== "im"
  ) {
    const text = typeof event.text === "string" ? event.text : "";
    if (startsWithBotMention(text)) {
      return null;
    }
    return buildQueueMessage(event, envelope.event_id, workspaceId, correlationId, "thread_reply");
  }

  return null;
}

function buildQueueMessage(
  event: Record<string, unknown>,
  eventId: string,
  workspaceId: string,
  correlationId: string,
  source: "app_mention" | "dm" | "thread_reply",
): SlackQueueMessage | null {
  const text = typeof event.text === "string" ? event.text : "";
  const channelId = typeof event.channel === "string" ? event.channel : "";
  const userId = typeof event.user === "string" ? event.user : "";
  const eventTs = typeof event.event_ts === "string" ? event.event_ts : "";
  const explicitThreadTs =
    typeof event.thread_ts === "string" && event.thread_ts.length > 0 ? event.thread_ts : undefined;
  const normalizedText = source === "app_mention" ? stripBotMention(text) : text.trim();
  const files = extractFiles(event.files);
  const contextScope = explicitThreadTs ? "thread" : "channel_top_level";
  const conversationTs = explicitThreadTs ?? eventTs;
  const replyThreadTs =
    explicitThreadTs ?? (source === "app_mention" && eventTs ? eventTs : undefined);

  if (!normalizedText && files.length === 0) {
    return null;
  }

  if (!channelId || !userId || !eventTs) {
    throw new Error("Slack event is missing required message fields");
  }

  return {
    correlationId,
    eventId,
    workspaceId,
    channelId,
    conversationTs,
    replyThreadTs,
    messageTs: eventTs,
    userId,
    text: normalizedText || "Please analyze the attached file(s).",
    source,
    contextScope,
    receivedAt: new Date().toISOString(),
    files,
  };
}

function stripBotMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "").trim();
}

function startsWithBotMention(text: string): boolean {
  return /^<@[^>]+>\s*/.test(text.trimStart());
}

function extractFiles(value: unknown): SlackFileReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => toSlackFileReference(entry))
    .filter((entry): entry is SlackFileReference => entry !== null);
}

function toSlackFileReference(value: unknown): SlackFileReference | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const file = value as Record<string, unknown>;
  const id = typeof file.id === "string" ? file.id : "";
  if (!id) {
    return null;
  }

  return {
    id,
    name: typeof file.name === "string" ? file.name : undefined,
    title: typeof file.title === "string" ? file.title : undefined,
    mimetype: typeof file.mimetype === "string" ? file.mimetype : undefined,
    fileAccess: typeof file.file_access === "string" ? file.file_access : undefined,
    urlPrivate: typeof file.url_private === "string" ? file.url_private : undefined,
    urlPrivateDownload:
      typeof file.url_private_download === "string" ? file.url_private_download : undefined,
    permalink: typeof file.permalink === "string" ? file.permalink : undefined,
    isExternal: typeof file.is_external === "boolean" ? file.is_external : undefined,
    externalUrl: typeof file.external_url === "string" ? file.external_url : undefined,
    size: typeof file.size === "number" ? file.size : undefined,
  };
}
