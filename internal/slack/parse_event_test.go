package slack

import (
	"testing"

	"github.com/trknhr/slack-ai-assistant/internal/contracts"
)

func TestExtractSlackQueueMessageForAppMention(t *testing.T) {
	envelope := &ParsedEnvelope{
		Type:    "event_callback",
		EventID: "Ev123",
		TeamID:  "T123",
		Event: &slackEvent{
			Type:        "app_mention",
			ChannelType: "channel",
			Text:        "<@Ubot> remind me tomorrow",
			Channel:     "C123",
			User:        "U123",
			EventTS:     "1715000000.123456",
		},
	}

	message, err := ExtractSlackQueueMessage(envelope, "req-1")
	if err != nil {
		t.Fatalf("ExtractSlackQueueMessage returned error: %v", err)
	}
	if message == nil {
		t.Fatal("expected queue message, got nil")
	}
	if message.Text != "remind me tomorrow" {
		t.Fatalf("expected mention to be stripped, got %q", message.Text)
	}
	if message.Source != contracts.SlackSourceAppMention {
		t.Fatalf("unexpected source: %s", message.Source)
	}
	if message.ContextScope != contracts.ContextScopeChannelTopLevel {
		t.Fatalf("unexpected context scope: %s", message.ContextScope)
	}
	if message.ConversationTS != "1715000000.123456" {
		t.Fatalf("unexpected conversation ts: %s", message.ConversationTS)
	}
	if message.ReplyThreadTS != "1715000000.123456" {
		t.Fatalf("unexpected reply thread ts: %s", message.ReplyThreadTS)
	}
}

func TestExtractSlackQueueMessageForThreadReplyWithFilesOnly(t *testing.T) {
	envelope := &ParsedEnvelope{
		Type:    "event_callback",
		EventID: "Ev456",
		TeamID:  "T123",
		Event: &slackEvent{
			Type:        "message",
			ChannelType: "channel",
			Text:        "   ",
			Channel:     "C123",
			User:        "U123",
			EventTS:     "1715000001.000200",
			ThreadTS:    "1715000000.000100",
			Files: []slackFileReferenceEnvelope{
				{
					ID:    "F123",
					Title: "agenda.pdf",
				},
			},
		},
	}

	message, err := ExtractSlackQueueMessage(envelope, "req-2")
	if err != nil {
		t.Fatalf("ExtractSlackQueueMessage returned error: %v", err)
	}
	if message == nil {
		t.Fatal("expected queue message, got nil")
	}
	if message.Text != "Please analyze the attached file(s)." {
		t.Fatalf("unexpected fallback text: %q", message.Text)
	}
	if message.Source != contracts.SlackSourceThread {
		t.Fatalf("unexpected source: %s", message.Source)
	}
	if message.ContextScope != contracts.ContextScopeThread {
		t.Fatalf("unexpected context scope: %s", message.ContextScope)
	}
	if message.ConversationTS != "1715000000.000100" {
		t.Fatalf("unexpected conversation ts: %s", message.ConversationTS)
	}
	if len(message.Files) != 1 || message.Files[0].ID != "F123" {
		t.Fatalf("unexpected files payload: %#v", message.Files)
	}
}
