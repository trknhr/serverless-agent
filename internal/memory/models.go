package memory

type Item struct {
	WorkspaceID     string         `dynamodbav:"workspaceId"`
	MemoryID        string         `dynamodbav:"memoryId"`
	EntityKey       string         `dynamodbav:"entityKey,omitempty"`
	Text            string         `dynamodbav:"text"`
	Attributes      map[string]any `dynamodbav:"attributes,omitempty"`
	Tags            []string       `dynamodbav:"tags,omitempty"`
	Importance      *float64       `dynamodbav:"importance,omitempty"`
	SourceType      string         `dynamodbav:"sourceType,omitempty"`
	SourceRef       string         `dynamodbav:"sourceRef,omitempty"`
	CreatedByUserID string         `dynamodbav:"createdByUserId,omitempty"`
	CreatedAt       string         `dynamodbav:"createdAt"`
	UpdatedAt       string         `dynamodbav:"updatedAt"`
}

type ChannelItem struct {
	WorkspaceID     string         `dynamodbav:"workspaceId"`
	ChannelID       string         `dynamodbav:"channelId"`
	MemoryID        string         `dynamodbav:"memoryId"`
	Text            string         `dynamodbav:"text"`
	EntityKey       string         `dynamodbav:"entityKey,omitempty"`
	Attributes      map[string]any `dynamodbav:"attributes,omitempty"`
	Tags            []string       `dynamodbav:"tags,omitempty"`
	Importance      *float64       `dynamodbav:"importance,omitempty"`
	Status          string         `dynamodbav:"status"`
	Origin          string         `dynamodbav:"origin"`
	SourceType      string         `dynamodbav:"sourceType,omitempty"`
	SourceRef       string         `dynamodbav:"sourceRef,omitempty"`
	CreatedByUserID string         `dynamodbav:"createdByUserId,omitempty"`
	CreatedAt       string         `dynamodbav:"createdAt"`
	UpdatedAt       string         `dynamodbav:"updatedAt"`
}

type UserPreferenceItem struct {
	WorkspaceID     string         `dynamodbav:"workspaceId"`
	UserID          string         `dynamodbav:"userId"`
	PreferenceID    string         `dynamodbav:"preferenceId"`
	Text            string         `dynamodbav:"text"`
	PreferenceKey   string         `dynamodbav:"preferenceKey,omitempty"`
	EntityKey       string         `dynamodbav:"entityKey,omitempty"`
	Attributes      map[string]any `dynamodbav:"attributes,omitempty"`
	Tags            []string       `dynamodbav:"tags,omitempty"`
	Importance      *float64       `dynamodbav:"importance,omitempty"`
	Origin          string         `dynamodbav:"origin"`
	SourceType      string         `dynamodbav:"sourceType,omitempty"`
	SourceRef       string         `dynamodbav:"sourceRef,omitempty"`
	CreatedByUserID string         `dynamodbav:"createdByUserId,omitempty"`
	CreatedAt       string         `dynamodbav:"createdAt"`
	UpdatedAt       string         `dynamodbav:"updatedAt"`
}
