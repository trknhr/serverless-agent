package conversations

import (
	"strings"
	"testing"

	"github.com/trknhr/slack-ai-assistant/internal/contracts"
)

func TestBuildTurnTextIncludesAttachmentSummary(t *testing.T) {
	text := BuildTurnText("Please review", []contracts.SlackFileReference{
		{ID: "F1", Title: "brief.pdf"},
		{ID: "F2", Name: "notes.txt"},
	})

	expected := "Please review\n\nAttachments: brief.pdf, notes.txt"
	if text != expected {
		t.Fatalf("unexpected turn text:\nexpected: %q\nactual:   %q", expected, text)
	}
}

func TestBuildSlackContextBlocksIncludesHeadingAndPriorTurns(t *testing.T) {
	blocks := BuildSlackContextBlocks(
		contracts.ContextScopeThread,
		[]contracts.ConversationTurnRecord{
			{
				Role:   "user",
				UserID: "U123",
				Text:   "Can you summarize the doc?",
			},
			{
				Role: "assistant",
				Text: "Yes. I will summarize it.",
			},
		},
		"Please continue",
		nil,
	)

	if len(blocks) != 1 {
		t.Fatalf("expected one text block, got %d", len(blocks))
	}
	text, _ := blocks[0]["text"].(string)
	if text == "" {
		t.Fatal("expected text block content")
	}
	assertContains(t, text, "Prior messages from this Slack thread:")
	assertContains(t, text, "1. user:U123: Can you summarize the doc?")
	assertContains(t, text, "2. assistant: Yes. I will summarize it.")
	assertContains(t, text, "Current user message:\nPlease continue")
}

func assertContains(t *testing.T, haystack string, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Fatalf("expected %q to contain %q", haystack, needle)
	}
}
