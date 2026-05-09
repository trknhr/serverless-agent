package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type APIKeyProvider func(context.Context) (string, error)

type Client struct {
	apiKeyProvider   APIKeyProvider
	beta             string
	apiBaseURL       string
	anthropicVersion string
	httpClient       *http.Client
}

type ContentBlock map[string]any

type InputBlock map[string]any

type SessionEvent struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	Name        string         `json:"name,omitempty"`
	Input       map[string]any `json:"input,omitempty"`
	ProcessedAt string         `json:"processed_at,omitempty"`
	Content     []ContentBlock `json:"content,omitempty"`
	StopReason  struct {
		Type     string   `json:"type,omitempty"`
		EventIDs []string `json:"event_ids,omitempty"`
	} `json:"stop_reason,omitempty"`
	Error struct {
		Type    string `json:"type,omitempty"`
		Message string `json:"message,omitempty"`
	} `json:"error,omitempty"`
}

type CreateMemoryStoreInput struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type CreateMemoryStoreResponse struct {
	ID string `json:"id"`
}

type APIError struct {
	Message string
	Status  int
	Payload string
}

func (e *APIError) Error() string {
	return e.Message
}

func NewClient(apiKeyProvider APIKeyProvider, beta string) *Client {
	return &Client{
		apiKeyProvider:   apiKeyProvider,
		beta:             beta,
		apiBaseURL:       "https://api.anthropic.com",
		anthropicVersion: "2023-06-01",
		httpClient:       &http.Client{},
	}
}

func (c *Client) CreateMemoryStore(ctx context.Context, input CreateMemoryStoreInput) (*CreateMemoryStoreResponse, error) {
	var response CreateMemoryStoreResponse
	if err := c.Request(ctx, http.MethodPost, "/v1/memory_stores", input, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func (c *Client) ListSessionEvents(ctx context.Context, sessionID string, order string, limit int) ([]SessionEvent, error) {
	query := url.Values{}
	if order != "" {
		query.Set("order", order)
	}
	if limit > 0 {
		query.Set("limit", fmt.Sprintf("%d", limit))
	}
	path := "/v1/sessions/" + sessionID + "/events"
	if len(query) > 0 {
		path += "?" + query.Encode()
	}

	var response struct {
		Data []SessionEvent `json:"data"`
	}
	if err := c.Request(ctx, http.MethodGet, path, nil, &response); err != nil {
		return nil, err
	}
	return response.Data, nil
}

func (c *Client) Request(ctx context.Context, method string, path string, requestBody any, responseBody any) error {
	apiKey, err := c.apiKeyProvider(ctx)
	if err != nil {
		return err
	}

	var body io.Reader
	if requestBody != nil {
		payload, err := json.Marshal(requestBody)
		if err != nil {
			return err
		}
		body = bytes.NewReader(payload)
	}

	request, err := http.NewRequestWithContext(ctx, method, c.apiBaseURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("x-api-key", apiKey)
	request.Header.Set("anthropic-version", c.anthropicVersion)
	request.Header.Set("anthropic-beta", c.beta)
	request.Header.Set("content-type", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &APIError{
			Message: fmt.Sprintf("anthropic request failed with status %d", response.StatusCode),
			Status:  response.StatusCode,
			Payload: string(payload),
		}
	}

	if responseBody == nil || len(payload) == 0 {
		return nil
	}
	return json.Unmarshal(payload, responseBody)
}

type SessionMemoryResource struct {
	MemoryStoreID string
	Access        string
	Prompt        string
}

type CreateSessionInput struct {
	AgentID         string
	EnvironmentID   string
	VaultIDs        []string
	Title           string
	Metadata        map[string]string
	MemoryResources []SessionMemoryResource
}

type CreateSessionResult struct {
	ID     string `json:"id"`
	Status string `json:"status,omitempty"`
}

func CreateSession(ctx context.Context, client *Client, input CreateSessionInput) (*CreateSessionResult, error) {
	resources := make([]map[string]any, 0, len(input.MemoryResources))
	for _, resource := range input.MemoryResources {
		access := resource.Access
		if access == "" {
			access = "read_write"
		}
		resources = append(resources, map[string]any{
			"type":            "memory_store",
			"memory_store_id": resource.MemoryStoreID,
			"access":          access,
			"prompt":          resource.Prompt,
		})
	}

	request := map[string]any{
		"agent":          input.AgentID,
		"environment_id": input.EnvironmentID,
		"vault_ids":      input.VaultIDs,
		"title":          input.Title,
		"metadata":       input.Metadata,
		"resources":      resources,
	}
	var response CreateSessionResult
	if err := client.Request(ctx, http.MethodPost, "/v1/sessions", request, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

type UserEvent map[string]any

func SendSessionEvents(ctx context.Context, client *Client, sessionID string, events []UserEvent) error {
	return client.Request(ctx, http.MethodPost, "/v1/sessions/"+sessionID+"/events", map[string]any{
		"events": events,
	}, nil)
}

func SendUserMessage(ctx context.Context, client *Client, sessionID string, content []InputBlock) error {
	return SendSessionEvents(ctx, client, sessionID, []UserEvent{
		{
			"type":    "user.message",
			"content": content,
		},
	})
}

type ToolExecutionResult struct {
	Content []InputBlock
	IsError bool
}

type WaitForCompletionInput struct {
	SessionID       string
	SinceEventIDs   map[string]struct{}
	TimeoutMS       int
	PollIntervalMS  int
	OnCustomToolUse func(context.Context, SessionEvent) (*ToolExecutionResult, error)
}

type WaitForCompletionResult struct {
	Text   string
	Events []SessionEvent
	Status string
}

func WaitForCompletion(ctx context.Context, client *Client, input WaitForCompletionInput) (*WaitForCompletionResult, error) {
	seen := map[string]struct{}{}
	for id := range input.SinceEventIDs {
		seen[id] = struct{}{}
	}
	timeoutMS := input.TimeoutMS
	if timeoutMS == 0 {
		timeoutMS = 120000
	}
	pollIntervalMS := input.PollIntervalMS
	if pollIntervalMS == 0 {
		pollIntervalMS = 2000
	}

	deadline := time.Now().Add(time.Duration(timeoutMS) * time.Millisecond)
	collected := make([]SessionEvent, 0)
	handledToolUseIDs := map[string]struct{}{}

	for time.Now().Before(deadline) {
		events, err := client.ListSessionEvents(ctx, input.SessionID, "asc", 0)
		if err != nil {
			return nil, err
		}

		fresh := make([]SessionEvent, 0)
		for _, event := range events {
			if _, ok := seen[event.ID]; ok {
				continue
			}
			seen[event.ID] = struct{}{}
			collected = append(collected, event)
			fresh = append(fresh, event)
		}

		for i := len(fresh) - 1; i >= 0; i-- {
			if fresh[i].Type == "session.error" {
				message := fresh[i].Error.Message
				if message == "" {
					message = "Claude session failed"
				}
				return nil, fmt.Errorf("%s", message)
			}
		}

		var terminalEvent *SessionEvent
		for i := len(fresh) - 1; i >= 0; i-- {
			if fresh[i].Type == "session.status_idle" || fresh[i].Type == "session.status_terminated" {
				terminalEvent = &fresh[i]
				break
			}
		}

		if terminalEvent != nil {
			if terminalEvent.Type == "session.status_idle" && terminalEvent.StopReason.Type == "requires_action" {
				if input.OnCustomToolUse == nil {
					return nil, fmt.Errorf("Claude session requires custom tool input, but no custom tool executor was provided")
				}
				for _, eventID := range terminalEvent.StopReason.EventIDs {
					for _, event := range events {
						if event.ID != eventID {
							continue
						}
						if event.Type != "agent.custom_tool_use" {
							return nil, fmt.Errorf("unsupported requires_action event type: %s", event.Type)
						}
						if _, ok := handledToolUseIDs[event.ID]; ok {
							continue
						}
						result, err := input.OnCustomToolUse(ctx, event)
						if err != nil {
							return nil, err
						}
						if result == nil {
							result = &ToolExecutionResult{}
						}
						content := make([]map[string]any, 0, len(result.Content))
						for _, block := range result.Content {
							content = append(content, block)
						}
						err = SendSessionEvents(ctx, client, input.SessionID, []UserEvent{
							{
								"type":               "user.custom_tool_result",
								"custom_tool_use_id": event.ID,
								"content":            content,
								"is_error":           result.IsError,
							},
						})
						if err != nil {
							return nil, err
						}
						handledToolUseIDs[event.ID] = struct{}{}
					}
				}
				time.Sleep(250 * time.Millisecond)
				continue
			}

			textParts := make([]string, 0)
			for _, event := range collected {
				if event.Type != "agent.message" {
					continue
				}
				for _, block := range event.Content {
					if block["type"] == "text" {
						if text, ok := block["text"].(string); ok {
							textParts = append(textParts, text)
						}
					}
				}
			}
			text := strings.TrimSpace(strings.Join(textParts, "\n\n"))
			if text == "" {
				text = "(No text response returned)"
			}
			status := "terminated"
			if terminalEvent.Type == "session.status_idle" {
				status = "idle"
			}
			return &WaitForCompletionResult{
				Text:   text,
				Events: collected,
				Status: status,
			}, nil
		}

		time.Sleep(time.Duration(pollIntervalMS) * time.Millisecond)
	}

	return nil, fmt.Errorf("timed out waiting for Claude session %s", input.SessionID)
}
