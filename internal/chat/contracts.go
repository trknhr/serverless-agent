package chat

type MessageRequest struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	Text        string `json:"text"`
	SessionID   string `json:"sessionId,omitempty"`
}
