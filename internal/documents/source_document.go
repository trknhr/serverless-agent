package documents

type SourceDocument struct {
	SourceID                  string   `dynamodbav:"sourceId"`
	WorkspaceID               string   `dynamodbav:"workspaceId"`
	SourceType                string   `dynamodbav:"sourceType"`
	SourceRef                 string   `dynamodbav:"sourceRef"`
	Title                     string   `dynamodbav:"title"`
	SlackFileID               string   `dynamodbav:"slackFileId,omitempty"`
	SlackPermalink            string   `dynamodbav:"slackPermalink,omitempty"`
	ChannelID                 string   `dynamodbav:"channelId,omitempty"`
	ThreadTS                  string   `dynamodbav:"threadTs,omitempty"`
	MessageTS                 string   `dynamodbav:"messageTs,omitempty"`
	UploadedByUserID          string   `dynamodbav:"uploadedByUserId,omitempty"`
	MimeType                  string   `dynamodbav:"mimeType,omitempty"`
	Size                      *int64   `dynamodbav:"size,omitempty"`
	Checksum                  string   `dynamodbav:"checksum,omitempty"`
	S3Bucket                  string   `dynamodbav:"s3Bucket,omitempty"`
	S3Key                     string   `dynamodbav:"s3Key,omitempty"`
	Status                    string   `dynamodbav:"status"`
	Summary                   string   `dynamodbav:"summary,omitempty"`
	ImportedTaskIDs           []string `dynamodbav:"importedTaskIds,omitempty"`
	SavedMemoryIDs            []string `dynamodbav:"savedMemoryIds,omitempty"`
	ErrorMessage              string   `dynamodbav:"errorMessage,omitempty"`
	ExtractionStatus          string   `dynamodbav:"extractionStatus,omitempty"`
	ExtractionErrorMessage    string   `dynamodbav:"extractionErrorMessage,omitempty"`
	ExtractedMarkdownS3Bucket string   `dynamodbav:"extractedMarkdownS3Bucket,omitempty"`
	ExtractedMarkdownS3Key    string   `dynamodbav:"extractedMarkdownS3Key,omitempty"`
	ExtractedMarkdownChecksum string   `dynamodbav:"extractedMarkdownChecksum,omitempty"`
	ExtractedMarkdownSize     *int64   `dynamodbav:"extractedMarkdownSize,omitempty"`
	CreatedAt                 string   `dynamodbav:"createdAt"`
	UpdatedAt                 string   `dynamodbav:"updatedAt"`
}
