package imports

type CreateUploadRequest struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	FileName    string `json:"fileName"`
	MimeType    string `json:"mimeType"`
	FileSize    int64  `json:"fileSize"`
	Checksum    string `json:"checksum"`
	SourcePath  string `json:"sourcePath,omitempty"`
}

type QueueImportRequest struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	SourceID    string `json:"sourceId"`
	Prompt      string `json:"prompt,omitempty"`
}

type IngestMarkdownRequest struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	Title       string `json:"title"`
	Markdown    string `json:"markdown"`
	SourcePath  string `json:"sourcePath,omitempty"`
	Prompt      string `json:"prompt,omitempty"`
}

type QueueMessage struct {
	CorrelationID string `json:"correlationId"`
	WorkspaceID   string `json:"workspaceId"`
	UserID        string `json:"userId"`
	SourceID      string `json:"sourceId"`
	Operation     string `json:"operation,omitempty"`
	Prompt        string `json:"prompt,omitempty"`
	QueuedAt      string `json:"queuedAt"`
}
