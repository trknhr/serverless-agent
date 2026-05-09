package main

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"

	"github.com/trknhr/slack-ai-assistant/internal/calendar"
	"github.com/trknhr/slack-ai-assistant/internal/config"
	"github.com/trknhr/slack-ai-assistant/internal/lambdahttp"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/secrets"
)

var (
	oauthEnv             = config.MustLoadGoogleOAuthEnv()
	oauthLogger          = logger.Default()
	oauthAWSConfig, _    = awsconfig.LoadDefaultConfig(context.Background())
	oauthSecretsProvider = secrets.New(secretsmanager.NewFromConfig(oauthAWSConfig))
	oauthConnections     = repo.NewGoogleOAuthConnectionRepository(dynamodb.NewFromConfig(oauthAWSConfig), oauthEnv.GoogleOAuthConnectionsTable)
	oauthHTTPClient      = &http.Client{}
)

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	log := oauthLogger.Child(logger.Fields{
		"requestId": event.RequestContext.RequestID,
		"component": "google-oauth",
	})

	switch {
	case event.HTTPMethod == http.MethodGet && event.Resource == "/oauth/google/start":
		return startOAuth(ctx, event, log), nil
	case event.HTTPMethod == http.MethodGet && event.Resource == "/oauth/google/callback":
		return callbackOAuth(ctx, event, log), nil
	default:
		return lambdahttp.Text(http.StatusNotFound, "Not found"), nil
	}
}

func startOAuth(ctx context.Context, event events.APIGatewayProxyRequest, log *logger.Logger) events.APIGatewayProxyResponse {
	workspaceID := strings.TrimSpace(event.QueryStringParameters["workspace_id"])
	userID := strings.TrimSpace(event.QueryStringParameters["user_id"])
	if workspaceID == "" || userID == "" {
		return lambdahttp.Text(http.StatusBadRequest, "Missing workspace_id or user_id")
	}

	rawSecret, err := oauthSecretsProvider.GetSecretString(ctx, oauthEnv.GoogleCalendarSecretID)
	if err != nil {
		log.Error("Google OAuth secret lookup failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", "Google OAuth secret lookup failed.")
	}

	oauthConfig, err := calendar.ParseGoogleOAuthClientConfig(rawSecret)
	if err != nil {
		log.Error("Google OAuth secret parse failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", err.Error())
	}

	signingSecret, err := oauthSecretsProvider.GetSecretString(ctx, oauthEnv.SlackSigningSecretSecretID)
	if err != nil {
		log.Error("Slack signing secret lookup failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", "Slack signing secret lookup failed.")
	}

	state, err := calendar.CreateGoogleOAuthState(workspaceID, userID, signingSecret)
	if err != nil {
		log.Error("Google OAuth state creation failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", err.Error())
	}

	location := calendar.BuildGoogleAuthorizationURL(oauthConfig, buildRedirectURI(event), state)
	return lambdahttp.Redirect(location)
}

func callbackOAuth(ctx context.Context, event events.APIGatewayProxyRequest, log *logger.Logger) events.APIGatewayProxyResponse {
	code := strings.TrimSpace(event.QueryStringParameters["code"])
	stateToken := strings.TrimSpace(event.QueryStringParameters["state"])
	if code == "" || stateToken == "" {
		return lambdahttp.Text(http.StatusBadRequest, "Missing code or state")
	}

	rawSecret, err := oauthSecretsProvider.GetSecretString(ctx, oauthEnv.GoogleCalendarSecretID)
	if err != nil {
		log.Error("Google OAuth secret lookup failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", "Google OAuth secret lookup failed.")
	}

	oauthConfig, err := calendar.ParseGoogleOAuthClientConfig(rawSecret)
	if err != nil {
		log.Error("Google OAuth secret parse failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", err.Error())
	}

	signingSecret, err := oauthSecretsProvider.GetSecretString(ctx, oauthEnv.SlackSigningSecretSecretID)
	if err != nil {
		log.Error("Slack signing secret lookup failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", "Slack signing secret lookup failed.")
	}

	state, err := calendar.VerifyGoogleOAuthState(stateToken, signingSecret)
	if err != nil {
		log.Error("Google OAuth state verification failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", err.Error())
	}

	token, err := calendar.ExchangeGoogleAuthorizationCode(oauthHTTPClient, oauthConfig, buildRedirectURI(event), code)
	if err != nil {
		log.Error("Google OAuth token exchange failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", err.Error())
	}
	if token.RefreshToken == "" {
		return errorHTML("Google Calendar連携に失敗しました", "Google did not return a refresh token. Reopen the authorization link and approve access again.")
	}

	userInfo, err := calendar.FetchGoogleUserInfo(oauthHTTPClient, token.AccessToken)
	if err != nil {
		log.Error("Google userinfo request failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", err.Error())
	}

	err = oauthConnections.Save(ctx, repo.GoogleOAuthConnection{
		WorkspaceID:   state.WorkspaceID,
		UserID:        state.UserID,
		GoogleSubject: userInfo.Subject,
		GoogleEmail:   userInfo.Email,
		RefreshToken:  token.RefreshToken,
		CalendarID:    "primary",
		TimeZone:      oauthEnv.GoogleCalendarTimeZone,
		Scopes:        calendar.SplitScope(token.Scope),
	})
	if err != nil {
		log.Error("Google OAuth connection save failed", logger.Fields{"error": err.Error()})
		return errorHTML("Google Calendar連携に失敗しました", err.Error())
	}

	log.Info("Google Calendar connected", logger.Fields{
		"workspaceId": state.WorkspaceID,
		"userId":      state.UserID,
		"googleEmail": userInfo.Email,
	})

	return lambdahttp.HTML(http.StatusOK, successHTML("Google Calendar連携が完了しました", "Slackに戻って、もう一度カレンダー操作を依頼してください。"))
}

func buildRedirectURI(event events.APIGatewayProxyRequest) string {
	host := event.Headers["Host"]
	if host == "" {
		host = event.Headers["host"]
	}
	if host == "" {
		panic("missing request host")
	}
	return fmt.Sprintf("https://%s/%s/oauth/google/callback", host, event.RequestContext.Stage)
}

func errorHTML(title string, message string) events.APIGatewayProxyResponse {
	return lambdahttp.HTML(http.StatusInternalServerError, successHTML(title, message))
}

func successHTML(title string, message string) string {
	return "<!doctype html><html><body><h1>" + html.EscapeString(title) + "</h1><p>" + html.EscapeString(message) + "</p></body></html>"
}
