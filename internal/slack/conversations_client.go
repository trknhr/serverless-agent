package slack

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/trknhr/slack-ai-assistant/internal/contracts"
)

type ThreadMessage struct {
	TS       string
	ThreadTS string
	Text     string
	UserID   string
	BotID    string
	Subtype  string
	Files    []contracts.SlackFileReference
}

type ConversationsClient struct {
	tokenProvider TokenProvider
	httpClient    *http.Client
}

func NewConversationsClient(tokenProvider TokenProvider) *ConversationsClient {
	return &ConversationsClient{
		tokenProvider: tokenProvider,
		httpClient:    &http.Client{},
	}
}

func (c *ConversationsClient) ListReplies(ctx context.Context, channel string, threadTS string) ([]ThreadMessage, error) {
	messages := make([]ThreadMessage, 0)
	cursor := ""
	for {
		body := map[string]any{
			"channel": channel,
			"ts":      threadTS,
			"limit":   200,
		}
		addStringIfPresent(body, "cursor", cursor)
		payload, err := c.call(ctx, "conversations.replies", body)
		if err != nil {
			return nil, err
		}
		for _, message := range payload.Messages {
			if parsed := toThreadMessage(message); parsed != nil {
				messages = append(messages, *parsed)
			}
		}
		if payload.ResponseMetadata.NextCursor == "" {
			break
		}
		cursor = payload.ResponseMetadata.NextCursor
	}
	sort.Slice(messages, func(i int, j int) bool {
		return messages[i].TS < messages[j].TS
	})
	return messages, nil
}

type slackRepliesResponse struct {
	OK               bool   `json:"ok"`
	Error            string `json:"error,omitempty"`
	ResponseMetadata struct {
		NextCursor string `json:"next_cursor,omitempty"`
	} `json:"response_metadata,omitempty"`
	Messages []map[string]any `json:"messages,omitempty"`
}

func (c *ConversationsClient) call(ctx context.Context, method string, body map[string]any) (*slackRepliesResponse, error) {
	token, err := c.tokenProvider(ctx)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://slack.com/api/"+method, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("authorization", "Bearer "+token)
	request.Header.Set("content-type", "application/json; charset=utf-8")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("Slack API %s failed with status %d", method, response.StatusCode)
	}
	var payloadResponse slackRepliesResponse
	if err := json.NewDecoder(response.Body).Decode(&payloadResponse); err != nil {
		return nil, err
	}
	if !payloadResponse.OK {
		return nil, fmt.Errorf("Slack API %s returned error: %s", method, payloadResponse.Error)
	}
	return &payloadResponse, nil
}

func toThreadMessage(message map[string]any) *ThreadMessage {
	ts, _ := message["ts"].(string)
	if ts == "" {
		return nil
	}
	text, _ := message["text"].(string)
	files := extractSlackFiles(message["files"])
	if strings.TrimSpace(text) == "" && len(files) == 0 {
		return nil
	}
	threadTS, _ := message["thread_ts"].(string)
	userID, _ := message["user"].(string)
	botID, _ := message["bot_id"].(string)
	subtype, _ := message["subtype"].(string)
	return &ThreadMessage{
		TS:       ts,
		ThreadTS: threadTS,
		Text:     text,
		UserID:   userID,
		BotID:    botID,
		Subtype:  subtype,
		Files:    files,
	}
}
