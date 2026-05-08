package integrations

import (
	"context"
	"fmt"
	"net/url"

	"github.com/trknhr/slack-ai-assistant/internal/calendar"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/secrets"
)

type AuthorizationRequiredError struct {
	AuthorizationURL string
}

func (e *AuthorizationRequiredError) Error() string {
	return "Google Calendar authorization is required: " + e.AuthorizationURL
}

func CreateUserGoogleCalendarClient(
	workspaceID string,
	userID string,
	defaultTimeZone string,
	googleCalendarSecretID string,
	googleOAuthStartURL string,
	secretsProvider *secrets.Provider,
	connections *repo.GoogleOAuthConnectionRepository,
) *calendar.GoogleCalendarClient {
	return calendar.NewGoogleCalendarClient(nil, func(ctx context.Context) (*calendar.GoogleCalendarCredentials, error) {
		if userID == "" {
			return nil, fmt.Errorf("google calendar requires a Slack user context")
		}

		rawSecret, err := secretsProvider.GetSecretString(ctx, googleCalendarSecretID)
		if err != nil {
			return nil, err
		}
		config, err := calendar.ParseGoogleOAuthClientConfig(rawSecret)
		if err != nil {
			return nil, err
		}
		connection, err := connections.Get(ctx, workspaceID, userID)
		if err != nil {
			return nil, err
		}
		if connection == nil {
			return nil, &AuthorizationRequiredError{
				AuthorizationURL: buildGoogleOAuthStartURL(googleOAuthStartURL, workspaceID, userID),
			}
		}

		calendarID := connection.CalendarID
		if calendarID == "" {
			calendarID = "primary"
		}
		timeZone := connection.TimeZone
		if timeZone == "" {
			timeZone = defaultTimeZone
		}
		return &calendar.GoogleCalendarCredentials{
			ClientID:     config.ClientID,
			ClientSecret: config.ClientSecret,
			RefreshToken: connection.RefreshToken,
			CalendarID:   calendarID,
			TimeZone:     timeZone,
		}, nil
	}, defaultTimeZone)
}

func buildGoogleOAuthStartURL(startURL string, workspaceID string, userID string) string {
	if startURL == "" {
		return "Google OAuth start URL is not configured."
	}

	parsed, err := url.Parse(startURL)
	if err != nil {
		return "Google OAuth start URL is not configured."
	}
	query := parsed.Query()
	query.Set("workspace_id", workspaceID)
	query.Set("user_id", userID)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
