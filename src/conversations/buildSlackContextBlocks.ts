import { AgentContentBlock } from "../agent/types";
import { ConversationTurnRecord, SlackFileReference } from "../shared/contracts";

interface BuildSlackContextBlocksInput {
  contextScope: "channel_top_level" | "thread";
  priorTurns: ConversationTurnRecord[];
  currentText: string;
  attachmentBlocks: AgentContentBlock[];
}

export function buildSlackContextBlocks(input: BuildSlackContextBlocksInput): AgentContentBlock[] {
  const text = buildPromptText(input.contextScope, input.priorTurns, input.currentText);
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
): string {
  const normalizedCurrentText = currentText.trim();

  if (priorTurns.length === 0) {
    return normalizedCurrentText;
  }

  const heading =
    contextScope === "thread"
      ? "Prior messages from this Slack thread:"
      : "Recent top-level AI conversation turns from this Slack channel:";
  const renderedTurns = priorTurns.map((turn, index) => renderTurn(index, turn)).join("\n");

  return [
    "Use the following Slack conversation context only for this same-channel reply.",
    heading,
    renderedTurns,
    "",
    "Current user message:",
    normalizedCurrentText,
  ].join("\n");
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
