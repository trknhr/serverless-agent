package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
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
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
	"github.com/trknhr/slack-ai-assistant/internal/conversations"
	"github.com/trknhr/slack-ai-assistant/internal/integrations"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/memory"
	"github.com/trknhr/slack-ai-assistant/internal/memorystore"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/secrets"
	"github.com/trknhr/slack-ai-assistant/internal/slack"
	"github.com/trknhr/slack-ai-assistant/internal/tools"
)

const workerThinkingText = "考え中です..."

var (
	workerEnv             = config.MustLoadWorkerEnv()
	workerLogger          = logger.Default()
	workerAWSConfig, _    = awsconfig.LoadDefaultConfig(context.Background())
	workerDynamoClient    = dynamodb.NewFromConfig(workerAWSConfig)
	workerSecretsProvider = secrets.New(secretsmanager.NewFromConfig(workerAWSConfig))
	workerAnthropicClient = anthropic.NewClient(func(ctx context.Context) (string, error) {
		return workerSecretsProvider.GetSecretString(ctx, workerEnv.AnthropicAPIKeySecretID)
	}, workerEnv.AnthropicManagedAgentsBeta)
	workerSlackClient = slack.NewWebClient(func(ctx context.Context) (string, error) {
		return workerSecretsProvider.GetSecretString(ctx, workerEnv.SlackBotTokenSecretID)
	})
	workerSlackConversationsClient = slack.NewConversationsClient(func(ctx context.Context) (string, error) {
		return workerSecretsProvider.GetSecretString(ctx, workerEnv.SlackBotTokenSecretID)
	})
	workerSlackFilesClient = slack.NewFilesClient(func(ctx context.Context) (string, error) {
		return workerSecretsProvider.GetSecretString(ctx, workerEnv.SlackBotTokenSecretID)
	}, workerEnv.MaxSlackFileBytes)
	workerCalendarDraftRepository  = repo.NewCalendarDraftRepository(workerDynamoClient, workerEnv.CalendarDraftsTableName)
	workerMemoryItemRepository     = repo.NewMemoryItemRepository(workerDynamoClient, workerEnv.MemoryItemsTableName)
	workerChannelMemoryRepository  = repo.NewChannelMemoryRepository(workerDynamoClient, workerEnv.MemoryItemsTableName)
	workerConversationSessionRepo  = repo.NewConversationSessionRepository(workerDynamoClient, workerEnv.ConversationSessionsTableName)
	workerConversationTurnRepo     = repo.NewConversationTurnRepository(workerDynamoClient, workerEnv.ConversationTurnsTableName)
	workerSourceDocumentRepository = repo.NewSourceDocumentRepository(workerDynamoClient, workerEnv.SourceDocumentsTableName)
	workerTaskEventRepository      = repo.NewTaskEventRepository(workerDynamoClient, workerEnv.TaskEventsTableName)
	workerTaskStateRepository      = repo.NewTaskStateRepository(workerDynamoClient, workerEnv.TasksTableName)
	workerUserMemoryRepository     = repo.NewUserMemoryRepository(workerDynamoClient, workerEnv.UserMemoryTableName)
	workerUserPreferenceRepo       = repo.NewUserPreferenceRepository(workerDynamoClient, workerEnv.MemoryItemsTableName)
	workerGoogleOAuthConnections   = repo.NewGoogleOAuthConnectionRepository(workerDynamoClient, workerEnv.GoogleOAuthConnectionsTable)
	workerMemoryStoreService       = memorystore.New(workerUserMemoryRepository, workerAnthropicClient)
	workerAttachmentArchiveService = slack.NewAttachmentArchiveService(
		workerEnv.SlackAttachmentArchiveBucket,
		workerSourceDocumentRepository,
	)
)

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, event events.SQSEvent) error {
	for _, record := range event.Records {
		if err := processRecord(ctx, record); err != nil {
			return err
		}
	}
	return nil
}

func processRecord(ctx context.Context, record events.SQSMessage) error {
	var queueMessage contracts.SlackQueueMessage
	if err := json.Unmarshal([]byte(record.Body), &queueMessage); err != nil {
		return err
	}

	log := workerLogger.Child(logger.Fields{
		"component":     "slack-events-worker",
		"messageId":     record.MessageId,
		"correlationId": queueMessage.CorrelationID,
		"eventId":       queueMessage.EventID,
	})

	now := time.Now().UTC().Format(time.RFC3339)
	existingSession, err := workerConversationSessionRepo.FindByConversation(
		ctx,
		queueMessage.WorkspaceID,
		queueMessage.ChannelID,
		queueMessage.ConversationTS,
	)
	if err != nil {
		return err
	}

	if queueMessage.Source == contracts.SlackSourceThread && existingSession == nil {
		log.Info("Slack thread reply ignored because no assistant session exists", logger.Fields{
			"channelId":      queueMessage.ChannelID,
			"conversationTs": queueMessage.ConversationTS,
			"messageTs":      queueMessage.MessageTS,
		})
		return nil
	}

	memoryStoreID := ""
	if existingSession != nil {
		memoryStoreID = existingSession.MemoryStoreID
	}
	if workerEnv.EnableUserMemory && memoryStoreID == "" {
		record, err := workerMemoryStoreService.GetOrCreateMemoryStore(ctx, queueMessage.WorkspaceID, queueMessage.UserID)
		if err != nil {
			return err
		}
		memoryStoreID = record.MemoryStoreID
	}

	sessionRecord := existingSession
	if sessionRecord == nil {
		created := createConversationSession(
			queueMessage.WorkspaceID,
			queueMessage.ChannelID,
			queueMessage.ConversationTS,
			memoryStoreID,
		)
		sessionRecord = &created
	}

	if existingSession == nil {
		memoryResources := make([]anthropic.SessionMemoryResource, 0)
		if memoryStoreID != "" {
			memoryResources = append(memoryResources, anthropic.SessionMemoryResource{
				MemoryStoreID: memoryStoreID,
				Access:        "read_write",
				Prompt:        memory.ResourcePrompt,
			})
		}
		metadata := map[string]string{
			"workspace_id":    queueMessage.WorkspaceID,
			"channel_id":      queueMessage.ChannelID,
			"conversation_ts": queueMessage.ConversationTS,
			"source":          "slack",
		}
		if queueMessage.ReplyThreadTS != "" {
			metadata["reply_thread_ts"] = queueMessage.ReplyThreadTS
		}

		session, err := anthropic.CreateSession(ctx, workerAnthropicClient, anthropic.CreateSessionInput{
			AgentID:         workerEnv.AnthropicAgentID,
			EnvironmentID:   workerEnv.AnthropicEnvironmentID,
			VaultIDs:        workerEnv.AnthropicVaultIDs,
			Title:           "Slack conversation " + queueMessage.ChannelID + "/" + queueMessage.ConversationTS,
			Metadata:        metadata,
			MemoryResources: memoryResources,
		})
		if err != nil {
			return err
		}
		sessionRecord.ClaudeSessionID = session.ID
		sessionRecord.LastUsedAt = now
		if err := workerConversationSessionRepo.Save(ctx, *sessionRecord); err != nil {
			return err
		}

		if queueMessage.ContextScope == contracts.ContextScopeThread {
			if err := backfillThreadHistory(ctx, queueMessage, log); err != nil {
				return err
			}
		}
	}

	seenEventIDs, err := collectSessionEventIDs(ctx, sessionRecord.ClaudeSessionID)
	if err != nil {
		return err
	}

	preparedAttachments, err := workerSlackFilesClient.PrepareAttachments(ctx, queueMessage.Files)
	if err != nil {
		return err
	}
	if err := workerAttachmentArchiveService.ArchiveAttachments(ctx, slack.ArchiveAttachmentsInput{
		WorkspaceID: queueMessage.WorkspaceID,
		ChannelID:   queueMessage.ChannelID,
		ThreadTS:    chooseString(queueMessage.ReplyThreadTS, queueMessage.ConversationTS),
		MessageTS:   queueMessage.MessageTS,
		UserID:      queueMessage.UserID,
		Attachments: preparedAttachments,
		Logger:      log,
	}); err != nil {
		return err
	}
	attachmentBlocks := workerSlackFilesClient.BuildContentBlocks(preparedAttachments, 0)

	var priorTurns []contracts.ConversationTurnRecord
	if queueMessage.ContextScope == contracts.ContextScopeThread {
		priorTurns, err = workerConversationTurnRepo.ListByConversation(
			ctx,
			queueMessage.WorkspaceID,
			queueMessage.ChannelID,
			queueMessage.ConversationTS,
		)
	} else {
		priorTurns, err = workerConversationTurnRepo.ListRecentChannelTopLevelTurns(
			ctx,
			queueMessage.WorkspaceID,
			queueMessage.ChannelID,
			workerEnv.TopLevelContextTurnLimit,
		)
	}
	if err != nil {
		return err
	}

	if _, err := workerConversationTurnRepo.Save(ctx, contracts.ConversationTurnRecord{
		WorkspaceID:    queueMessage.WorkspaceID,
		ChannelID:      queueMessage.ChannelID,
		ConversationTS: queueMessage.ConversationTS,
		ContextScope:   queueMessage.ContextScope,
		Role:           "user",
		Source:         "slack",
		SourceEvent:    string(queueMessage.Source),
		ThreadTS:       queueMessage.ReplyThreadTS,
		MessageTS:      queueMessage.MessageTS,
		TurnTS:         queueMessage.MessageTS,
		UserID:         queueMessage.UserID,
		Text:           conversations.BuildTurnText(queueMessage.Text, queueMessage.Files),
	}); err != nil {
		return err
	}

	executor := tools.NewExecutor(tools.Repositories{
		MemoryItems:     workerMemoryItemRepository,
		ChannelMemories: workerChannelMemoryRepository,
		UserPreferences: workerUserPreferenceRepo,
		Tasks:           workerTaskStateRepository,
		TaskEvents:      workerTaskEventRepository,
		CalendarDrafts:  workerCalendarDraftRepository,
	}, tools.ToolExecutionContext{
		WorkspaceID: queueMessage.WorkspaceID,
		UserID:      queueMessage.UserID,
		ChannelID:   queueMessage.ChannelID,
		Logger:      log,
		MemoryWritePolicy: &tools.MemoryWritePolicy{
			AllowWorkspaceMemory:  false,
			ChannelInferredStatus: "candidate",
			DefaultOrigin:         "inferred",
		},
	}, tools.Integrations{
		GoogleCalendarProvider: func(ctx context.Context) (*calendar.GoogleCalendarClient, error) {
			return integrations.CreateUserGoogleCalendarClient(
				queueMessage.WorkspaceID,
				queueMessage.UserID,
				workerEnv.GoogleCalendarTimeZone,
				workerEnv.GoogleCalendarSecretID,
				workerEnv.GoogleOAuthStartURL,
				workerSecretsProvider,
				workerGoogleOAuthConnections,
			), nil
		},
		DefaultCalendarTimeZone: workerEnv.GoogleCalendarTimeZone,
	})

	if err := anthropic.SendUserMessage(
		ctx,
		workerAnthropicClient,
		sessionRecord.ClaudeSessionID,
		conversations.BuildSlackContextBlocks(
			queueMessage.ContextScope,
			priorTurns,
			queueMessage.Text,
			attachmentBlocks,
		),
	); err != nil {
		return err
	}

	thinkingTS, err := workerSlackClient.PostMessage(ctx, slack.PostMessageInput{
		Channel:  queueMessage.ChannelID,
		ThreadTS: queueMessage.ReplyThreadTS,
		Text:     workerThinkingText,
	})
	if err != nil {
		return err
	}
	lastThinkingText := workerThinkingText
	updateThinkingMessage := func(text string) {
		if thinkingTS == "" || text == lastThinkingText {
			return
		}
		if err := workerSlackClient.UpdateMessage(ctx, slack.UpdateMessageInput{
			Channel:  queueMessage.ChannelID,
			TS:       thinkingTS,
			ThreadTS: queueMessage.ReplyThreadTS,
			Text:     text,
		}); err != nil {
			log.Warn("Failed to update Slack thinking message", logger.Fields{
				"error": err.Error(),
			})
			return
		}
		lastThinkingText = text
	}

	completion, err := anthropic.WaitForCompletion(ctx, workerAnthropicClient, anthropic.WaitForCompletionInput{
		SessionID:     sessionRecord.ClaudeSessionID,
		SinceEventIDs: seenEventIDs,
		TimeoutMS:     workerEnv.AgentResponseTimeoutMS,
		OnCustomToolUse: func(ctx context.Context, event anthropic.SessionEvent) (*anthropic.ToolExecutionResult, error) {
			updateThinkingMessage(describeToolProgress(event.Name))
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
		return err
	}

	summary := executor.Summary()
	assistantMessageTS := thinkingTS
	if thinkingTS != "" {
		if err := workerSlackClient.UpdateMessage(ctx, slack.UpdateMessageInput{
			Channel:  queueMessage.ChannelID,
			TS:       thinkingTS,
			ThreadTS: queueMessage.ReplyThreadTS,
			Text:     completion.Text,
		}); err != nil {
			log.Warn("Failed to replace Slack thinking message; posting final response separately", logger.Fields{
				"error": err.Error(),
			})
			postedTS, postErr := workerSlackClient.PostMessage(ctx, slack.PostMessageInput{
				Channel:  queueMessage.ChannelID,
				ThreadTS: queueMessage.ReplyThreadTS,
				Text:     completion.Text,
			})
			if postErr != nil {
				return postErr
			}
			if postedTS != "" {
				assistantMessageTS = postedTS
			}
		}
	} else {
		postedTS, err := workerSlackClient.PostMessage(ctx, slack.PostMessageInput{
			Channel:  queueMessage.ChannelID,
			ThreadTS: queueMessage.ReplyThreadTS,
			Text:     completion.Text,
		})
		if err != nil {
			return err
		}
		assistantMessageTS = postedTS
	}
	if assistantMessageTS == "" {
		assistantMessageTS = createSyntheticSlackTS()
	}

	if _, err := workerConversationTurnRepo.Save(ctx, contracts.ConversationTurnRecord{
		WorkspaceID:    queueMessage.WorkspaceID,
		ChannelID:      queueMessage.ChannelID,
		ConversationTS: queueMessage.ConversationTS,
		ContextScope:   queueMessage.ContextScope,
		Role:           "assistant",
		Source:         "slack",
		SourceEvent:    "assistant_reply",
		ThreadTS:       queueMessage.ReplyThreadTS,
		MessageTS:      assistantMessageTS,
		TurnTS:         assistantMessageTS,
		Text:           completion.Text,
	}); err != nil {
		return err
	}

	for _, draftID := range summary.CalendarDraftIDs {
		draft, err := workerCalendarDraftRepository.Get(ctx, queueMessage.WorkspaceID, queueMessage.UserID, draftID)
		if err != nil {
			return err
		}
		if draft == nil {
			continue
		}
		if _, err := workerSlackClient.PostMessage(ctx, slack.PostMessageInput{
			Channel:  queueMessage.ChannelID,
			ThreadTS: chooseString(queueMessage.ReplyThreadTS, assistantMessageTS),
			Text:     buildCalendarDraftApprovalText(*draft),
			Blocks:   buildCalendarDraftApprovalBlocks(*draft, queueMessage.ChannelID, assistantMessageTS),
		}); err != nil {
			return err
		}
	}

	sessionRecord.MemoryStoreID = memoryStoreID
	sessionRecord.LastUsedAt = now
	if err := workerConversationSessionRepo.Save(ctx, *sessionRecord); err != nil {
		return err
	}

	archivedCount := 0
	for _, attachment := range preparedAttachments {
		if attachment.Status == "ready" {
			archivedCount++
		}
	}
	log.Info("Slack conversation processed", logger.Fields{
		"claudeSessionId":         sessionRecord.ClaudeSessionID,
		"conversationTs":          queueMessage.ConversationTS,
		"contextScope":            queueMessage.ContextScope,
		"status":                  completion.Status,
		"attachmentCount":         len(queueMessage.Files),
		"archivedAttachmentCount": archivedCount,
	})
	return nil
}

func collectSessionEventIDs(ctx context.Context, sessionID string) (map[string]struct{}, error) {
	events, err := workerAnthropicClient.ListSessionEvents(ctx, sessionID, "asc", 0)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(events))
	for _, event := range events {
		seen[event.ID] = struct{}{}
	}
	return seen, nil
}

func createConversationSession(workspaceID string, channelID string, conversationTS string, memoryStoreID string) contracts.ConversationSessionRecord {
	now := time.Now().UTC().Format(time.RFC3339)
	return contracts.ConversationSessionRecord{
		WorkspaceID:     workspaceID,
		ChannelID:       channelID,
		ConversationTS:  conversationTS,
		ClaudeSessionID: "",
		MemoryStoreID:   memoryStoreID,
		CreatedAt:       now,
		LastUsedAt:      now,
	}
}

func backfillThreadHistory(ctx context.Context, queueMessage contracts.SlackQueueMessage, log *logger.Logger) error {
	threadMessages, err := workerSlackConversationsClient.ListReplies(ctx, queueMessage.ChannelID, queueMessage.ConversationTS)
	if err != nil {
		return err
	}
	priorMessages := make([]slack.ThreadMessage, 0, len(threadMessages))
	for _, message := range threadMessages {
		if compareSlackTS(message.TS, queueMessage.MessageTS) < 0 {
			priorMessages = append(priorMessages, message)
		}
	}

	for _, message := range priorMessages {
		text := conversations.BuildTurnText(message.Text, message.Files)
		if strings.TrimSpace(text) == "" {
			continue
		}
		if _, err := workerConversationTurnRepo.Save(ctx, contracts.ConversationTurnRecord{
			WorkspaceID:    queueMessage.WorkspaceID,
			ChannelID:      queueMessage.ChannelID,
			ConversationTS: queueMessage.ConversationTS,
			ContextScope:   contracts.ContextScopeThread,
			Role:           inferBackfillRole(message),
			Source:         "slack",
			SourceEvent:    "thread_backfill",
			ThreadTS:       queueMessage.ConversationTS,
			MessageTS:      message.TS,
			TurnTS:         message.TS,
			UserID:         message.UserID,
			Text:           text,
		}); err != nil {
			return err
		}
	}

	log.Info("Slack thread history backfilled", logger.Fields{
		"channelId":           queueMessage.ChannelID,
		"conversationTs":      queueMessage.ConversationTS,
		"backfilledTurnCount": len(priorMessages),
	})
	return nil
}

func inferBackfillRole(message slack.ThreadMessage) string {
	if message.BotID != "" || message.Subtype != "" {
		return "system"
	}
	return "user"
}

func buildCalendarDraftApprovalText(draft calendar.Draft) string {
	lines := []string{
		fmt.Sprintf("カレンダー下書き「%s」を作成しました。", draft.Title),
	}
	pending := 0
	for _, candidate := range draft.Candidates {
		if candidate.Status != "pending" {
			continue
		}
		if pending < 5 {
			lines = append(lines, fmt.Sprintf("- %s (%s)", candidate.Summary, formatCalendarCandidateTime(candidate)))
		}
		pending++
	}
	lines = append(lines, "作成してよければ承認してください。")
	return strings.Join(lines, "\n")
}

func buildCalendarDraftApprovalBlocks(draft calendar.Draft, channelID string, messageTS string) []map[string]any {
	pending := make([]calendar.DraftCandidate, 0, len(draft.Candidates))
	for _, candidate := range draft.Candidates {
		if candidate.Status == "pending" {
			pending = append(pending, candidate)
		}
	}
	candidateLines := make([]string, 0, min(len(pending), 5))
	for index, candidate := range pending {
		if index >= 5 {
			break
		}
		candidateLines = append(candidateLines, fmt.Sprintf("• %s (%s)", candidate.Summary, formatCalendarCandidateTime(candidate)))
	}
	candidateText := strings.Join(candidateLines, "\n")
	if candidateText == "" {
		candidateText = "承認待ち候補はありません。"
	}
	suffix := ""
	if len(pending) > 5 {
		suffix = fmt.Sprintf("\n他 %d 件", len(pending)-5)
	}

	return []map[string]any{
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": fmt.Sprintf("*カレンダー下書き*: %s\n%s%s", draft.Title, candidateText, suffix),
			},
		},
		{
			"type": "actions",
			"elements": []map[string]any{
				{
					"type":      "button",
					"text":      map[string]any{"type": "plain_text", "text": "承認して作成"},
					"style":     "primary",
					"action_id": "calendar_draft_approve",
					"value": mustMarshalJSON(map[string]string{
						"action":      "approve",
						"workspaceId": draft.WorkspaceID,
						"userId":      draft.UserID,
						"draftId":     draft.DraftID,
						"channelId":   channelID,
						"messageTs":   messageTS,
					}),
				},
				{
					"type":      "button",
					"text":      map[string]any{"type": "plain_text", "text": "却下"},
					"style":     "danger",
					"action_id": "calendar_draft_reject",
					"value": mustMarshalJSON(map[string]string{
						"action":      "reject",
						"workspaceId": draft.WorkspaceID,
						"userId":      draft.UserID,
						"draftId":     draft.DraftID,
						"channelId":   channelID,
						"messageTs":   messageTS,
					}),
				},
			},
		},
	}
}

func formatCalendarCandidateTime(candidate calendar.DraftCandidate) string {
	if candidate.AllDay {
		if candidate.EndDate != "" && candidate.EndDate != candidate.StartDate {
			return candidate.StartDate + " - " + candidate.EndDate
		}
		return chooseString(candidate.StartDate, "日時未定")
	}
	if candidate.EndAt != "" {
		return candidate.StartAt + " - " + candidate.EndAt
	}
	return chooseString(candidate.StartAt, "日時未定")
}

func compareSlackTS(left string, right string) float64 {
	return parseSlackTS(left) - parseSlackTS(right)
}

func parseSlackTS(value string) float64 {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0
	}
	return parsed
}

func createSyntheticSlackTS() string {
	milliseconds := time.Now().UnixMilli()
	seconds := milliseconds / 1000
	micros := fmt.Sprintf("%03d", milliseconds%1000)
	return fmt.Sprintf("%d.%s000", seconds, micros)
}

func describeToolProgress(toolName string) string {
	switch toolName {
	case "search_memories":
		return "過去のメモを確認しています..."
	case "save_memory":
		return "覚えておく内容を整理しています..."
	case "list_tasks", "upsert_task", "mark_task_done":
		return "タスクを確認しています..."
	case "list_calendar_events", "find_free_busy", "create_calendar_draft", "list_calendar_drafts", "apply_calendar_draft", "discard_calendar_draft":
		return "カレンダーを確認しています..."
	default:
		return "処理しています..."
	}
}

func chooseString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func mustMarshalJSON(value any) string {
	payload, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(payload)
}

func min(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
