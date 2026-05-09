package calendar

import (
	"context"
	"strings"
	"testing"
)

func TestLoadCredentialsFromSnakeCaseSecret(t *testing.T) {
	client := NewGoogleCalendarClient(func(context.Context) (string, error) {
		return `{
			"client_id":"client",
			"client_secret":"secret",
			"refresh_token":"refresh",
			"calendar_id":"team@example.com",
			"time_zone":"America/New_York"
		}`, nil
	}, nil, "Asia/Tokyo")

	credentials, err := client.loadCredentials(context.Background())
	if err != nil {
		t.Fatalf("loadCredentials returned error: %v", err)
	}
	if credentials.ClientID != "client" || credentials.ClientSecret != "secret" || credentials.RefreshToken != "refresh" {
		t.Fatalf("unexpected credentials: %#v", credentials)
	}
	if credentials.CalendarID != "team@example.com" || credentials.TimeZone != "America/New_York" {
		t.Fatalf("unexpected calendar defaults: %#v", credentials)
	}
}

func TestLoadCredentialsFromCamelCaseSecretUsesDefaults(t *testing.T) {
	client := NewGoogleCalendarClient(func(context.Context) (string, error) {
		return `{
			"clientId":"client",
			"clientSecret":"secret",
			"refreshToken":"refresh"
		}`, nil
	}, nil, "Asia/Tokyo")

	credentials, err := client.loadCredentials(context.Background())
	if err != nil {
		t.Fatalf("loadCredentials returned error: %v", err)
	}
	if credentials.CalendarID != "primary" || credentials.TimeZone != "Asia/Tokyo" {
		t.Fatalf("unexpected defaults: %#v", credentials)
	}
}

func TestLoadCredentialsValidatesRequiredFields(t *testing.T) {
	tests := []struct {
		name    string
		secret  string
		wantErr string
	}{
		{name: "client id", secret: `{"client_secret":"secret","refresh_token":"refresh"}`, wantErr: "client_id"},
		{name: "client secret", secret: `{"client_id":"client","refresh_token":"refresh"}`, wantErr: "client_secret"},
		{name: "refresh token", secret: `{"client_id":"client","client_secret":"secret"}`, wantErr: "refresh_token"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := NewGoogleCalendarClient(func(context.Context) (string, error) {
				return tt.secret, nil
			}, nil, "Asia/Tokyo")

			_, err := client.loadCredentials(context.Background())
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestBuildGoogleAPIErrorMessage(t *testing.T) {
	err := buildGoogleAPIErrorMessage(400, "400 Bad Request", []byte(`{"error":{"message":"invalid calendar"}}`), "fallback")
	if err == nil || err.Error() != "fallback: invalid calendar" {
		t.Fatalf("unexpected parsed error: %v", err)
	}

	err = buildGoogleAPIErrorMessage(500, "500 Internal Server Error", nil, "fallback")
	if err == nil || err.Error() != "fallback: 500 500 Internal Server Error" {
		t.Fatalf("unexpected empty payload error: %v", err)
	}

	err = buildGoogleAPIErrorMessage(502, "502 Bad Gateway", []byte(`not-json`), "fallback")
	if err == nil || err.Error() != "fallback: 502 502 Bad Gateway" {
		t.Fatalf("unexpected invalid payload error: %v", err)
	}
}

func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("", "first", "second"); got != "first" {
		t.Fatalf("firstNonEmpty() = %q", got)
	}
	if got := firstNonEmpty("", ""); got != "" {
		t.Fatalf("firstNonEmpty empty = %q", got)
	}
}
