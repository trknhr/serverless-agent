package calendar

type DraftCandidate struct {
	CandidateID           string   `dynamodbav:"candidateId"`
	Summary               string   `dynamodbav:"summary"`
	Description           string   `dynamodbav:"description,omitempty"`
	Location              string   `dynamodbav:"location,omitempty"`
	AllDay                bool     `dynamodbav:"allDay"`
	StartDate             string   `dynamodbav:"startDate,omitempty"`
	EndDate               string   `dynamodbav:"endDate,omitempty"`
	StartAt               string   `dynamodbav:"startAt,omitempty"`
	EndAt                 string   `dynamodbav:"endAt,omitempty"`
	TimeZone              string   `dynamodbav:"timeZone,omitempty"`
	SourceText            string   `dynamodbav:"sourceText,omitempty"`
	Confidence            *float64 `dynamodbav:"confidence,omitempty"`
	DedupeKey             string   `dynamodbav:"dedupeKey,omitempty"`
	Status                string   `dynamodbav:"status"`
	CalendarEventID       string   `dynamodbav:"calendarEventId,omitempty"`
	CalendarEventHTMLLink string   `dynamodbav:"calendarEventHtmlLink,omitempty"`
	AppliedAt             string   `dynamodbav:"appliedAt,omitempty"`
	RejectedAt            string   `dynamodbav:"rejectedAt,omitempty"`
}

type Draft struct {
	DraftID       string           `dynamodbav:"draftId"`
	WorkspaceID   string           `dynamodbav:"workspaceId"`
	UserID        string           `dynamodbav:"userId,omitempty"`
	Title         string           `dynamodbav:"title"`
	Notes         string           `dynamodbav:"notes,omitempty"`
	SourceID      string           `dynamodbav:"sourceId,omitempty"`
	SourceRef     string           `dynamodbav:"sourceRef,omitempty"`
	CalendarID    string           `dynamodbav:"calendarId,omitempty"`
	Status        string           `dynamodbav:"status"`
	Candidates    []DraftCandidate `dynamodbav:"candidates"`
	CreatedAt     string           `dynamodbav:"createdAt"`
	UpdatedAt     string           `dynamodbav:"updatedAt"`
	ApprovedAt    string           `dynamodbav:"approvedAt,omitempty"`
	RejectedAt    string           `dynamodbav:"rejectedAt,omitempty"`
	LastAppliedAt string           `dynamodbav:"lastAppliedAt,omitempty"`
}
