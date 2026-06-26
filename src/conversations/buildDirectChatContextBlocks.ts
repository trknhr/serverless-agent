import { AgentContentBlock } from "../agent/types";

interface BuildDirectChatContextBlocksInput {
  currentText: string;
  receivedAt?: string;
  timeZone?: string;
}

export function buildDirectChatContextBlocks(input: BuildDirectChatContextBlocksInput): AgentContentBlock[] {
  return [
    {
      type: "text",
      text: buildPromptText(input.currentText, buildDateContext(input.receivedAt, input.timeZone)),
    },
  ];
}

function buildPromptText(currentText: string, dateContext?: string): string {
  return [
    dateContext,
    "Current user message:",
    currentText.trim(),
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
    "Use this date for relative dates such as today, tomorrow, yesterday, and this week.",
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
