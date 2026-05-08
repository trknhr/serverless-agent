package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/calendar"
	"github.com/trknhr/slack-ai-assistant/internal/chat"
	"github.com/trknhr/slack-ai-assistant/internal/config"
	"github.com/trknhr/slack-ai-assistant/internal/integrations"
	"github.com/trknhr/slack-ai-assistant/internal/lambdahttp"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/memory"
	"github.com/trknhr/slack-ai-assistant/internal/memorystore"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/secrets"
	"github.com/trknhr/slack-ai-assistant/internal/tools"
)

var (
	chatEnv             = config.MustLoadChatAPIEnv()
	chatLogger          = logger.Default()
	chatAWSConfig, _    = awsconfig.LoadDefaultConfig(context.Background())
	chatSecretsProvider = secrets.New(secretsmanager.NewFromConfig(chatAWSConfig))
	chatAnthropicClient = anthropic.NewClient(func(ctx context.Context) (string, error) {
		return chatSecretsProvider.GetSecretString(ctx, chatEnv.AnthropicAPIKeySecretID)
	}, chatEnv.AnthropicManagedAgentsBeta)
	chatCalendarDraftRepository  = repo.NewCalendarDraftRepository(dynamodb.NewFromConfig(chatAWSConfig), chatEnv.CalendarDraftsTableName)
	chatMemoryItemRepository     = repo.NewMemoryItemRepository(dynamodb.NewFromConfig(chatAWSConfig), chatEnv.MemoryItemsTableName)
	chatTaskEventRepository      = repo.NewTaskEventRepository(dynamodb.NewFromConfig(chatAWSConfig), chatEnv.TaskEventsTableName)
	chatTaskStateRepository      = repo.NewTaskStateRepository(dynamodb.NewFromConfig(chatAWSConfig), chatEnv.TasksTableName)
	chatUserMemoryRepository     = repo.NewUserMemoryRepository(dynamodb.NewFromConfig(chatAWSConfig), chatEnv.UserMemoryTableName)
	chatUserPreferenceRepository = repo.NewUserPreferenceRepository(dynamodb.NewFromConfig(chatAWSConfig), chatEnv.MemoryItemsTableName)
	chatGoogleOAuthConnections   = repo.NewGoogleOAuthConnectionRepository(dynamodb.NewFromConfig(chatAWSConfig), chatEnv.GoogleOAuthConnectionsTable)
	chatMemoryStoreService       = memorystore.New(chatUserMemoryRepository, chatAnthropicClient)
)

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	log := chatLogger.Child(logger.Fields{
		"requestId": event.RequestContext.RequestID,
		"component": "chat-api",
	})

	if event.HTTPMethod != http.MethodPost || event.Resource != "/chat/messages" {
		return lambdahttp.JSON(http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"}), nil
	}

	var input chat.MessageRequest
	if err := parseJSONBody(event, &input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body", "message": err.Error()}), nil
	}
	if strings.TrimSpace(input.WorkspaceID) == "" || strings.TrimSpace(input.UserID) == "" || strings.TrimSpace(input.Text) == "" {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request"}), nil
	}

	sessionID := strings.TrimSpace(input.SessionID)
	if sessionID == "" {
		memoryResources := make([]anthropic.SessionMemoryResource, 0)
		if chatEnv.EnableUserMemory {
			store, err := chatMemoryStoreService.GetOrCreateMemoryStore(ctx, input.WorkspaceID, input.UserID)
			if err != nil {
				log.Error("Memory store lookup failed", logger.Fields{"error": err.Error()})
				return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()}), nil
			}
			memoryResources = append(memoryResources, anthropic.SessionMemoryResource{
				MemoryStoreID: store.MemoryStoreID,
				Access:        "read_write",
				Prompt:        memory.ResourcePrompt,
			})
		}
		session, err := anthropic.CreateSession(ctx, chatAnthropicClient, anthropic.CreateSessionInput{
			AgentID:       chatEnv.AnthropicAgentID,
			EnvironmentID: chatEnv.AnthropicEnvironmentID,
			VaultIDs:      chatEnv.AnthropicVaultIDs,
			Title:         "Direct chat " + input.WorkspaceID + "/" + input.UserID,
			Metadata: map[string]string{
				"source":       "direct_chat_api",
				"workspace_id": input.WorkspaceID,
				"user_id":      input.UserID,
				"created_at":   time.Now().UTC().Format(time.RFC3339),
			},
			MemoryResources: memoryResources,
		})
		if err != nil {
			log.Error("Anthropic session creation failed", logger.Fields{"error": err.Error()})
			return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()}), nil
		}
		sessionID = session.ID
	}

	seenEventIDs := map[string]struct{}{}
	sessionEvents, err := chatAnthropicClient.ListSessionEvents(ctx, sessionID, "asc", 0)
	if err != nil {
		log.Error("Session event fetch failed", logger.Fields{"error": err.Error(), "sessionId": sessionID})
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()}), nil
	}
	for _, sessionEvent := range sessionEvents {
		seenEventIDs[sessionEvent.ID] = struct{}{}
	}

	executor := tools.NewExecutor(tools.Repositories{
		MemoryItems:     chatMemoryItemRepository,
		UserPreferences: chatUserPreferenceRepository,
		Tasks:           chatTaskStateRepository,
		TaskEvents:      chatTaskEventRepository,
		CalendarDrafts:  chatCalendarDraftRepository,
	}, tools.ToolExecutionContext{
		WorkspaceID: input.WorkspaceID,
		UserID:      input.UserID,
		Logger:      log,
	}, tools.Integrations{
		GoogleCalendarProvider: func(ctx context.Context) (*calendar.GoogleCalendarClient, error) {
			return integrations.CreateUserGoogleCalendarClient(
				input.WorkspaceID,
				input.UserID,
				chatEnv.GoogleCalendarTimeZone,
				chatEnv.GoogleCalendarSecretID,
				chatEnv.GoogleOAuthStartURL,
				chatSecretsProvider,
				chatGoogleOAuthConnections,
			), nil
		},
		DefaultCalendarTimeZone: chatEnv.GoogleCalendarTimeZone,
	})

	if err := anthropic.SendUserMessage(ctx, chatAnthropicClient, sessionID, []anthropic.InputBlock{
		{
			"type": "text",
			"text": input.Text,
		},
	}); err != nil {
		log.Error("Anthropic user message send failed", logger.Fields{"error": err.Error(), "sessionId": sessionID})
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()}), nil
	}

	completion, err := anthropic.WaitForCompletion(ctx, chatAnthropicClient, anthropic.WaitForCompletionInput{
		SessionID:     sessionID,
		SinceEventIDs: seenEventIDs,
		TimeoutMS:     min(chatEnv.AgentResponseTimeoutMS, 25000),
		OnCustomToolUse: func(ctx context.Context, event anthropic.SessionEvent) (*anthropic.ToolExecutionResult, error) {
			result, err := executor.Execute(ctx, event)
			if err != nil {
				return nil, err
			}
			return &anthropic.ToolExecutionResult{
				Content: result.Content,
				IsError: result.IsError,
			}, nil
		},
	})
	if err != nil {
		statusCode := http.StatusInternalServerError
		if strings.HasPrefix(err.Error(), "timed out waiting for Claude session") {
			statusCode = http.StatusGatewayTimeout
		}
		log.Error("Anthropic completion failed", logger.Fields{"error": err.Error(), "sessionId": sessionID})
		return lambdahttp.JSON(statusCode, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()}), nil
	}

	summary := executor.Summary()
	return lambdahttp.JSON(http.StatusOK, map[string]any{
		"ok":             true,
		"sessionId":      sessionID,
		"text":           completion.Text,
		"taskIds":        summary.TaskIDs,
		"savedMemoryIds": summary.SavedMemoryIDs,
	}), nil
}

func parseJSONBody(event events.APIGatewayProxyRequest, target any) error {
	body := event.Body
	if event.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			return err
		}
		body = string(decoded)
	}
	if strings.TrimSpace(body) == "" {
		body = "{}"
	}
	return json.Unmarshal([]byte(body), target)
}

func min(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
