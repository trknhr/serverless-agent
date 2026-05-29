import { AgentContentBlock } from "../agent/types";
import { ConversationTurnRecord, SlackFileReference } from "../shared/contracts";

interface BuildSlackContextBlocksInput {
  contextScope: "channel_top_level" | "thread";
  priorTurns: ConversationTurnRecord[];
  currentText: string;
  attachmentBlocks: AgentContentBlock[];
  receivedAt?: string;
  timeZone?: string;
}

export function buildSlackContextBlocks(input: BuildSlackContextBlocksInput): AgentContentBlock[] {
  const text = buildPromptText(
    input.contextScope,
    input.priorTurns,
    input.currentText,
    input.attachmentBlocks.length > 0,
    buildDateContext(input.receivedAt, input.timeZone),
  );
  return [
    {
      type: "text",
      text,
    },
    ...input.attachmentBlocks,
  ];
}

export function buildTurnText(text: string, files: SlackFileReference[]): string {
  const normalizedText = text.trim();
  const attachmentSummary = summarizeFiles(files);
  if (!attachmentSummary) {
    return normalizedText;
  }

  if (!normalizedText) {
    return attachmentSummary;
  }

  return `${normalizedText}\n\n${attachmentSummary}`;
}

function buildPromptText(
  contextScope: "channel_top_level" | "thread",
  priorTurns: ConversationTurnRecord[],
  currentText: string,
  hasAttachments: boolean,
  dateContext?: string,
): string {
  const normalizedCurrentText = currentText.trim() || buildDefaultAttachmentPrompt(hasAttachments);

  if (priorTurns.length === 0) {
    if (dateContext) {
      return [dateContext, "Current user message:", normalizedCurrentText].join("\n");
    }
    return normalizedCurrentText;
  }

  const heading =
    contextScope === "thread"
      ? "Prior messages from this Slack thread:"
      : "Recent top-level AI conversation turns from this Slack channel:";
  const renderedTurns = priorTurns.map((turn, index) => renderTurn(index, turn)).join("\n");

  return [
    "Use the following Slack conversation context only for this same-channel reply.",
    dateContext,
    heading,
    renderedTurns,
    "",
    "Current user message:",
    normalizedCurrentText,
  ].filter(Boolean).join("\n");
}

function buildDateContext(receivedAt: string | undefined, timeZone = "Asia/Tokyo"): string | undefined {
  if (!receivedAt) {
    return undefined;
  }

  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return `Current local date: ${formatDateInTimeZone(date, timeZone)} (${timeZone})`;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function buildDefaultAttachmentPrompt(hasAttachments: boolean): string {
  if (!hasAttachments) {
    return "";
  }

  return [
    "The user sent attachment(s) without an explicit instruction.",
    "Analyze the attached content directly and summarize the visible information.",
    "If the attachment is an image of a document, read the text from the image as best you can.",
    "If it contains durable details such as rules, events, procedures, or references, ask whether to save them for later before using memory tools.",
    "Answer in the language of the document or the surrounding conversation.",
  ].join(" ");
}

function renderTurn(index: number, turn: ConversationTurnRecord): string {
  const actor =
    turn.role === "assistant"
      ? "assistant"
      : turn.userId
        ? `user:${turn.userId}`
        : turn.role;
  const text = truncateTurnText(turn.text);
  return `${index + 1}. ${actor}: ${text}`;
}

function truncateTurnText(text: string, maxLength = 1200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function summarizeFiles(files: SlackFileReference[]): string {
  if (files.length === 0) {
    return "";
  }

  const labels = files.map((file) => file.title ?? file.name ?? file.id).filter(Boolean);
  return `Attachments: ${labels.join(", ")}`;
}
