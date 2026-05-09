package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/calendar"
	"github.com/trknhr/slack-ai-assistant/internal/config"
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
	"github.com/trknhr/slack-ai-assistant/internal/integrations"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/memory"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/secrets"
	"github.com/trknhr/slack-ai-assistant/internal/slack"
	"github.com/trknhr/slack-ai-assistant/internal/tasks"
	"github.com/trknhr/slack-ai-assistant/internal/tools"
)

const scheduleTimezone = "Asia/Tokyo"

type schedulerPayload struct {
	TaskID          string   `json:"taskId,omitempty"`
	WorkspaceID     string   `json:"workspaceId,omitempty"`
	OutputChannelID string   `json:"outputChannelId,omitempty"`
	Prompt          string   `json:"prompt,omitempty"`
	Name            string   `json:"name,omitempty"`
	VaultIDs        []string `json:"vaultIds,omitempty"`
	PersistTask     *bool    `json:"persistTask,omitempty"`
}

type schedulerEnvelope struct {
	Detail schedulerPayload `json:"detail"`
	Time   string           `json:"time,omitempty"`
}

var (
	schedulerEnv             = config.MustLoadSchedulerEnv()
	schedulerLogger          = logger.Default()
	schedulerAWSConfig, _    = awsconfig.LoadDefaultConfig(context.Background())
	schedulerSecretsProvider = secrets.New(secretsmanager.NewFromConfig(schedulerAWSConfig))
	schedulerAnthropicClient = anthropic.NewClient(func(ctx context.Context) (string, error) {
		return schedulerSecretsProvider.GetSecretString(ctx, schedulerEnv.AnthropicAPIKeySecretID)
	}, schedulerEnv.AnthropicManagedAgentsBeta)
	schedulerSlackClient = slack.NewWebClient(func(ctx context.Context) (string, error) {
		return schedulerSecretsProvider.GetSecretString(ctx, schedulerEnv.SlackBotTokenSecretID)
	})
	schedulerCalendarDraftRepository = repo.NewCalendarDraftRepository(dynamodb.NewFromConfig(schedulerAWSConfig), schedulerEnv.CalendarDraftsTableName)
	schedulerGoogleOAuthConnections  = repo.NewGoogleOAuthConnectionRepository(dynamodb.NewFromConfig(schedulerAWSConfig), schedulerEnv.GoogleOAuthConnectionsTable)
	schedulerSlackAuthClient         = slack.NewAuthClient(func(ctx context.Context) (string, error) {
		return schedulerSecretsProvider.GetSecretString(ctx, schedulerEnv.SlackBotTokenSecretID)
	})
	schedulerMemoryItemRepository = repo.NewMemoryItemRepository(dynamodb.NewFromConfig(schedulerAWSConfig), schedulerEnv.MemoryItemsTableName)
	schedulerTaskRepository       = repo.NewTaskRepository(dynamodb.NewFromConfig(schedulerAWSConfig), schedulerEnv.TaskTableName)
	schedulerTaskEventRepository  = repo.NewTaskEventRepository(dynamodb.NewFromConfig(schedulerAWSConfig), schedulerEnv.TaskEventsTableName)
	schedulerTaskStateRepository  = repo.NewTaskStateRepository(dynamodb.NewFromConfig(schedulerAWSConfig), schedulerEnv.TasksTableName)
	schedulerSessionRepository    = repo.NewSessionRepository(dynamodb.NewFromConfig(schedulerAWSConfig), schedulerEnv.SessionTableName)
	dateOnlyPattern               = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, payload json.RawMessage) error {
	detail, scheduledAtISO, err := parseSchedulerPayload(payload)
	if err != nil {
		return err
	}
	taskID := chooseString(detail.TaskID, "daily-summary")
	log := schedulerLogger.Child(logger.Fields{
		"component": "scheduled-agent-runner",
		"taskId":    taskID,
	})

	task, err := schedulerTaskRepository.Get(ctx, taskID)
	if err != nil {
		return err
	}
	if task == nil {
		task, err = buildFallbackTask(ctx, detail, taskID)
		if err != nil {
			return err
		}
		if detail.PersistTask == nil || *detail.PersistTask {
			if err := schedulerTaskRepository.Save(ctx, *task); err != nil {
				return err
			}
			log.Info("Persisted fallback scheduled task", logger.Fields{
				"outputChannelId": task.OutputChannelID,
				"workspaceId":     task.WorkspaceID,
			})
		}
	}
	if !task.Enabled {
		return fmt.Errorf("scheduled task %s is disabled", taskID)
	}

	autoClosedTasks, err := autoCloseExpiredTasks(ctx, task.WorkspaceID, scheduledAtISO, log)
	if err != nil {
		return err
	}

	var reusableSessionRecord *contracts.ThreadSessionRecord
	if task.ReuseSession {
		reusableSessionRecord, err = schedulerSessionRepository.FindByThread(ctx, task.WorkspaceID, task.OutputChannelID, task.TaskID)
		if err != nil {
			return err
		}
	}
	sessionID := ""
	if reusableSessionRecord != nil {
		sessionID = reusableSessionRecord.SessionID
	}
	if sessionID == "" {
		memoryResources := make([]anthropic.SessionMemoryResource, 0)
		if task.MemoryStoreID != "" {
			memoryResources = append(memoryResources, anthropic.SessionMemoryResource{
				MemoryStoreID: task.MemoryStoreID,
				Access:        "read_write",
				Prompt:        memory.ScheduledResourcePrompt,
			})
		}
		session, err := anthropic.CreateSession(ctx, schedulerAnthropicClient, anthropic.CreateSessionInput{
			AgentID:       chooseString(task.AgentIDOverride, schedulerEnv.AnthropicAgentID),
			EnvironmentID: chooseString(task.EnvironmentIDOverride, schedulerEnv.AnthropicEnvironmentID),
			VaultIDs:      resolveVaultIDs(task, detail),
			Title:         "Scheduled task " + task.TaskID,
			Metadata: map[string]string{
				"source":       "scheduler",
				"task_id":      task.TaskID,
				"workspace_id": task.WorkspaceID,
			},
			MemoryResources: memoryResources,
		})
		if err != nil {
			return err
		}
		sessionID = session.ID
	}

	seenEventIDs, err := collectScheduledSessionEventIDs(ctx, sessionID)
	if err != nil {
		return err
	}
	executor := tools.NewExecutor(tools.Repositories{
		MemoryItems:    schedulerMemoryItemRepository,
		Tasks:          schedulerTaskStateRepository,
		TaskEvents:     schedulerTaskEventRepository,
		CalendarDrafts: schedulerCalendarDraftRepository,
	}, tools.ToolExecutionContext{
		WorkspaceID: task.WorkspaceID,
		Logger:      log,
	}, tools.Integrations{
		GoogleCalendarProvider: func(ctx context.Context) (*calendar.GoogleCalendarClient, error) {
			return integrations.CreateUserGoogleCalendarClient(
				task.WorkspaceID,
				"",
				schedulerEnv.GoogleCalendarTimeZone,
				schedulerEnv.GoogleCalendarSecretID,
				schedulerEnv.GoogleOAuthStartURL,
				schedulerSecretsProvider,
				schedulerGoogleOAuthConnections,
			), nil
		},
		DefaultCalendarTimeZone: schedulerEnv.GoogleCalendarTimeZone,
	})

	if err := anthropic.SendUserMessage(ctx, schedulerAnthropicClient, sessionID, []anthropic.InputBlock{
		{
			"type": "text",
			"text": buildScheduledPrompt(task.Prompt, scheduledAtISO, autoClosedTasks),
		},
	}); err != nil {
		return err
	}

	completion, err := anthropic.WaitForCompletion(ctx, schedulerAnthropicClient, anthropic.WaitForCompletionInput{
		SessionID:     sessionID,
		SinceEventIDs: seenEventIDs,
		TimeoutMS:     schedulerEnv.AgentResponseTimeoutMS,
		OnCustomToolUse: func(ctx context.Context, event anthropic.SessionEvent) (*anthropic.ToolExecutionResult, error) {
			result, err := executor.Execute(ctx, event)
			if err != nil {
				return nil, err
			}
			return &anthropic.ToolExecutionResult{Content: result.Content, IsError: result.IsError}, nil
		},
	})
	if err != nil {
		return err
	}

	if _, err := schedulerSlackClient.PostMessage(ctx, slack.PostMessageInput{
		Channel: task.OutputChannelID,
		Text:    completion.Text,
	}); err != nil {
		return err
	}

	if task.ReuseSession {
		now := time.Now().UTC().Format(time.RFC3339)
		record := contracts.ThreadSessionRecord{
			WorkspaceID:   task.WorkspaceID,
			ChannelID:     task.OutputChannelID,
			ThreadTS:      task.TaskID,
			SessionID:     sessionID,
			MemoryStoreID: task.MemoryStoreID,
			CreatedAt:     now,
			LastUsedAt:    now,
		}
		if reusableSessionRecord != nil && reusableSessionRecord.CreatedAt != "" {
			record.CreatedAt = reusableSessionRecord.CreatedAt
		}
		if err := schedulerSessionRepository.Save(ctx, record); err != nil {
			return err
		}
	}

	log.Info("Scheduled task completed", logger.Fields{
		"sessionId":           sessionID,
		"status":              completion.Status,
		"autoClosedTaskCount": len(autoClosedTasks),
	})
	return nil
}

func parseSchedulerPayload(payload json.RawMessage) (schedulerPayload, string, error) {
	var envelope schedulerEnvelope
	if err := json.Unmarshal(payload, &envelope); err == nil && (envelope.Detail.TaskID != "" || envelope.Time != "" || envelope.Detail.OutputChannelID != "" || envelope.Detail.Prompt != "") {
		return envelope.Detail, chooseString(envelope.Time, time.Now().UTC().Format(time.RFC3339)), nil
	}
	var detail schedulerPayload
	if err := json.Unmarshal(payload, &detail); err != nil {
		return schedulerPayload{}, "", err
	}
	return detail, time.Now().UTC().Format(time.RFC3339), nil
}

func buildFallbackTask(ctx context.Context, detail schedulerPayload, taskID string) (*tasks.ScheduledTask, error) {
	outputChannelID := resolveOutputChannelID(detail.OutputChannelID)
	if outputChannelID == "" {
		return nil, fmt.Errorf("scheduled task is missing and no output channel is configured. Pass outputChannelId in the invoke payload or deploy with -c defaultScheduleChannel=C123.")
	}
	auth, err := schedulerSlackAuthClient.AuthTest(ctx)
	if err != nil {
		return nil, err
	}
	workspaceID := chooseString(detail.WorkspaceID, auth.TeamID)
	if workspaceID == "" {
		return nil, fmt.Errorf("unable to resolve workspaceId from Slack auth.test")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	return &tasks.ScheduledTask{
		TaskID:          taskID,
		Name:            chooseString(detail.Name, "Daily Summary"),
		Prompt:          chooseString(detail.Prompt, "Post a short smoke-test message saying the scheduled runner is working."),
		WorkspaceID:     workspaceID,
		OutputChannelID: outputChannelID,
		Enabled:         true,
		ReuseSession:    false,
		VaultIDs:        resolveVaultIDs(nil, detail),
		CreatedAt:       now,
		UpdatedAt:       now,
	}, nil
}

func resolveOutputChannelID(payloadChannelID string) string {
	if payloadChannelID != "" {
		return payloadChannelID
	}
	if schedulerEnv.DefaultScheduleChannel != "" && schedulerEnv.DefaultScheduleChannel != "C_PLACEHOLDER" {
		return schedulerEnv.DefaultScheduleChannel
	}
	return ""
}

func resolveVaultIDs(task *tasks.ScheduledTask, detail schedulerPayload) []string {
	if len(detail.VaultIDs) > 0 {
		return detail.VaultIDs
	}
	if task != nil && len(task.VaultIDs) > 0 {
		return task.VaultIDs
	}
	return schedulerEnv.AnthropicVaultIDs
}

func autoCloseExpiredTasks(ctx context.Context, workspaceID string, scheduledAtISO string, log *logger.Logger) ([]tasks.State, error) {
	scheduledAt, err := time.Parse(time.RFC3339, scheduledAtISO)
	if err != nil {
		scheduledAt = time.Now()
	}
	today, _, _ := formatInTimeZone(scheduledAt, scheduleTimezone)
	candidates, err := schedulerTaskStateRepository.List(ctx, workspaceID, []tasks.Status{tasks.StatusOpen, tasks.StatusInProgress}, 50, "", "")
	if err != nil {
		return nil, err
	}
	expired := make([]tasks.State, 0)
	for _, task := range candidates {
		if isExpiredTaskDueAt(task.DueAt, scheduledAt, today) {
			closed, err := schedulerTaskStateRepository.Upsert(ctx, tasks.State{
				WorkspaceID:     task.WorkspaceID,
				TaskID:          task.TaskID,
				Title:           task.Title,
				Description:     task.Description,
				Status:          tasks.StatusCancelled,
				DueAt:           task.DueAt,
				Priority:        task.Priority,
				OwnerUserID:     task.OwnerUserID,
				CalendarEventID: task.CalendarEventID,
				SourceType:      task.SourceType,
				SourceRef:       task.SourceRef,
				Metadata: mergeMetadata(task.Metadata, map[string]any{
					"autoClosedReason": "expired",
					"autoClosedAt":     scheduledAt.UTC().Format(time.RFC3339),
				}),
				CreatedAt: task.CreatedAt,
			})
			if err != nil {
				return nil, err
			}
			expired = append(expired, *closed)
			if _, err := schedulerTaskEventRepository.Save(ctx, tasks.EventRecord{
				TaskID: closed.TaskID,
				Type:   "updated",
				Payload: map[string]any{
					"status":             closed.Status,
					"due_at":             closed.DueAt,
					"auto_closed_reason": "expired",
				},
			}); err != nil {
				return nil, err
			}
		}
	}
	if len(expired) > 0 {
		taskIDs := make([]string, 0, len(expired))
		for _, task := range expired {
			taskIDs = append(taskIDs, task.TaskID)
		}
		log.Info("Auto-closed expired tasks", logger.Fields{"count": len(expired), "taskIds": taskIDs})
	}
	return expired, nil
}

func isExpiredTaskDueAt(dueAt string, now time.Time, today string) bool {
	if dueAt == "" {
		return false
	}
	if dateOnlyPattern.MatchString(dueAt) {
		return dueAt < today
	}
	dueDate, err := time.Parse(time.RFC3339, dueAt)
	if err != nil {
		return false
	}
	return dueDate.Before(now)
}

func buildScheduledPrompt(basePrompt string, scheduledAtISO string, autoClosedTasks []tasks.State) string {
	date, err := time.Parse(time.RFC3339, scheduledAtISO)
	if err != nil {
		return basePrompt
	}
	datePart, timePart, weekday := formatInTimeZone(date, scheduleTimezone)
	lines := []string{
		"Scheduling context:",
		fmt.Sprintf("- Current scheduled run time: %s %s (%s)", datePart, timePart, weekday),
		fmt.Sprintf("- Time zone: %s", scheduleTimezone),
		"- Interpret relative dates such as today, yesterday, and tomorrow using this time zone, not UTC.",
	}
	if len(autoClosedTasks) > 0 {
		lines = append(lines, "- The system already closed these expired tasks before this run. Mention this in one short sentence, and do not list them as current or upcoming tasks.")
		for _, task := range autoClosedTasks {
			line := "  - " + task.Title
			if task.DueAt != "" {
				line += " (due: " + task.DueAt + ")"
			}
			lines = append(lines, line)
		}
	}
	lines = append(lines, "", basePrompt)
	return strings.Join(lines, "\n")
}

func formatInTimeZone(date time.Time, timeZone string) (string, string, string) {
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		location = time.UTC
	}
	local := date.In(location)
	return local.Format("2006-01-02"), local.Format("15:04:05"), local.Weekday().String()
}

func collectScheduledSessionEventIDs(ctx context.Context, sessionID string) (map[string]struct{}, error) {
	events, err := schedulerAnthropicClient.ListSessionEvents(ctx, sessionID, "asc", 0)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	for _, event := range events {
		seen[event.ID] = struct{}{}
	}
	return seen, nil
}

func chooseString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func mergeMetadata(existing map[string]any, updates map[string]any) map[string]any {
	if len(existing) == 0 && len(updates) == 0 {
		return nil
	}
	merged := make(map[string]any, len(existing)+len(updates))
	for key, value := range existing {
		merged[key] = value
	}
	for key, value := range updates {
		merged[key] = value
	}
	return merged
}
