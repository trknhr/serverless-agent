package slack

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/trknhr/slack-ai-assistant/internal/contracts"
)

type ParsedEnvelope struct {
	Type           string                  `json:"type"`
	Challenge      string                  `json:"challenge,omitempty"`
	EventID        string                  `json:"event_id,omitempty"`
	TeamID         string                  `json:"team_id,omitempty"`
	Authorizations []envelopeAuthorization `json:"authorizations,omitempty"`
	Event          *slackEvent             `json:"event,omitempty"`
}

type envelopeAuthorization struct {
	TeamID string `json:"team_id,omitempty"`
}

type slackEvent struct {
	Type        string                       `json:"type"`
	Subtype     string                       `json:"subtype,omitempty"`
	BotID       string                       `json:"bot_id,omitempty"`
	ChannelType string                       `json:"channel_type,omitempty"`
	Text        string                       `json:"text,omitempty"`
	Channel     string                       `json:"channel,omitempty"`
	User        string                       `json:"user,omitempty"`
	EventTS     string                       `json:"event_ts,omitempty"`
	ThreadTS    string                       `json:"thread_ts,omitempty"`
	Files       []slackFileReferenceEnvelope `json:"files,omitempty"`
}

type slackFileReferenceEnvelope struct {
	ID                 string `json:"id"`
	Name               string `json:"name,omitempty"`
	Title              string `json:"title,omitempty"`
	Mimetype           string `json:"mimetype,omitempty"`
	FileAccess         string `json:"file_access,omitempty"`
	URLPrivate         string `json:"url_private,omitempty"`
	URLPrivateDownload string `json:"url_private_download,omitempty"`
	Permalink          string `json:"permalink,omitempty"`
	IsExternal         *bool  `json:"is_external,omitempty"`
	ExternalURL        string `json:"external_url,omitempty"`
	Size               *int64 `json:"size,omitempty"`
}

func ParseEnvelope(rawBody string) (*ParsedEnvelope, error) {
	var envelope ParsedEnvelope
	if err := json.Unmarshal([]byte(rawBody), &envelope); err != nil {
		return nil, err
	}
	return &envelope, nil
}

func ExtractSlackQueueMessage(envelope *ParsedEnvelope, correlationID string) (*contracts.SlackQueueMessage, error) {
	if envelope.Type != "event_callback" || envelope.Event == nil || envelope.EventID == "" {
		return nil, nil
	}

	event := envelope.Event
	if event.Subtype != "" || event.BotID != "" {
		return nil, nil
	}

	workspaceID := envelope.TeamID
	if workspaceID == "" {
		for _, authorization := range envelope.Authorizations {
			if authorization.TeamID != "" {
				workspaceID = authorization.TeamID
				break
			}
		}
	}
	if workspaceID == "" {
		return nil, errors.New("slack event did not include team_id")
	}

	switch {
	case event.Type == "app_mention":
		return buildQueueMessage(event, envelope.EventID, workspaceID, correlationID, contracts.SlackSourceAppMention)
	case event.Type == "message" && event.ChannelType == "im":
		return buildQueueMessage(event, envelope.EventID, workspaceID, correlationID, contracts.SlackSourceDM)
	case event.Type == "message" && event.ThreadTS != "" && event.ChannelType != "im":
		return buildQueueMessage(event, envelope.EventID, workspaceID, correlationID, contracts.SlackSourceThread)
	default:
		return nil, nil
	}
}

func buildQueueMessage(
	event *slackEvent,
	eventID string,
	workspaceID string,
	correlationID string,
	source contracts.SlackSource,
) (*contracts.SlackQueueMessage, error) {
	normalizedText := strings.TrimSpace(event.Text)
	if source == contracts.SlackSourceAppMention {
		normalizedText = stripBotMention(normalizedText)
	}

	files := toFileReferences(event.Files)
	explicitThreadTS := event.ThreadTS
	contextScope := contracts.ContextScopeChannelTopLevel
	conversationTS := event.EventTS
	replyThreadTS := ""

	if explicitThreadTS != "" {
		contextScope = contracts.ContextScopeThread
		conversationTS = explicitThreadTS
		replyThreadTS = explicitThreadTS
	} else if source == contracts.SlackSourceAppMention && event.EventTS != "" {
		replyThreadTS = event.EventTS
	}

	if normalizedText == "" && len(files) == 0 {
		return nil, nil
	}
	if event.Channel == "" || event.User == "" || event.EventTS == "" {
		return nil, errors.New("slack event is missing required message fields")
	}
	if normalizedText == "" {
		normalizedText = "Please analyze the attached file(s)."
	}

	return &contracts.SlackQueueMessage{
		CorrelationID:  correlationID,
		EventID:        eventID,
		WorkspaceID:    workspaceID,
		ChannelID:      event.Channel,
		ConversationTS: conversationTS,
		ReplyThreadTS:  replyThreadTS,
		MessageTS:      event.EventTS,
		UserID:         event.User,
		Text:           normalizedText,
		Source:         source,
		ContextScope:   contextScope,
		ReceivedAt:     time.Now().UTC().Format(time.RFC3339),
		Files:          files,
	}, nil
}

func stripBotMention(text string) string {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "<@") {
		return text
	}
	end := strings.Index(text, ">")
	if end < 0 {
		return text
	}
	return strings.TrimSpace(text[end+1:])
}

func toFileReferences(files []slackFileReferenceEnvelope) []contracts.SlackFileReference {
	if len(files) == 0 {
		return []contracts.SlackFileReference{}
	}

	result := make([]contracts.SlackFileReference, 0, len(files))
	for _, file := range files {
		if file.ID == "" {
			continue
		}
		result = append(result, contracts.SlackFileReference{
			ID:                 file.ID,
			Name:               file.Name,
			Title:              file.Title,
			Mimetype:           file.Mimetype,
			FileAccess:         file.FileAccess,
			URLPrivate:         file.URLPrivate,
			URLPrivateDownload: file.URLPrivateDownload,
			Permalink:          file.Permalink,
			IsExternal:         file.IsExternal,
			ExternalURL:        file.ExternalURL,
			Size:               file.Size,
		})
	}
	return result
}
