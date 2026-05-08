package slack

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/trknhr/slack-ai-assistant/internal/documents"
	"github.com/trknhr/slack-ai-assistant/internal/idgen"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
)

type AttachmentArchiveService struct {
	bucketName  string
	repository  *repo.SourceDocumentRepository
	s3Client    *s3.Client
	sanitizer   *regexp.Regexp
	extensionRE *regexp.Regexp
}

type ArchiveAttachmentsInput struct {
	WorkspaceID string
	ChannelID   string
	ThreadTS    string
	MessageTS   string
	UserID      string
	Attachments []PreparedAttachment
	Logger      *logger.Logger
}

func NewAttachmentArchiveService(bucketName string, repository *repo.SourceDocumentRepository) *AttachmentArchiveService {
	awsConfig, _ := config.LoadDefaultConfig(context.Background())
	return &AttachmentArchiveService{
		bucketName:  bucketName,
		repository:  repository,
		s3Client:    s3.NewFromConfig(awsConfig),
		sanitizer:   regexp.MustCompile(`[^a-zA-Z0-9._-]+`),
		extensionRE: regexp.MustCompile(`\.[a-zA-Z0-9]+$`),
	}
}

func (s *AttachmentArchiveService) ArchiveAttachments(ctx context.Context, input ArchiveAttachmentsInput) error {
	for _, attachment := range input.Attachments {
		if err := s.archiveAttachment(ctx, input, attachment); err != nil {
			return err
		}
	}
	return nil
}

func (s *AttachmentArchiveService) archiveAttachment(ctx context.Context, input ArchiveAttachmentsInput, attachment PreparedAttachment) error {
	sourceID := idgen.New("src_")
	now := time.Now().UTC().Format(time.RFC3339)
	size := attachment.File.Size
	if len(attachment.ContentBytes) > 0 {
		contentSize := int64(len(attachment.ContentBytes))
		size = &contentSize
	}
	document := documents.SourceDocument{
		SourceID:         sourceID,
		WorkspaceID:      input.WorkspaceID,
		SourceType:       "slack_file",
		SourceRef:        chooseString(attachment.File.Permalink, attachment.File.ID),
		Title:            attachment.Label,
		SlackFileID:      attachment.File.ID,
		SlackPermalink:   attachment.File.Permalink,
		ChannelID:        input.ChannelID,
		ThreadTS:         input.ThreadTS,
		MessageTS:        input.MessageTS,
		UploadedByUserID: input.UserID,
		MimeType:         attachment.MimeType,
		Size:             size,
		Status:           mapAttachmentStatus(attachment.Status),
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if attachment.Status != "ready" || len(attachment.ContentBytes) == 0 {
		_, err := s.repository.Save(ctx, document)
		return err
	}

	hash := sha256.Sum256(attachment.ContentBytes)
	checksum := hex.EncodeToString(hash[:])
	s3Key := s.buildS3Key(input.WorkspaceID, sourceID, attachment.Label, attachment.MimeType, now)
	_, err := s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      &s.bucketName,
		Key:         &s3Key,
		Body:        bytes.NewReader(attachment.ContentBytes),
		ContentType: zeroToNilString(attachment.MimeType),
		Metadata: map[string]string{
			"source_id":     sourceID,
			"workspace_id":  input.WorkspaceID,
			"channel_id":    input.ChannelID,
			"slack_file_id": attachment.File.ID,
		},
	})
	if err != nil {
		document.Checksum = checksum
		document.Status = "archive_failed"
		document.ErrorMessage = err.Error()
		_, saveErr := s.repository.Save(ctx, document)
		if saveErr != nil && input.Logger != nil {
			input.Logger.Warn("Source document metadata persist failed", logger.Fields{"sourceId": document.SourceID, "slackFileId": document.SlackFileID, "error": saveErr.Error()})
		}
		return nil
	}
	document.Checksum = checksum
	document.S3Bucket = s.bucketName
	document.S3Key = s3Key
	document.Status = "archived"
	_, err = s.repository.Save(ctx, document)
	return err
}

func (s *AttachmentArchiveService) buildS3Key(workspaceID string, sourceID string, label string, mimeType string, timestamp string) string {
	date, _ := time.Parse(time.RFC3339, timestamp)
	fileName := s.sanitizeFileName(label, sourceID, mimeType)
	return fmt.Sprintf("raw/private/slack/%s/%04d/%02d/%s/%s", workspaceID, date.UTC().Year(), int(date.UTC().Month()), sourceID, fileName)
}

func (s *AttachmentArchiveService) sanitizeFileName(label string, sourceID string, mimeType string) string {
	rawName := strings.TrimSpace(label)
	if rawName == "" {
		rawName = sourceID
	}
	normalized := s.sanitizer.ReplaceAllString(rawName, "_")
	normalized = strings.Trim(normalized, "_")
	safeBase := normalized
	if safeBase == "" {
		safeBase = sourceID
	}
	if s.extensionRE.MatchString(safeBase) {
		return safeBase
	}
	return safeBase + DefaultExtensionForMimeType(mimeType)
}

func mapAttachmentStatus(status string) string {
	switch status {
	case "ready":
		return "archived"
	case "external_link":
		return "external_link"
	case "skipped_missing_url":
		return "skipped_missing_url"
	case "skipped_oversize":
		return "skipped_oversize"
	case "skipped_unsupported":
		return "skipped_unsupported"
	case "download_failed":
		return "download_failed"
	default:
		return "archived"
	}
}

func zeroToNilString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
