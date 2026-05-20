import { AgentContentBlock } from "../agent/types";
import { ConversationTurnRecord } from "../shared/contracts";

interface BuildLineContextBlocksInput {
  priorTurns: ConversationTurnRecord[];
  currentText: string;
  attachmentBlocks?: AgentContentBlock[];
}

export function buildLineContextBlocks(input: BuildLineContextBlocksInput): AgentContentBlock[] {
  return [
    {
      type: "text",
      text: buildPromptText(input.priorTurns, input.currentText),
    },
    ...(input.attachmentBlocks ?? []),
  ];
}

function buildPromptText(priorTurns: ConversationTurnRecord[], currentText: string): string {
  const normalizedCurrentText = currentText.trim();

  if (priorTurns.length === 0) {
    return normalizedCurrentText;
  }

  return [
    "Use the following LINE conversation context only for this same-chat reply.",
    "Recent AI conversation turns from this LINE chat:",
    priorTurns.map((turn, index) => renderTurn(index, turn)).join("\n"),
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
  return `${index + 1}. ${actor}: ${truncateTurnText(turn.text)}`;
}

function truncateTurnText(text: string, maxLength = 1200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}
