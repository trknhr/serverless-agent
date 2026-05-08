package repo

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/trknhr/slack-ai-assistant/internal/documents"
)

type sourceDocumentRecord struct {
	PK                        string   `dynamodbav:"pk"`
	SK                        string   `dynamodbav:"sk"`
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

type SourceDocumentRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewSourceDocumentRepository(client *dynamodb.Client, tableName string) *SourceDocumentRepository {
	return &SourceDocumentRepository{client: client, tableName: tableName}
}

func (r *SourceDocumentRepository) Save(ctx context.Context, document documents.SourceDocument) (*documents.SourceDocument, error) {
	record := sourceDocumentRecord{
		PK:                        "WORKSPACE#" + document.WorkspaceID,
		SK:                        "SOURCE#" + document.SourceID,
		SourceID:                  document.SourceID,
		WorkspaceID:               document.WorkspaceID,
		SourceType:                document.SourceType,
		SourceRef:                 document.SourceRef,
		Title:                     document.Title,
		SlackFileID:               document.SlackFileID,
		SlackPermalink:            document.SlackPermalink,
		ChannelID:                 document.ChannelID,
		ThreadTS:                  document.ThreadTS,
		MessageTS:                 document.MessageTS,
		UploadedByUserID:          document.UploadedByUserID,
		MimeType:                  document.MimeType,
		Size:                      document.Size,
		Checksum:                  document.Checksum,
		S3Bucket:                  document.S3Bucket,
		S3Key:                     document.S3Key,
		Status:                    document.Status,
		Summary:                   document.Summary,
		ImportedTaskIDs:           document.ImportedTaskIDs,
		SavedMemoryIDs:            document.SavedMemoryIDs,
		ErrorMessage:              document.ErrorMessage,
		ExtractionStatus:          document.ExtractionStatus,
		ExtractionErrorMessage:    document.ExtractionErrorMessage,
		ExtractedMarkdownS3Bucket: document.ExtractedMarkdownS3Bucket,
		ExtractedMarkdownS3Key:    document.ExtractedMarkdownS3Key,
		ExtractedMarkdownChecksum: document.ExtractedMarkdownChecksum,
		ExtractedMarkdownSize:     document.ExtractedMarkdownSize,
		CreatedAt:                 document.CreatedAt,
		UpdatedAt:                 document.UpdatedAt,
	}
	itemMap, err := attributevalue.MarshalMap(record)
	if err != nil {
		return nil, err
	}
	_, err = r.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(r.tableName),
		Item:      itemMap,
	})
	if err != nil {
		return nil, err
	}
	return &document, nil
}

func (r *SourceDocumentRepository) Get(ctx context.Context, workspaceID string, sourceID string) (*documents.SourceDocument, error) {
	key, err := attributevalue.MarshalMap(map[string]string{
		"pk": "WORKSPACE#" + workspaceID,
		"sk": "SOURCE#" + sourceID,
	})
	if err != nil {
		return nil, err
	}
	output, err := r.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(r.tableName),
		Key:       key,
	})
	if err != nil {
		return nil, err
	}
	if len(output.Item) == 0 {
		return nil, nil
	}

	var record sourceDocumentRecord
	if err := attributevalue.UnmarshalMap(output.Item, &record); err != nil {
		return nil, err
	}
	document := documents.SourceDocument{
		SourceID:                  record.SourceID,
		WorkspaceID:               record.WorkspaceID,
		SourceType:                record.SourceType,
		SourceRef:                 record.SourceRef,
		Title:                     record.Title,
		SlackFileID:               record.SlackFileID,
		SlackPermalink:            record.SlackPermalink,
		ChannelID:                 record.ChannelID,
		ThreadTS:                  record.ThreadTS,
		MessageTS:                 record.MessageTS,
		UploadedByUserID:          record.UploadedByUserID,
		MimeType:                  record.MimeType,
		Size:                      record.Size,
		Checksum:                  record.Checksum,
		S3Bucket:                  record.S3Bucket,
		S3Key:                     record.S3Key,
		Status:                    record.Status,
		Summary:                   record.Summary,
		ImportedTaskIDs:           record.ImportedTaskIDs,
		SavedMemoryIDs:            record.SavedMemoryIDs,
		ErrorMessage:              record.ErrorMessage,
		ExtractionStatus:          record.ExtractionStatus,
		ExtractionErrorMessage:    record.ExtractionErrorMessage,
		ExtractedMarkdownS3Bucket: record.ExtractedMarkdownS3Bucket,
		ExtractedMarkdownS3Key:    record.ExtractedMarkdownS3Key,
		ExtractedMarkdownChecksum: record.ExtractedMarkdownChecksum,
		ExtractedMarkdownSize:     record.ExtractedMarkdownSize,
		CreatedAt:                 record.CreatedAt,
		UpdatedAt:                 record.UpdatedAt,
	}
	return &document, nil
}
