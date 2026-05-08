package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

var trueValues = map[string]struct{}{
	"1":    {},
	"true": {},
	"yes":  {},
	"on":   {},
}

type BaseEnv struct {
	SessionTableName              string
	ConversationSessionsTableName string
	ConversationTurnsTableName    string
	UserMemoryTableName           string
	MemoryItemsTableName          string
	TasksTableName                string
	TaskEventsTableName           string
	ProcessedEventsTableName      string
	TaskTableName                 string
	SlackSigningSecretSecretID    string
	SlackBotTokenSecretID         string
	AnthropicAPIKeySecretID       string
	AnthropicAgentID              string
	AnthropicEnvironmentID        string
	AnthropicVaultIDs             []string
	AnthropicManagedAgentsBeta    string
	EventDedupTTLSeconds          int
	AgentResponseTimeoutMS        int
	TopLevelContextTurnLimit      int
	MaxSlackFileBytes             int
	EnableUserMemory              bool
	DefaultScheduleChannel        string
}

type IngressEnv struct {
	BaseEnv
	SlackQueueURL string
}

type ToolRuntimeEnv struct {
	BaseEnv
	CalendarDraftsTableName     string
	GoogleCalendarSecretID      string
	GoogleOAuthConnectionsTable string
	GoogleOAuthStartURL         string
	GoogleCalendarTimeZone      string
}

type WorkerEnv struct {
	ToolRuntimeEnv
	SourceDocumentsTableName     string
	SlackAttachmentArchiveBucket string
}

type ImportAPIEnv struct {
	BaseEnv
	SourceDocumentsTableName string
	DocumentImportQueueURL   string
	DocumentArchiveBucket    string
}

type ImportWorkerEnv struct {
	ToolRuntimeEnv
	SourceDocumentsTableName string
	DocumentArchiveBucket    string
}

type ChatAPIEnv struct {
	ToolRuntimeEnv
}

type SchedulerEnv struct {
	ToolRuntimeEnv
}

type SlackInteractionsEnv struct {
	ToolRuntimeEnv
}

type GoogleOAuthEnv struct {
	BaseEnv
	GoogleCalendarSecretID      string
	GoogleOAuthConnectionsTable string
	GoogleCalendarTimeZone      string
}

func MustLoadIngressEnv() IngressEnv {
	base := mustLoadBaseEnv()
	return IngressEnv{
		BaseEnv:       base,
		SlackQueueURL: mustGetRequired("SLACK_QUEUE_URL"),
	}
}

func MustLoadGoogleOAuthEnv() GoogleOAuthEnv {
	base := mustLoadBaseEnv()
	return GoogleOAuthEnv{
		BaseEnv:                     base,
		GoogleCalendarSecretID:      mustGetRequired("GOOGLE_CALENDAR_SECRET_ID"),
		GoogleOAuthConnectionsTable: mustGetRequired("GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME"),
		GoogleCalendarTimeZone:      getWithDefault("GOOGLE_CALENDAR_TIME_ZONE", "Asia/Tokyo"),
	}
}

func MustLoadImportAPIEnv() ImportAPIEnv {
	base := mustLoadBaseEnv()
	return ImportAPIEnv{
		BaseEnv:                  base,
		SourceDocumentsTableName: mustGetRequired("SOURCE_DOCUMENTS_TABLE_NAME"),
		DocumentImportQueueURL:   mustGetRequired("DOCUMENT_IMPORT_QUEUE_URL"),
		DocumentArchiveBucket:    mustGetRequired("DOCUMENT_ARCHIVE_BUCKET_NAME"),
	}
}

func MustLoadSlackInteractionsEnv() SlackInteractionsEnv {
	base := mustLoadBaseEnv()
	return SlackInteractionsEnv{
		ToolRuntimeEnv: ToolRuntimeEnv{
			BaseEnv:                     base,
			CalendarDraftsTableName:     mustGetRequired("CALENDAR_DRAFTS_TABLE_NAME"),
			GoogleCalendarSecretID:      mustGetRequired("GOOGLE_CALENDAR_SECRET_ID"),
			GoogleOAuthConnectionsTable: mustGetRequired("GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME"),
			GoogleOAuthStartURL:         strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_START_URL")),
			GoogleCalendarTimeZone:      getWithDefault("GOOGLE_CALENDAR_TIME_ZONE", "Asia/Tokyo"),
		},
	}
}

func MustLoadChatAPIEnv() ChatAPIEnv {
	base := mustLoadBaseEnv()
	return ChatAPIEnv{
		ToolRuntimeEnv: ToolRuntimeEnv{
			BaseEnv:                     base,
			CalendarDraftsTableName:     mustGetRequired("CALENDAR_DRAFTS_TABLE_NAME"),
			GoogleCalendarSecretID:      mustGetRequired("GOOGLE_CALENDAR_SECRET_ID"),
			GoogleOAuthConnectionsTable: mustGetRequired("GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME"),
			GoogleOAuthStartURL:         strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_START_URL")),
			GoogleCalendarTimeZone:      getWithDefault("GOOGLE_CALENDAR_TIME_ZONE", "Asia/Tokyo"),
		},
	}
}

func MustLoadImportWorkerEnv() ImportWorkerEnv {
	base := mustLoadBaseEnv()
	return ImportWorkerEnv{
		ToolRuntimeEnv: ToolRuntimeEnv{
			BaseEnv:                     base,
			CalendarDraftsTableName:     mustGetRequired("CALENDAR_DRAFTS_TABLE_NAME"),
			GoogleCalendarSecretID:      mustGetRequired("GOOGLE_CALENDAR_SECRET_ID"),
			GoogleOAuthConnectionsTable: mustGetRequired("GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME"),
			GoogleOAuthStartURL:         strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_START_URL")),
			GoogleCalendarTimeZone:      getWithDefault("GOOGLE_CALENDAR_TIME_ZONE", "Asia/Tokyo"),
		},
		SourceDocumentsTableName: mustGetRequired("SOURCE_DOCUMENTS_TABLE_NAME"),
		DocumentArchiveBucket:    mustGetRequired("DOCUMENT_ARCHIVE_BUCKET_NAME"),
	}
}

func MustLoadSchedulerEnv() SchedulerEnv {
	base := mustLoadBaseEnv()
	return SchedulerEnv{
		ToolRuntimeEnv: ToolRuntimeEnv{
			BaseEnv:                     base,
			CalendarDraftsTableName:     mustGetRequired("CALENDAR_DRAFTS_TABLE_NAME"),
			GoogleCalendarSecretID:      mustGetRequired("GOOGLE_CALENDAR_SECRET_ID"),
			GoogleOAuthConnectionsTable: mustGetRequired("GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME"),
			GoogleOAuthStartURL:         strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_START_URL")),
			GoogleCalendarTimeZone:      getWithDefault("GOOGLE_CALENDAR_TIME_ZONE", "Asia/Tokyo"),
		},
	}
}

func MustLoadWorkerEnv() WorkerEnv {
	base := mustLoadBaseEnv()
	return WorkerEnv{
		ToolRuntimeEnv: ToolRuntimeEnv{
			BaseEnv:                     base,
			CalendarDraftsTableName:     mustGetRequired("CALENDAR_DRAFTS_TABLE_NAME"),
			GoogleCalendarSecretID:      mustGetRequired("GOOGLE_CALENDAR_SECRET_ID"),
			GoogleOAuthConnectionsTable: mustGetRequired("GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME"),
			GoogleOAuthStartURL:         strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_START_URL")),
			GoogleCalendarTimeZone:      getWithDefault("GOOGLE_CALENDAR_TIME_ZONE", "Asia/Tokyo"),
		},
		SourceDocumentsTableName:     mustGetRequired("SOURCE_DOCUMENTS_TABLE_NAME"),
		SlackAttachmentArchiveBucket: mustGetRequired("SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME"),
	}
}

func mustLoadBaseEnv() BaseEnv {
	env, err := loadBaseEnv()
	if err != nil {
		panic(err)
	}
	return env
}

func loadBaseEnv() (BaseEnv, error) {
	eventDedupTTLSeconds, err := parsePositiveInt("EVENT_DEDUP_TTL_SECONDS", 86400)
	if err != nil {
		return BaseEnv{}, err
	}

	agentResponseTimeoutMS, err := parsePositiveInt("AGENT_RESPONSE_TIMEOUT_MS", 120000)
	if err != nil {
		return BaseEnv{}, err
	}

	topLevelContextTurnLimit, err := parsePositiveInt("TOP_LEVEL_CONTEXT_TURN_LIMIT", 10)
	if err != nil {
		return BaseEnv{}, err
	}

	maxSlackFileBytes, err := parsePositiveInt("MAX_SLACK_FILE_BYTES", 10000000)
	if err != nil {
		return BaseEnv{}, err
	}

	return BaseEnv{
		SessionTableName:              mustGetRequired("SESSION_TABLE_NAME"),
		ConversationSessionsTableName: mustGetRequired("CONVERSATION_SESSIONS_TABLE_NAME"),
		ConversationTurnsTableName:    mustGetRequired("CONVERSATION_TURNS_TABLE_NAME"),
		UserMemoryTableName:           mustGetRequired("USER_MEMORY_TABLE_NAME"),
		MemoryItemsTableName:          mustGetRequired("MEMORY_ITEMS_TABLE_NAME"),
		TasksTableName:                mustGetRequired("TASKS_TABLE_NAME"),
		TaskEventsTableName:           mustGetRequired("TASK_EVENTS_TABLE_NAME"),
		ProcessedEventsTableName:      mustGetRequired("PROCESSED_EVENTS_TABLE_NAME"),
		TaskTableName:                 mustGetRequired("TASK_TABLE_NAME"),
		SlackSigningSecretSecretID:    mustGetRequired("SLACK_SIGNING_SECRET_SECRET_ID"),
		SlackBotTokenSecretID:         mustGetRequired("SLACK_BOT_TOKEN_SECRET_ID"),
		AnthropicAPIKeySecretID:       mustGetRequired("ANTHROPIC_API_KEY_SECRET_ID"),
		AnthropicAgentID:              mustGetRequired("ANTHROPIC_AGENT_ID"),
		AnthropicEnvironmentID:        mustGetRequired("ANTHROPIC_ENVIRONMENT_ID"),
		AnthropicVaultIDs:             parseCSV(os.Getenv("ANTHROPIC_VAULT_IDS")),
		AnthropicManagedAgentsBeta:    getWithDefault("ANTHROPIC_MANAGED_AGENTS_BETA", "managed-agents-2026-04-01"),
		EventDedupTTLSeconds:          eventDedupTTLSeconds,
		AgentResponseTimeoutMS:        agentResponseTimeoutMS,
		TopLevelContextTurnLimit:      topLevelContextTurnLimit,
		MaxSlackFileBytes:             maxSlackFileBytes,
		EnableUserMemory:              parseBool(os.Getenv("ENABLE_USER_MEMORY")),
		DefaultScheduleChannel:        mustGetRequired("DEFAULT_SCHEDULE_CHANNEL"),
	}, nil
}

func mustGetRequired(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		panic(fmt.Errorf("missing required env %s", name))
	}
	return value
}

func getWithDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func parsePositiveInt(name string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}

	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("invalid positive integer env %s=%q", name, raw)
	}
	return value, nil
}

func parseBool(raw string) bool {
	if raw == "" {
		return false
	}
	_, ok := trueValues[strings.ToLower(strings.TrimSpace(raw))]
	return ok
}

func parseCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}

	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			values = append(values, trimmed)
		}
	}
	return values
}
