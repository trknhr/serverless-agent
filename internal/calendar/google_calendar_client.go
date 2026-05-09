package calendar

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type GoogleCalendarEventTime struct {
	Date     string `json:"date,omitempty"`
	DateTime string `json:"dateTime,omitempty"`
	TimeZone string `json:"timeZone,omitempty"`
}

type GoogleCalendarEventRecord struct {
	ID                 string                   `json:"id"`
	Status             string                   `json:"status,omitempty"`
	Summary            string                   `json:"summary,omitempty"`
	Description        string                   `json:"description,omitempty"`
	Location           string                   `json:"location,omitempty"`
	HTMLLink           string                   `json:"htmlLink,omitempty"`
	Updated            string                   `json:"updated,omitempty"`
	Start              *GoogleCalendarEventTime `json:"start,omitempty"`
	End                *GoogleCalendarEventTime `json:"end,omitempty"`
	ExtendedProperties struct {
		Private map[string]string `json:"private,omitempty"`
	} `json:"extendedProperties,omitempty"`
}

type GoogleCalendarListEntry struct {
	ID              string `json:"id"`
	Summary         string `json:"summary,omitempty"`
	SummaryOverride string `json:"summaryOverride,omitempty"`
	Description     string `json:"description,omitempty"`
	TimeZone        string `json:"timeZone,omitempty"`
	AccessRole      string `json:"accessRole,omitempty"`
	Primary         bool   `json:"primary,omitempty"`
	Selected        bool   `json:"selected,omitempty"`
	Hidden          bool   `json:"hidden,omitempty"`
	BackgroundColor string `json:"backgroundColor,omitempty"`
	ForegroundColor string `json:"foregroundColor,omitempty"`
}

type GoogleCalendarCredentials struct {
	ClientID     string
	ClientSecret string
	RefreshToken string
	CalendarID   string
	TimeZone     string
}

type GoogleCalendarClient struct {
	secretProvider      func(context.Context) (string, error)
	credentialsProvider func(context.Context) (*GoogleCalendarCredentials, error)
	defaultTimeZone     string
	httpClient          *http.Client

	credentialsOnce sync.Once
	credentials     *GoogleCalendarCredentials
	credentialsErr  error

	tokenMu            sync.Mutex
	cachedAccessToken  string
	cachedAccessExpiry time.Time
}

func NewGoogleCalendarClient(secretProvider func(context.Context) (string, error), credentialsProvider func(context.Context) (*GoogleCalendarCredentials, error), defaultTimeZone string) *GoogleCalendarClient {
	return &GoogleCalendarClient{
		secretProvider:      secretProvider,
		credentialsProvider: credentialsProvider,
		defaultTimeZone:     defaultTimeZone,
		httpClient:          &http.Client{},
	}
}

type googleCalendarSecretEnvelope struct {
	ClientIDSnake     string `json:"client_id,omitempty"`
	ClientIDCamel     string `json:"clientId,omitempty"`
	ClientSecretSnake string `json:"client_secret,omitempty"`
	ClientSecretCamel string `json:"clientSecret,omitempty"`
	RefreshTokenSnake string `json:"refresh_token,omitempty"`
	RefreshTokenCamel string `json:"refreshToken,omitempty"`
	CalendarIDSnake   string `json:"calendar_id,omitempty"`
	CalendarIDCamel   string `json:"calendarId,omitempty"`
	TimeZoneSnake     string `json:"time_zone,omitempty"`
	TimeZoneCamel     string `json:"timeZone,omitempty"`
}

func (c *GoogleCalendarClient) ListEvents(ctx context.Context, calendarID string, timeMin string, timeMax string, queryText string, maxResults int, timeZone string, privateProperties map[string]string) (string, string, []GoogleCalendarEventRecord, error) {
	credentials, err := c.getCredentials(ctx)
	if err != nil {
		return "", "", nil, err
	}
	if calendarID == "" {
		calendarID = credentials.CalendarID
	}
	if timeZone == "" {
		timeZone = credentials.TimeZone
	}
	if maxResults <= 0 {
		maxResults = 10
	}
	if maxResults > 50 {
		maxResults = 50
	}

	query := url.Values{}
	query.Set("singleEvents", "true")
	query.Set("showDeleted", "false")
	query.Set("orderBy", "startTime")
	query.Set("maxResults", fmt.Sprintf("%d", maxResults))
	query.Set("timeZone", timeZone)
	if timeMin != "" {
		query.Set("timeMin", timeMin)
	}
	if timeMax != "" {
		query.Set("timeMax", timeMax)
	}
	if queryText != "" {
		query.Set("q", queryText)
	}
	for key, value := range privateProperties {
		query.Add("privateExtendedProperty", key+"="+value)
	}

	var response struct {
		Items []GoogleCalendarEventRecord `json:"items"`
	}
	if err := c.requestJSON(ctx, http.MethodGet, "/calendar/v3/calendars/"+url.PathEscape(calendarID)+"/events?"+query.Encode(), nil, &response); err != nil {
		return "", "", nil, err
	}
	return calendarID, timeZone, response.Items, nil
}

func (c *GoogleCalendarClient) ListCalendars(ctx context.Context, minAccessRole string, maxResults int) ([]GoogleCalendarListEntry, error) {
	if maxResults <= 0 {
		maxResults = 100
	}
	if maxResults > 250 {
		maxResults = 250
	}
	baseQuery := url.Values{}
	baseQuery.Set("showDeleted", "false")
	baseQuery.Set("maxResults", fmt.Sprintf("%d", maxResults))
	if minAccessRole != "" {
		baseQuery.Set("minAccessRole", minAccessRole)
	}

	results := make([]GoogleCalendarListEntry, 0)
	var pageToken string
	for {
		pageQuery := url.Values{}
		for key, values := range baseQuery {
			for _, value := range values {
				pageQuery.Add(key, value)
			}
		}
		if pageToken != "" {
			pageQuery.Set("pageToken", pageToken)
		}
		var response struct {
			Items         []GoogleCalendarListEntry `json:"items"`
			NextPageToken string                    `json:"nextPageToken,omitempty"`
		}
		if err := c.requestJSON(ctx, http.MethodGet, "/calendar/v3/users/me/calendarList?"+pageQuery.Encode(), nil, &response); err != nil {
			return nil, err
		}
		results = append(results, response.Items...)
		if response.NextPageToken == "" {
			break
		}
		pageToken = response.NextPageToken
	}
	return results, nil
}

func (c *GoogleCalendarClient) FindEventByPrivateProperties(ctx context.Context, calendarID string, privateProperties map[string]string) (*GoogleCalendarEventRecord, error) {
	_, _, events, err := c.ListEvents(ctx, calendarID, "", "", "", 10, "", privateProperties)
	if err != nil {
		return nil, err
	}
	for _, event := range events {
		if event.Status != "cancelled" {
			return &event, nil
		}
	}
	return nil, nil
}

func (c *GoogleCalendarClient) CreateEvent(ctx context.Context, calendarID string, body map[string]any) (*GoogleCalendarEventRecord, error) {
	credentials, err := c.getCredentials(ctx)
	if err != nil {
		return nil, err
	}
	if calendarID == "" {
		calendarID = credentials.CalendarID
	}
	var response GoogleCalendarEventRecord
	if err := c.requestJSON(ctx, http.MethodPost, "/calendar/v3/calendars/"+url.PathEscape(calendarID)+"/events", body, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func (c *GoogleCalendarClient) PatchEvent(ctx context.Context, calendarID string, eventID string, body map[string]any) (*GoogleCalendarEventRecord, error) {
	credentials, err := c.getCredentials(ctx)
	if err != nil {
		return nil, err
	}
	if calendarID == "" {
		calendarID = credentials.CalendarID
	}
	var response GoogleCalendarEventRecord
	if err := c.requestJSON(ctx, http.MethodPatch, "/calendar/v3/calendars/"+url.PathEscape(calendarID)+"/events/"+url.PathEscape(eventID), body, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

func (c *GoogleCalendarClient) QueryFreeBusy(ctx context.Context, calendarIDs []string, timeMin string, timeMax string, timeZone string) (string, string, string, map[string]map[string]any, error) {
	credentials, err := c.getCredentials(ctx)
	if err != nil {
		return "", "", "", nil, err
	}
	if len(calendarIDs) == 0 {
		calendarIDs = []string{credentials.CalendarID}
	}
	if timeZone == "" {
		timeZone = credentials.TimeZone
	}

	items := make([]map[string]string, 0, len(calendarIDs))
	for _, id := range calendarIDs {
		items = append(items, map[string]string{"id": id})
	}
	var response struct {
		TimeMin   string                    `json:"timeMin"`
		TimeMax   string                    `json:"timeMax"`
		Calendars map[string]map[string]any `json:"calendars"`
	}
	if err := c.requestJSON(ctx, http.MethodPost, "/calendar/v3/freeBusy", map[string]any{
		"timeMin":  timeMin,
		"timeMax":  timeMax,
		"timeZone": timeZone,
		"items":    items,
	}, &response); err != nil {
		return "", "", "", nil, err
	}
	return response.TimeMin, response.TimeMax, timeZone, response.Calendars, nil
}

func (c *GoogleCalendarClient) getCredentials(ctx context.Context) (*GoogleCalendarCredentials, error) {
	c.credentialsOnce.Do(func() {
		c.credentials, c.credentialsErr = c.loadCredentials(ctx)
	})
	return c.credentials, c.credentialsErr
}

func (c *GoogleCalendarClient) loadCredentials(ctx context.Context) (*GoogleCalendarCredentials, error) {
	if c.credentialsProvider != nil {
		return c.credentialsProvider(ctx)
	}
	if c.secretProvider == nil {
		return nil, fmt.Errorf("google calendar credentials are not configured")
	}

	raw, err := c.secretProvider(ctx)
	if err != nil {
		return nil, err
	}
	var envelope googleCalendarSecretEnvelope
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		return nil, err
	}

	clientID := firstNonEmpty(envelope.ClientIDSnake, envelope.ClientIDCamel)
	clientSecret := firstNonEmpty(envelope.ClientSecretSnake, envelope.ClientSecretCamel)
	refreshToken := firstNonEmpty(envelope.RefreshTokenSnake, envelope.RefreshTokenCamel)
	if clientID == "" {
		return nil, fmt.Errorf("google calendar secret is missing client_id")
	}
	if clientSecret == "" {
		return nil, fmt.Errorf("google calendar secret is missing client_secret")
	}
	if refreshToken == "" {
		return nil, fmt.Errorf("google calendar secret is missing refresh_token")
	}

	return &GoogleCalendarCredentials{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RefreshToken: refreshToken,
		CalendarID:   firstNonEmpty(envelope.CalendarIDSnake, envelope.CalendarIDCamel, "primary"),
		TimeZone:     firstNonEmpty(envelope.TimeZoneSnake, envelope.TimeZoneCamel, c.defaultTimeZone),
	}, nil
}

func (c *GoogleCalendarClient) getAccessToken(ctx context.Context) (string, error) {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()

	if c.cachedAccessToken != "" && c.cachedAccessExpiry.After(time.Now().Add(60*time.Second)) {
		return c.cachedAccessToken, nil
	}

	credentials, err := c.getCredentials(ctx)
	if err != nil {
		return "", err
	}
	form := url.Values{}
	form.Set("client_id", credentials.ClientID)
	form.Set("client_secret", credentials.ClientSecret)
	form.Set("refresh_token", credentials.RefreshToken)
	form.Set("grant_type", "refresh_token")

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/token", bytes.NewBufferString(form.Encode()))
	if err != nil {
		return "", err
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", buildGoogleAPIErrorMessage(response.StatusCode, response.Status, payload, "Failed to refresh Google OAuth token")
	}

	var token struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in,omitempty"`
	}
	if err := json.Unmarshal(payload, &token); err != nil {
		return "", err
	}
	lifetime := token.ExpiresIn - 60
	if lifetime < 60 {
		lifetime = 60
	}
	c.cachedAccessToken = token.AccessToken
	c.cachedAccessExpiry = time.Now().Add(time.Duration(lifetime) * time.Second)
	return c.cachedAccessToken, nil
}

func (c *GoogleCalendarClient) requestJSON(ctx context.Context, method string, path string, body any, out any) error {
	accessToken, err := c.getAccessToken(ctx)
	if err != nil {
		return err
	}
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(raw)
	}

	request, err := http.NewRequestWithContext(ctx, method, "https://www.googleapis.com"+path, payload)
	if err != nil {
		return err
	}
	request.Header.Set("authorization", "Bearer "+accessToken)
	if body != nil {
		request.Header.Set("content-type", "application/json; charset=utf-8")
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return buildGoogleAPIErrorMessage(response.StatusCode, response.Status, raw, "Google Calendar API request failed")
	}
	if response.StatusCode == http.StatusNoContent || out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func buildGoogleAPIErrorMessage(statusCode int, statusText string, payload []byte, fallback string) error {
	if len(payload) == 0 {
		return fmt.Errorf("%s: %d %s", fallback, statusCode, statusText)
	}
	var parsed struct {
		Error struct {
			Message string `json:"message,omitempty"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(payload, &parsed); err == nil && parsed.Error.Message != "" {
		return fmt.Errorf("%s: %s", fallback, parsed.Error.Message)
	}
	return fmt.Errorf("%s: %d %s", fallback, statusCode, statusText)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
