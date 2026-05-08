package calendar

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var GoogleCalendarScopes = []string{
	"openid",
	"email",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	"https://www.googleapis.com/auth/calendar.events",
}

type OAuthClientConfig struct {
	ClientID     string
	ClientSecret string
}

type OAuthState struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	Nonce       string `json:"nonce"`
	ExpiresAt   int64  `json:"expiresAt"`
}

type OAuthTokenResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int    `json:"expires_in,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	Scope        string `json:"scope,omitempty"`
	TokenType    string `json:"token_type,omitempty"`
	IDToken      string `json:"id_token,omitempty"`
}

type GoogleUserInfo struct {
	Subject string `json:"sub,omitempty"`
	Email   string `json:"email,omitempty"`
}

type googleOAuthConfigEnvelope struct {
	ClientIDSnake     string `json:"client_id,omitempty"`
	ClientIDCamel     string `json:"clientId,omitempty"`
	ClientSecretSnake string `json:"client_secret,omitempty"`
	ClientSecretCamel string `json:"clientSecret,omitempty"`
}

func ParseGoogleOAuthClientConfig(raw string) (OAuthClientConfig, error) {
	var parsed googleOAuthConfigEnvelope
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return OAuthClientConfig{}, err
	}

	clientID := parsed.ClientIDSnake
	if clientID == "" {
		clientID = parsed.ClientIDCamel
	}
	clientSecret := parsed.ClientSecretSnake
	if clientSecret == "" {
		clientSecret = parsed.ClientSecretCamel
	}
	if clientID == "" {
		return OAuthClientConfig{}, errors.New("google OAuth secret is missing client_id")
	}
	if clientSecret == "" {
		return OAuthClientConfig{}, errors.New("google OAuth secret is missing client_secret")
	}

	return OAuthClientConfig{
		ClientID:     clientID,
		ClientSecret: clientSecret,
	}, nil
}

func BuildGoogleAuthorizationURL(config OAuthClientConfig, redirectURI string, state string) string {
	params := url.Values{}
	params.Set("client_id", config.ClientID)
	params.Set("redirect_uri", redirectURI)
	params.Set("response_type", "code")
	params.Set("scope", strings.Join(GoogleCalendarScopes, " "))
	params.Set("access_type", "offline")
	params.Set("prompt", "consent select_account")
	params.Set("state", state)
	return "https://accounts.google.com/o/oauth2/v2/auth?" + params.Encode()
}

func ExchangeGoogleAuthorizationCode(client *http.Client, config OAuthClientConfig, redirectURI string, code string) (*OAuthTokenResponse, error) {
	form := url.Values{}
	form.Set("client_id", config.ClientID)
	form.Set("client_secret", config.ClientSecret)
	form.Set("code", code)
	form.Set("grant_type", "authorization_code")
	form.Set("redirect_uri", redirectURI)

	request, err := http.NewRequest(http.MethodPost, "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")

	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("google OAuth token exchange failed: %d %s", response.StatusCode, response.Status)
	}

	var payload OAuthTokenResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

func FetchGoogleUserInfo(client *http.Client, accessToken string) (*GoogleUserInfo, error) {
	request, err := http.NewRequest(http.MethodGet, "https://openidconnect.googleapis.com/v1/userinfo", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("authorization", "Bearer "+accessToken)

	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("google userinfo request failed: %d %s", response.StatusCode, response.Status)
	}

	var payload GoogleUserInfo
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

func CreateGoogleOAuthState(workspaceID string, userID string, signingSecret string) (string, error) {
	randomBytes := make([]byte, 16)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}

	state := OAuthState{
		WorkspaceID: workspaceID,
		UserID:      userID,
		Nonce:       hex.EncodeToString(randomBytes),
		ExpiresAt:   time.Now().Add(10 * time.Minute).UnixMilli(),
	}

	payloadBytes, err := json.Marshal(state)
	if err != nil {
		return "", err
	}

	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	signature := sign(payload, signingSecret)
	return payload + "." + signature, nil
}

func VerifyGoogleOAuthState(stateToken string, signingSecret string) (*OAuthState, error) {
	parts := strings.Split(stateToken, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, errors.New("invalid OAuth state")
	}

	expected := sign(parts[0], signingSecret)
	if !hmac.Equal([]byte(parts[1]), []byte(expected)) {
		return nil, errors.New("invalid OAuth state signature")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}

	var state OAuthState
	if err := json.Unmarshal(payloadBytes, &state); err != nil {
		return nil, err
	}
	if state.ExpiresAt < time.Now().UnixMilli() {
		return nil, errors.New("OAuth state expired")
	}

	return &state, nil
}

func SplitScope(scope string) []string {
	if strings.TrimSpace(scope) == "" {
		return []string{}
	}
	return strings.Fields(scope)
}

func sign(payload string, signingSecret string) string {
	mac := hmac.New(sha256.New, []byte(signingSecret))
	io.WriteString(mac, payload)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
