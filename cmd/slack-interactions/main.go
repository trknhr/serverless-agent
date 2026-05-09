package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/calendar"
	"github.com/trknhr/slack-ai-assistant/internal/config"
	"github.com/trknhr/slack-ai-assistant/internal/integrations"
	"github.com/trknhr/slack-ai-assistant/internal/lambdahttp"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/secrets"
	"github.com/trknhr/slack-ai-assistant/internal/slack"
	"github.com/trknhr/slack-ai-assistant/internal/tools"
)

type interactionPayload struct {
	User struct {
		ID string `json:"id,omitempty"`
	} `json:"user,omitempty"`
	Channel struct {
		ID string `json:"id,omitempty"`
	} `json:"channel,omitempty"`
	Message struct {
		TS string `json:"ts,omitempty"`
	} `json:"message,omitempty"`
	Actions []struct {
		ActionID string `json:"action_id,omitempty"`
		Value    string `json:"value,omitempty"`
	} `json:"actions,omitempty"`
}

type calendarDraftActionValue struct {
	Action      string `json:"action"`
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId,omitempty"`
	DraftID     string `json:"draftId"`
}

var (
	interactionsEnv             = config.MustLoadSlackInteractionsEnv()
	interactionsLogger          = logger.Default()
	interactionsAWSConfig, _    = awsconfig.LoadDefaultConfig(context.Background())
	interactionsSecretsProvider = secrets.New(secretsmanager.NewFromConfig(interactionsAWSConfig))
	interactionsSlackClient     = slack.NewWebClient(func(ctx context.Context) (string, error) {
		return interactionsSecretsProvider.GetSecretString(ctx, interactionsEnv.SlackBotTokenSecretID)
	})
	interactionsCalendarDraftRepository = repo.NewCalendarDraftRepository(dynamodb.NewFromConfig(interactionsAWSConfig), interactionsEnv.CalendarDraftsTableName)
	interactionsGoogleOAuthConnections  = repo.NewGoogleOAuthConnectionRepository(dynamodb.NewFromConfig(interactionsAWSConfig), interactionsEnv.GoogleOAuthConnectionsTable)
	interactionsMemoryItemRepository    = repo.NewMemoryItemRepository(dynamodb.NewFromConfig(interactionsAWSConfig), interactionsEnv.MemoryItemsTableName)
	interactionsTaskEventRepository     = repo.NewTaskEventRepository(dynamodb.NewFromConfig(interactionsAWSConfig), interactionsEnv.TaskEventsTableName)
	interactionsTaskStateRepository     = repo.NewTaskStateRepository(dynamodb.NewFromConfig(interactionsAWSConfig), interactionsEnv.TasksTableName)
)

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	log := interactionsLogger.Child(logger.Fields{
		"requestId": event.RequestContext.RequestID,
		"component": "slack-interactions",
	})

	rawBody, err := decodeBody(event.Body, event.IsBase64Encoded)
	if err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body"}), nil
	}

	signingSecret, err := interactionsSecretsProvider.GetSecretString(ctx, interactionsEnv.SlackSigningSecretSecretID)
	if err != nil {
		log.Error("Slack signing secret lookup failed", logger.Fields{"error": err.Error()})
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error"}), nil
	}
	if !slack.VerifySignature(slack.VerifySignatureInput{
		RawBody:       rawBody,
		Signature:     getHeader(event.Headers, "X-Slack-Signature"),
		Timestamp:     getHeader(event.Headers, "X-Slack-Request-Timestamp"),
		SigningSecret: signingSecret,
	}) {
		log.Warn("Slack interaction signature verification failed", nil)
		return lambdahttp.JSON(http.StatusUnauthorized, map[string]any{"ok": false, "error": "invalid_signature"}), nil
	}

	payload, err := parseInteractionPayload(rawBody)
	if err != nil {
		log.Error("Slack interaction payload parse failed", logger.Fields{"error": err.Error()})
		return lambdahttp.JSON(http.StatusOK, map[string]any{"ok": false, "error": err.Error()}), nil
	}
	if len(payload.Actions) == 0 || payload.Actions[0].Value == "" {
		return lambdahttp.JSON(http.StatusOK, map[string]any{"ok": true, "ignored": true}), nil
	}

	var value calendarDraftActionValue
	if err := json.Unmarshal([]byte(payload.Actions[0].Value), &value); err != nil {
		log.Error("Slack interaction action parse failed", logger.Fields{"error": err.Error()})
		return lambdahttp.JSON(http.StatusOK, map[string]any{"ok": false, "error": "invalid_action"}), nil
	}
	if value.UserID != "" && payload.User.ID != "" && value.UserID != payload.User.ID {
		_ = updateInteractionMessage(ctx, payload, "この下書きは作成者だけが操作できます。")
		return lambdahttp.JSON(http.StatusOK, map[string]any{"ok": true, "rejected": true}), nil
	}

	result, err := executeCalendarDraftAction(ctx, value, log)
	if err != nil {
		log.Error("Slack interaction execution failed", logger.Fields{"error": err.Error(), "action": value.Action, "draftId": value.DraftID})
		return lambdahttp.JSON(http.StatusOK, map[string]any{"ok": false, "error": err.Error()}), nil
	}
	_ = updateInteractionMessage(ctx, payload, formatInteractionResult(value, result))

	log.Info("Slack calendar draft interaction handled", logger.Fields{
		"action":  value.Action,
		"draftId": value.DraftID,
		"userId":  payload.User.ID,
	})
	return lambdahttp.JSON(http.StatusOK, map[string]any{"ok": true}), nil
}

func executeCalendarDraftAction(ctx context.Context, value calendarDraftActionValue, log *logger.Logger) (*tools.ExecutionResult, error) {
	executor := tools.NewExecutor(tools.Repositories{
		MemoryItems:    interactionsMemoryItemRepository,
		Tasks:          interactionsTaskStateRepository,
		TaskEvents:     interactionsTaskEventRepository,
		CalendarDrafts: interactionsCalendarDraftRepository,
	}, tools.ToolExecutionContext{
		WorkspaceID: value.WorkspaceID,
		UserID:      value.UserID,
		Logger:      log,
	}, tools.Integrations{
		GoogleCalendarProvider: func(ctx context.Context) (*calendar.GoogleCalendarClient, error) {
			return integrations.CreateUserGoogleCalendarClient(
				value.WorkspaceID,
				value.UserID,
				interactionsEnv.GoogleCalendarTimeZone,
				interactionsEnv.GoogleCalendarSecretID,
				interactionsEnv.GoogleOAuthStartURL,
				interactionsSecretsProvider,
				interactionsGoogleOAuthConnections,
			), nil
		},
		DefaultCalendarTimeZone: interactionsEnv.GoogleCalendarTimeZone,
	})

	toolName := "discard_calendar_draft"
	if value.Action == "approve" {
		toolName = "apply_calendar_draft"
	}
	return executor.Execute(ctx, anthropic.SessionEvent{
		ID:   fmt.Sprintf("slack_interaction_%d", time.Now().UnixMilli()),
		Type: "agent.custom_tool_use",
		Name: toolName,
		Input: map[string]any{
			"draft_id": value.DraftID,
		},
	})
}

func updateInteractionMessage(ctx context.Context, payload *interactionPayload, textValue string) error {
	if payload.Channel.ID == "" || payload.Message.TS == "" {
		return nil
	}
	return interactionsSlackClient.UpdateMessage(ctx, slack.UpdateMessageInput{
		Channel: payload.Channel.ID,
		TS:      payload.Message.TS,
		Text:    textValue,
		Blocks:  []map[string]any{},
	})
}

func formatInteractionResult(value calendarDraftActionValue, result *tools.ExecutionResult) string {
	details := ""
	if result != nil {
		parts := make([]string, 0)
		for _, block := range result.Content {
			if block["type"] == "text" {
				if textValue, ok := block["text"].(string); ok {
					parts = append(parts, textValue)
				}
			}
		}
		details = strings.TrimSpace(strings.Join(parts, "\n"))
	}
	if result != nil && result.IsError {
		if value.Action == "approve" {
			return strings.TrimSpace("カレンダー下書きの承認に失敗しました。\n" + details)
		}
		return strings.TrimSpace("カレンダー下書きの却下に失敗しました。\n" + details)
	}
	if value.Action == "approve" {
		return strings.TrimSpace("カレンダー下書きを承認し、予定を作成しました。\n" + details)
	}
	return strings.TrimSpace("カレンダー下書きを却下しました。\n" + details)
}

func parseInteractionPayload(rawBody string) (*interactionPayload, error) {
	values, err := url.ParseQuery(rawBody)
	if err != nil {
		return nil, err
	}
	payloadValue := values.Get("payload")
	if payloadValue == "" {
		return nil, fmt.Errorf("missing Slack interaction payload")
	}
	var payload interactionPayload
	if err := json.Unmarshal([]byte(payloadValue), &payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

func decodeBody(body string, isBase64Encoded bool) (string, error) {
	if !isBase64Encoded {
		return body, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func getHeader(headers map[string]string, name string) string {
	if value, ok := headers[name]; ok {
		return value
	}
	lower := strings.ToLower(name)
	for key, value := range headers {
		if strings.ToLower(key) == lower {
			return value
		}
	}
	return ""
}
