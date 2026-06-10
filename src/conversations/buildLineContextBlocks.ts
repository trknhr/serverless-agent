import { AgentContentBlock } from "../agent/types";
import { ConversationTurnRecord } from "../shared/contracts";

interface BuildLineContextBlocksInput {
  priorTurns: ConversationTurnRecord[];
  currentText: string;
  attachmentBlocks?: AgentContentBlock[];
  receivedAt?: string;
  timeZone?: string;
}

export function buildLineContextBlocks(input: BuildLineContextBlocksInput): AgentContentBlock[] {
  return [
    {
      type: "text",
      text: buildPromptText(
        input.priorTurns,
        input.currentText,
        buildDateContext(input.receivedAt, input.timeZone),
      ),
    },
    ...(input.attachmentBlocks ?? []),
  ];
}

function buildPromptText(
  priorTurns: ConversationTurnRecord[],
  currentText: string,
  dateContext?: string,
): string {
  const normalizedCurrentText = currentText.trim();
  const formatInstruction =
    "Format the final answer as LINE plain text. Do not use Markdown syntax such as **bold**, headings, tables, code fences, or Slack mrkdwn.";

  if (priorTurns.length === 0) {
    if (dateContext) {
      return [formatInstruction, dateContext, "Current user message:", normalizedCurrentText].join("\n");
    }
    return [formatInstruction, "Current user message:", normalizedCurrentText].join("\n");
  }

  return [
    "Use the following LINE conversation context only for this same-chat reply.",
    formatInstruction,
    dateContext,
    "Recent AI conversation turns from this LINE chat:",
    priorTurns.map((turn, index) => renderTurn(index, turn)).join("\n"),
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

  return [
    `Current local date: ${formatDateInTimeZone(date, timeZone)} (${timeZone})`,
    "Use this date for relative dates such as today, tomorrow, and this week.",
  ].join("\n");
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

function renderTurn(index: number, turn: ConversationTurnRecord): string {
  const actor =
    turn.role === "assistant"
      ? "assistant"
      : turn.userId
        ? `user:${turn.userId}`
        : turn.role;
  return `${index + 1}. ${actor}: ${truncateTurnText(turn.text)}`;
}

function truncateTurnText(text: string, maxLength = 1200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}
