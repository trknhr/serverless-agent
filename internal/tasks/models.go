package tasks

type Status string

const (
	StatusOpen       Status = "open"
	StatusInProgress Status = "in_progress"
	StatusDone       Status = "done"
	StatusCancelled  Status = "cancelled"
)

type State struct {
	WorkspaceID       string         `dynamodbav:"workspaceId"`
	TaskID            string         `dynamodbav:"taskId"`
	Title             string         `dynamodbav:"title"`
	Description       string         `dynamodbav:"description,omitempty"`
	Status            Status         `dynamodbav:"status"`
	DueAt             string         `dynamodbav:"dueAt,omitempty"`
	Priority          string         `dynamodbav:"priority,omitempty"`
	OwnerUserID       string         `dynamodbav:"ownerUserId,omitempty"`
	CalendarEventID   string         `dynamodbav:"calendarEventId,omitempty"`
	SourceType        string         `dynamodbav:"sourceType,omitempty"`
	SourceRef         string         `dynamodbav:"sourceRef,omitempty"`
	Metadata          map[string]any `dynamodbav:"metadata,omitempty"`
	CompletedAt       string         `dynamodbav:"completedAt,omitempty"`
	CompletedByUserID string         `dynamodbav:"completedByUserId,omitempty"`
	CreatedAt         string         `dynamodbav:"createdAt"`
	UpdatedAt         string         `dynamodbav:"updatedAt"`
}

type EventRecord struct {
	TaskID    string         `dynamodbav:"taskId"`
	EventID   string         `dynamodbav:"eventId"`
	Type      string         `dynamodbav:"type"`
	Payload   map[string]any `dynamodbav:"payload,omitempty"`
	CreatedAt string         `dynamodbav:"createdAt"`
}

type ScheduledTask struct {
	TaskID                string   `dynamodbav:"taskId"`
	Name                  string   `dynamodbav:"name"`
	Prompt                string   `dynamodbav:"prompt"`
	WorkspaceID           string   `dynamodbav:"workspaceId"`
	OutputChannelID       string   `dynamodbav:"outputChannelId"`
	Enabled               bool     `dynamodbav:"enabled"`
	ReuseSession          bool     `dynamodbav:"reuseSession"`
	MemoryStoreID         string   `dynamodbav:"memoryStoreId,omitempty"`
	VaultIDs              []string `dynamodbav:"vaultIds,omitempty"`
	AgentIDOverride       string   `dynamodbav:"agentIdOverride,omitempty"`
	EnvironmentIDOverride string   `dynamodbav:"environmentIdOverride,omitempty"`
	CreatedAt             string   `dynamodbav:"createdAt"`
	UpdatedAt             string   `dynamodbav:"updatedAt"`
}

func BuildScheduledTaskPK(taskID string) string {
	return "TASK#" + taskID
}
