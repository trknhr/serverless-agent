package slack

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/trknhr/slack-ai-assistant/internal/text"
)

type TokenProvider func(context.Context) (string, error)

type WebClient struct {
	tokenProvider TokenProvider
	httpClient    *http.Client
}

type PostMessageInput struct {
	Channel  string
	Text     string
	ThreadTS string
	Blocks   []map[string]any
}

type UpdateMessageInput struct {
	Channel  string
	TS       string
	Text     string
	ThreadTS string
	Blocks   []map[string]any
}

func NewWebClient(tokenProvider TokenProvider) *WebClient {
	return &WebClient{
		tokenProvider: tokenProvider,
		httpClient:    &http.Client{},
	}
}

func (c *WebClient) PostMessage(ctx context.Context, input PostMessageInput) (string, error) {
	chunks := text.SplitTextForSlack(text.NormalizeTextForSlack(input.Text), 3000)
	var firstTS string
	for index, chunk := range chunks {
		payload := map[string]any{
			"channel":   input.Channel,
			"text":      chunk,
			"thread_ts": zeroToNil(input.ThreadTS),
		}
		if index == 0 && len(input.Blocks) > 0 {
			payload["blocks"] = input.Blocks
		}
		response, err := c.call(ctx, "chat.postMessage", payload)
		if err != nil {
			return "", err
		}
		if firstTS == "" {
			firstTS = response.TS
		}
	}
	return firstTS, nil
}

func (c *WebClient) UpdateMessage(ctx context.Context, input UpdateMessageInput) error {
	chunks := text.SplitTextForSlack(text.NormalizeTextForSlack(input.Text), 3000)
	if len(chunks) == 0 {
		chunks = []string{""}
	}

	_, err := c.call(ctx, "chat.update", map[string]any{
		"channel": input.Channel,
		"ts":      input.TS,
		"text":    chunks[0],
		"blocks":  input.Blocks,
	})
	if err != nil {
		return err
	}

	threadTS := input.ThreadTS
	if threadTS == "" {
		threadTS = input.TS
	}
	for _, chunk := range chunks[1:] {
		if _, err := c.call(ctx, "chat.postMessage", map[string]any{
			"channel":   input.Channel,
			"text":      chunk,
			"thread_ts": threadTS,
		}); err != nil {
			return err
		}
	}
	return nil
}

type slackAPIResponse struct {
	OK    bool   `json:"ok"`
	TS    string `json:"ts,omitempty"`
	Error string `json:"error,omitempty"`
}

func (c *WebClient) call(ctx context.Context, method string, body map[string]any) (*slackAPIResponse, error) {
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
	var payloadResponse slackAPIResponse
	if err := json.NewDecoder(response.Body).Decode(&payloadResponse); err != nil {
		return nil, err
	}
	if !payloadResponse.OK {
		return nil, fmt.Errorf("Slack API %s returned error: %s", method, payloadResponse.Error)
	}
	return &payloadResponse, nil
}

func zeroToNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}
