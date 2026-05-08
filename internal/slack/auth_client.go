package slack

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type AuthTestResponse struct {
	OK     bool   `json:"ok"`
	URL    string `json:"url,omitempty"`
	Team   string `json:"team,omitempty"`
	TeamID string `json:"team_id,omitempty"`
	User   string `json:"user,omitempty"`
	UserID string `json:"user_id,omitempty"`
	BotID  string `json:"bot_id,omitempty"`
	Error  string `json:"error,omitempty"`
}

type AuthClient struct {
	tokenProvider TokenProvider
	httpClient    *http.Client
}

func NewAuthClient(tokenProvider TokenProvider) *AuthClient {
	return &AuthClient{
		tokenProvider: tokenProvider,
		httpClient:    &http.Client{},
	}
}

func (c *AuthClient) AuthTest(ctx context.Context) (*AuthTestResponse, error) {
	token, err := c.tokenProvider(ctx)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://slack.com/api/auth.test", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("authorization", "Bearer "+token)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("Slack auth.test failed with status %d", response.StatusCode)
	}
	var payload AuthTestResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	if !payload.OK {
		return nil, fmt.Errorf("Slack auth.test returned error: %s", payload.Error)
	}
	return &payload, nil
}
