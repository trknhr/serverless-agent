package conversations

import (
	"fmt"
	"strings"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
)

func BuildSlackContextBlocks(contextScope contracts.ContextScope, priorTurns []contracts.ConversationTurnRecord, currentText string, attachmentBlocks []anthropic.InputBlock) []anthropic.InputBlock {
	text := buildPromptText(contextScope, priorTurns, currentText)
	blocks := []anthropic.InputBlock{
		{
			"type": "text",
			"text": text,
		},
	}
	return append(blocks, attachmentBlocks...)
}

func BuildTurnText(text string, files []contracts.SlackFileReference) string {
	normalizedText := strings.TrimSpace(text)
	attachmentSummary := summarizeFiles(files)
	if attachmentSummary == "" {
		return normalizedText
	}
	if normalizedText == "" {
		return attachmentSummary
	}
	return normalizedText + "\n\n" + attachmentSummary
}

func buildPromptText(contextScope contracts.ContextScope, priorTurns []contracts.ConversationTurnRecord, currentText string) string {
	normalizedCurrentText := strings.TrimSpace(currentText)
	if len(priorTurns) == 0 {
		return normalizedCurrentText
	}
	heading := "Recent top-level AI conversation turns from this Slack channel:"
	if contextScope == contracts.ContextScopeThread {
		heading = "Prior messages from this Slack thread:"
	}
	lines := []string{
		"Use the following Slack conversation context only for this same-channel reply.",
		heading,
	}
	for index, turn := range priorTurns {
		lines = append(lines, renderTurn(index, turn))
	}
	lines = append(lines, "", "Current user message:", normalizedCurrentText)
	return strings.Join(lines, "\n")
}

func renderTurn(index int, turn contracts.ConversationTurnRecord) string {
	actor := turn.Role
	if turn.Role == "assistant" {
		actor = "assistant"
	} else if turn.UserID != "" {
		actor = "user:" + turn.UserID
	}
	return fmt.Sprintf("%d. %s: %s", index+1, actor, truncateTurnText(turn.Text, 1200))
}

func truncateTurnText(text string, maxLength int) string {
	normalized := strings.Join(strings.Fields(text), " ")
	if len(normalized) <= maxLength {
		return normalized
	}
	return normalized[:maxLength-1] + "..."
}

func summarizeFiles(files []contracts.SlackFileReference) string {
	if len(files) == 0 {
		return ""
	}
	labels := make([]string, 0, len(files))
	for _, file := range files {
		label := chooseString(file.Title, file.Name, file.ID)
		if label != "" {
			labels = append(labels, label)
		}
	}
	return "Attachments: " + strings.Join(labels, ", ")
}

func chooseString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
