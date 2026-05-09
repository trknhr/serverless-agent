package contracts

type SlackSource string

const (
	SlackSourceAppMention SlackSource = "app_mention"
	SlackSourceDM         SlackSource = "dm"
	SlackSourceThread     SlackSource = "thread_reply"
)

type ContextScope string

const (
	ContextScopeChannelTopLevel ContextScope = "channel_top_level"
	ContextScopeThread          ContextScope = "thread"
)

type SlackFileReference struct {
	ID                 string `json:"id"`
	Name               string `json:"name,omitempty"`
	Title              string `json:"title,omitempty"`
	Mimetype           string `json:"mimetype,omitempty"`
	FileAccess         string `json:"fileAccess,omitempty"`
	URLPrivate         string `json:"urlPrivate,omitempty"`
	URLPrivateDownload string `json:"urlPrivateDownload,omitempty"`
	Permalink          string `json:"permalink,omitempty"`
	IsExternal         *bool  `json:"isExternal,omitempty"`
	ExternalURL        string `json:"externalUrl,omitempty"`
	Size               *int64 `json:"size,omitempty"`
}

type SlackQueueMessage struct {
	CorrelationID  string               `json:"correlationId"`
	EventID        string               `json:"eventId"`
	WorkspaceID    string               `json:"workspaceId"`
	ChannelID      string               `json:"channelId"`
	ConversationTS string               `json:"conversationTs"`
	ReplyThreadTS  string               `json:"replyThreadTs,omitempty"`
	MessageTS      string               `json:"messageTs"`
	UserID         string               `json:"userId"`
	Text           string               `json:"text"`
	Source         SlackSource          `json:"source"`
	ContextScope   ContextScope         `json:"contextScope"`
	ReceivedAt     string               `json:"receivedAt"`
	Files          []SlackFileReference `json:"files"`
}

type UserMemoryRecord struct {
	WorkspaceID    string `json:"workspaceId"`
	UserID         string `json:"userId"`
	MemoryStoreID  string `json:"memoryStoreId"`
	ProfileSummary string `json:"profileSummary,omitempty"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

type ThreadSessionRecord struct {
	WorkspaceID   string `json:"workspaceId"`
	ChannelID     string `json:"channelId"`
	ThreadTS      string `json:"threadTs"`
	SessionID     string `json:"sessionId"`
	MemoryStoreID string `json:"memoryStoreId,omitempty"`
	CreatedAt     string `json:"createdAt"`
	LastUsedAt    string `json:"lastUsedAt"`
}

type ConversationSessionRecord struct {
	WorkspaceID     string `json:"workspaceId"`
	ChannelID       string `json:"channelId"`
	ConversationTS  string `json:"conversationTs"`
	ClaudeSessionID string `json:"claudeSessionId"`
	MemoryStoreID   string `json:"memoryStoreId,omitempty"`
	CreatedAt       string `json:"createdAt"`
	LastUsedAt      string `json:"lastUsedAt"`
}

type ConversationTurnRecord struct {
	TurnID         string       `json:"turnId"`
	WorkspaceID    string       `json:"workspaceId"`
	ChannelID      string       `json:"channelId"`
	ConversationTS string       `json:"conversationTs"`
	ContextScope   ContextScope `json:"contextScope"`
	Role           string       `json:"role"`
	Source         string       `json:"source"`
	SourceEvent    string       `json:"sourceEvent"`
	ThreadTS       string       `json:"threadTs,omitempty"`
	MessageTS      string       `json:"messageTs"`
	TurnTS         string       `json:"turnTs"`
	UserID         string       `json:"userId,omitempty"`
	Text           string       `json:"text"`
	CreatedAt      string       `json:"createdAt"`
}
