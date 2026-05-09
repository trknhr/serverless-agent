package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/trknhr/slack-ai-assistant/internal/config"
	"github.com/trknhr/slack-ai-assistant/internal/documents"
	"github.com/trknhr/slack-ai-assistant/internal/idgen"
	importcontracts "github.com/trknhr/slack-ai-assistant/internal/imports"
	"github.com/trknhr/slack-ai-assistant/internal/lambdahttp"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/slack"
)

var (
	importEnv                 = config.MustLoadImportAPIEnv()
	importLogger              = logger.Default()
	importAWSConfig, _        = awsconfig.LoadDefaultConfig(context.Background())
	importS3Client            = s3.NewFromConfig(importAWSConfig)
	importS3PresignClient     = s3.NewPresignClient(importS3Client)
	importSQSClient           = sqs.NewFromConfig(importAWSConfig)
	importSourceDocRepository = repo.NewSourceDocumentRepository(dynamodb.NewFromConfig(importAWSConfig), importEnv.SourceDocumentsTableName)
	fileNameSanitizer         = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
	hasExtensionPattern       = regexp.MustCompile(`\.[a-zA-Z0-9]+$`)
)

func main() {
	lambda.Start(handler)
}

func handler(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	log := importLogger.Child(logger.Fields{
		"requestId": event.RequestContext.RequestID,
		"component": "document-import-api",
	})

	switch {
	case event.HTTPMethod == http.MethodPost && event.Resource == "/imports/uploads":
		return createUpload(ctx, event, log), nil
	case event.HTTPMethod == http.MethodPost && event.Resource == "/imports/documents":
		return queueDocumentImport(ctx, event, log), nil
	case event.HTTPMethod == http.MethodPost && event.Resource == "/imports/markdown":
		return ingestMarkdown(ctx, event, log), nil
	case event.HTTPMethod == http.MethodPost && event.Resource == "/imports/extractions/markdown":
		return queueMarkdownExtraction(ctx, event, log), nil
	case event.HTTPMethod == http.MethodGet && event.Resource == "/imports/workspaces/{workspaceId}/sources/{sourceId}":
		return getSourceStatus(ctx, event), nil
	case event.HTTPMethod == http.MethodGet && event.Resource == "/imports/workspaces/{workspaceId}/sources/{sourceId}/markdown":
		return getExtractedMarkdown(ctx, event), nil
	default:
		return lambdahttp.JSON(http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"}), nil
	}
}

func createUpload(ctx context.Context, event events.APIGatewayProxyRequest, log *logger.Logger) events.APIGatewayProxyResponse {
	var input importcontracts.CreateUploadRequest
	if err := parseJSONBody(event, &input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body", "message": err.Error()})
	}
	if err := validateCreateUploadRequest(input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request", "message": err.Error()})
	}
	if !slack.IsSupportedLocalImportMimeType(input.MimeType) {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{
			"ok":        false,
			"error":     "unsupported_mime_type",
			"supported": []string{"application/pdf", "image/jpeg", "image/png"},
		})
	}
	if input.FileSize > int64(importEnv.MaxSlackFileBytes) {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{
			"ok":       false,
			"error":    "file_too_large",
			"maxBytes": importEnv.MaxSlackFileBytes,
		})
	}

	sourceID := idgen.New("src_")
	now := time.Now().UTC().Format(time.RFC3339)
	s3Key := buildLocalImportS3Key(input.WorkspaceID, sourceID, input.FileName, input.MimeType, now)

	presignRequest, err := importS3PresignClient.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      &importEnv.DocumentArchiveBucket,
		Key:         &s3Key,
		ContentType: &input.MimeType,
		Metadata: map[string]string{
			"source_id":    sourceID,
			"workspace_id": input.WorkspaceID,
			"checksum":     input.Checksum,
		},
	}, func(options *s3.PresignOptions) {
		options.Expires = 15 * time.Minute
	})
	if err != nil {
		log.Error("Document upload presign failed", logger.Fields{"error": err.Error(), "sourceId": sourceID})
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error"})
	}

	size := input.FileSize
	document := documents.SourceDocument{
		SourceID:         sourceID,
		WorkspaceID:      input.WorkspaceID,
		SourceType:       "local_file",
		SourceRef:        fallbackString(input.SourcePath, input.FileName),
		Title:            input.FileName,
		UploadedByUserID: input.UserID,
		MimeType:         input.MimeType,
		Size:             &size,
		Checksum:         input.Checksum,
		S3Bucket:         importEnv.DocumentArchiveBucket,
		S3Key:            s3Key,
		Status:           "upload_pending",
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if _, err := importSourceDocRepository.Save(ctx, document); err != nil {
		log.Error("Document upload metadata save failed", logger.Fields{"error": err.Error(), "sourceId": sourceID})
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error"})
	}

	log.Info("Document upload prepared", logger.Fields{
		"sourceId":    sourceID,
		"workspaceId": input.WorkspaceID,
		"mimeType":    input.MimeType,
	})

	return lambdahttp.JSON(http.StatusOK, map[string]any{
		"sourceId":  sourceID,
		"uploadUrl": presignRequest.URL,
		"s3Bucket":  importEnv.DocumentArchiveBucket,
		"s3Key":     s3Key,
		"statusUrl": buildStatusURL(event, input.WorkspaceID, sourceID),
	})
}

func queueDocumentImport(ctx context.Context, event events.APIGatewayProxyRequest, log *logger.Logger) events.APIGatewayProxyResponse {
	var input importcontracts.QueueImportRequest
	if err := parseJSONBody(event, &input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body", "message": err.Error()})
	}
	if err := validateQueueImportRequest(input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request", "message": err.Error()})
	}

	existing, err := importSourceDocRepository.Get(ctx, input.WorkspaceID, input.SourceID)
	if err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	if existing == nil {
		return lambdahttp.JSON(http.StatusNotFound, map[string]any{"ok": false, "error": "source_not_found"})
	}
	if existing.S3Key == "" || existing.S3Bucket == "" {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "missing_archive_location"})
	}

	_, err = importS3Client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: &existing.S3Bucket,
		Key:    &existing.S3Key,
	})
	if err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "archive_missing", "message": err.Error()})
	}

	now := time.Now().UTC().Format(time.RFC3339)
	existing.Status = "queued"
	existing.ErrorMessage = ""
	existing.UpdatedAt = now
	if _, err := importSourceDocRepository.Save(ctx, *existing); err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	if err := enqueueDocumentImport(ctx, event.RequestContext.RequestID, input.WorkspaceID, input.UserID, input.SourceID, "import", input.Prompt, now); err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}

	log.Info("Document import queued", logger.Fields{"sourceId": input.SourceID, "workspaceId": input.WorkspaceID})
	return lambdahttp.JSON(http.StatusAccepted, map[string]any{
		"ok":        true,
		"sourceId":  input.SourceID,
		"statusUrl": buildStatusURL(event, input.WorkspaceID, input.SourceID),
	})
}

func ingestMarkdown(ctx context.Context, event events.APIGatewayProxyRequest, log *logger.Logger) events.APIGatewayProxyResponse {
	var input importcontracts.IngestMarkdownRequest
	if err := parseJSONBody(event, &input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body", "message": err.Error()})
	}
	if err := validateIngestMarkdownRequest(input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request", "message": err.Error()})
	}

	size := int64(len([]byte(input.Markdown)))
	if size > int64(importEnv.MaxSlackFileBytes) {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "file_too_large", "maxBytes": importEnv.MaxSlackFileBytes})
	}

	sourceID := idgen.New("src_")
	now := time.Now().UTC().Format(time.RFC3339)
	checksumBytes := sha256.Sum256([]byte(input.Markdown))
	checksum := hex.EncodeToString(checksumBytes[:])
	s3Key := buildMarkdownImportS3Key(input.WorkspaceID, sourceID, fallbackString(input.SourcePath, input.Title), now)

	_, err := importS3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      &importEnv.DocumentArchiveBucket,
		Key:         &s3Key,
		Body:        strings.NewReader(input.Markdown),
		ContentType: stringPtr("text/markdown; charset=utf-8"),
		Metadata: map[string]string{
			"source_id":    sourceID,
			"workspace_id": input.WorkspaceID,
			"checksum":     checksum,
		},
	})
	if err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}

	document := documents.SourceDocument{
		SourceID:         sourceID,
		WorkspaceID:      input.WorkspaceID,
		SourceType:       "local_file",
		SourceRef:        fallbackString(input.SourcePath, input.Title),
		Title:            input.Title,
		UploadedByUserID: input.UserID,
		MimeType:         "text/markdown",
		Size:             &size,
		Checksum:         checksum,
		S3Bucket:         importEnv.DocumentArchiveBucket,
		S3Key:            s3Key,
		Status:           "queued",
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if _, err := importSourceDocRepository.Save(ctx, document); err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	if err := enqueueDocumentImport(ctx, event.RequestContext.RequestID, input.WorkspaceID, input.UserID, sourceID, "import", input.Prompt, now); err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}

	log.Info("Markdown import queued", logger.Fields{"sourceId": sourceID, "workspaceId": input.WorkspaceID, "sourcePath": input.SourcePath})
	return lambdahttp.JSON(http.StatusAccepted, map[string]any{
		"ok":        true,
		"sourceId":  sourceID,
		"statusUrl": buildStatusURL(event, input.WorkspaceID, sourceID),
	})
}

func queueMarkdownExtraction(ctx context.Context, event events.APIGatewayProxyRequest, log *logger.Logger) events.APIGatewayProxyResponse {
	var input importcontracts.QueueImportRequest
	if err := parseJSONBody(event, &input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body", "message": err.Error()})
	}
	if err := validateQueueImportRequest(input); err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request", "message": err.Error()})
	}

	existing, err := importSourceDocRepository.Get(ctx, input.WorkspaceID, input.SourceID)
	if err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	if existing == nil {
		return lambdahttp.JSON(http.StatusNotFound, map[string]any{"ok": false, "error": "source_not_found"})
	}
	if existing.S3Key == "" || existing.S3Bucket == "" {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "missing_archive_location"})
	}
	if existing.MimeType != "application/pdf" {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "unsupported_mime_type", "supported": []string{"application/pdf"}})
	}

	_, err = importS3Client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: &existing.S3Bucket,
		Key:    &existing.S3Key,
	})
	if err != nil {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "archive_missing", "message": err.Error()})
	}

	now := time.Now().UTC().Format(time.RFC3339)
	existing.ExtractionStatus = "queued"
	existing.ExtractionErrorMessage = ""
	existing.UpdatedAt = now
	if _, err := importSourceDocRepository.Save(ctx, *existing); err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	if err := enqueueDocumentImport(ctx, event.RequestContext.RequestID, input.WorkspaceID, input.UserID, input.SourceID, "extract_markdown", input.Prompt, now); err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}

	log.Info("Markdown extraction queued", logger.Fields{"sourceId": input.SourceID, "workspaceId": input.WorkspaceID})
	return lambdahttp.JSON(http.StatusAccepted, map[string]any{
		"ok":        true,
		"sourceId":  input.SourceID,
		"statusUrl": buildStatusURL(event, input.WorkspaceID, input.SourceID),
	})
}

func getSourceStatus(ctx context.Context, event events.APIGatewayProxyRequest) events.APIGatewayProxyResponse {
	workspaceID := event.PathParameters["workspaceId"]
	sourceID := event.PathParameters["sourceId"]
	if workspaceID == "" || sourceID == "" {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "missing_path_parameters"})
	}

	source, err := importSourceDocRepository.Get(ctx, workspaceID, sourceID)
	if err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	if source == nil {
		return lambdahttp.JSON(http.StatusNotFound, map[string]any{"ok": false, "error": "source_not_found"})
	}

	body := map[string]any{
		"sourceId":                  source.SourceID,
		"workspaceId":               source.WorkspaceID,
		"sourceType":                source.SourceType,
		"sourceRef":                 source.SourceRef,
		"title":                     source.Title,
		"slackFileId":               source.SlackFileID,
		"slackPermalink":            source.SlackPermalink,
		"channelId":                 source.ChannelID,
		"threadTs":                  source.ThreadTS,
		"messageTs":                 source.MessageTS,
		"uploadedByUserId":          source.UploadedByUserID,
		"mimeType":                  source.MimeType,
		"size":                      source.Size,
		"checksum":                  source.Checksum,
		"s3Bucket":                  source.S3Bucket,
		"s3Key":                     source.S3Key,
		"status":                    source.Status,
		"summary":                   source.Summary,
		"importedTaskIds":           source.ImportedTaskIDs,
		"savedMemoryIds":            source.SavedMemoryIDs,
		"errorMessage":              source.ErrorMessage,
		"extractionStatus":          source.ExtractionStatus,
		"extractionErrorMessage":    source.ExtractionErrorMessage,
		"extractedMarkdownS3Bucket": source.ExtractedMarkdownS3Bucket,
		"extractedMarkdownS3Key":    source.ExtractedMarkdownS3Key,
		"extractedMarkdownChecksum": source.ExtractedMarkdownChecksum,
		"extractedMarkdownSize":     source.ExtractedMarkdownSize,
		"createdAt":                 source.CreatedAt,
		"updatedAt":                 source.UpdatedAt,
	}
	if source.ExtractionStatus == "extracted" && source.ExtractedMarkdownS3Key != "" {
		body["extractedMarkdownUrl"] = buildExtractedMarkdownURL(event, workspaceID, sourceID)
	}
	return lambdahttp.JSON(http.StatusOK, body)
}

func getExtractedMarkdown(ctx context.Context, event events.APIGatewayProxyRequest) events.APIGatewayProxyResponse {
	workspaceID := event.PathParameters["workspaceId"]
	sourceID := event.PathParameters["sourceId"]
	if workspaceID == "" || sourceID == "" {
		return lambdahttp.JSON(http.StatusBadRequest, map[string]any{"ok": false, "error": "missing_path_parameters"})
	}

	source, err := importSourceDocRepository.Get(ctx, workspaceID, sourceID)
	if err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	if source == nil {
		return lambdahttp.JSON(http.StatusNotFound, map[string]any{"ok": false, "error": "source_not_found"})
	}
	if source.ExtractionStatus != "extracted" || source.ExtractedMarkdownS3Bucket == "" || source.ExtractedMarkdownS3Key == "" {
		return lambdahttp.JSON(http.StatusNotFound, map[string]any{"ok": false, "error": "extracted_markdown_not_found"})
	}

	output, err := importS3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &source.ExtractedMarkdownS3Bucket,
		Key:    &source.ExtractedMarkdownS3Key,
	})
	if err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	defer output.Body.Close()

	content, err := io.ReadAll(output.Body)
	if err != nil {
		return lambdahttp.JSON(http.StatusInternalServerError, map[string]any{"ok": false, "error": "internal_error", "message": err.Error()})
	}
	return events.APIGatewayProxyResponse{
		StatusCode: http.StatusOK,
		Headers: map[string]string{
			"content-type": "text/markdown; charset=utf-8",
		},
		Body: string(content),
	}
}

func enqueueDocumentImport(ctx context.Context, requestID string, workspaceID string, userID string, sourceID string, operation string, prompt string, queuedAt string) error {
	correlationID := requestID + ":" + sourceID
	payload, err := json.Marshal(importcontracts.QueueMessage{
		CorrelationID: correlationID,
		WorkspaceID:   workspaceID,
		UserID:        userID,
		SourceID:      sourceID,
		Operation:     operation,
		Prompt:        prompt,
		QueuedAt:      queuedAt,
	})
	if err != nil {
		return err
	}

	_, err = importSQSClient.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    &importEnv.DocumentImportQueueURL,
		MessageBody: stringPtr(string(payload)),
	})
	return err
}

func buildLocalImportS3Key(workspaceID string, sourceID string, fileName string, mimeType string, timestamp string) string {
	date, _ := time.Parse(time.RFC3339, timestamp)
	year, month := date.UTC().Year(), int(date.UTC().Month())
	safeName := sanitizeFileName(fileName, sourceID, mimeType)
	return fmt.Sprintf("raw/private/imports/%s/%04d/%02d/%s/%s", workspaceID, year, month, sourceID, safeName)
}

func buildMarkdownImportS3Key(workspaceID string, sourceID string, title string, timestamp string) string {
	date, _ := time.Parse(time.RFC3339, timestamp)
	year, month := date.UTC().Year(), int(date.UTC().Month())
	safeName := sanitizeFileName(title, sourceID, "text/markdown")
	return fmt.Sprintf("raw/private/notes/%s/%04d/%02d/%s/%s", workspaceID, year, month, sourceID, safeName)
}

func sanitizeFileName(fileName string, sourceID string, mimeType string) string {
	trimmed := strings.TrimSpace(fileName)
	normalized := fileNameSanitizer.ReplaceAllString(trimmed, "_")
	normalized = strings.Trim(normalized, "_")
	safeBase := normalized
	if safeBase == "" {
		safeBase = sourceID
	}
	if hasExtensionPattern.MatchString(safeBase) {
		return safeBase
	}
	return safeBase + slack.DefaultExtensionForMimeType(mimeType)
}

func buildStatusURL(event events.APIGatewayProxyRequest, workspaceID string, sourceID string) string {
	return fmt.Sprintf("https://%s/%s/imports/workspaces/%s/sources/%s", event.RequestContext.DomainName, event.RequestContext.Stage, url.PathEscape(workspaceID), url.PathEscape(sourceID))
}

func buildExtractedMarkdownURL(event events.APIGatewayProxyRequest, workspaceID string, sourceID string) string {
	return fmt.Sprintf("https://%s/%s/imports/workspaces/%s/sources/%s/markdown", event.RequestContext.DomainName, event.RequestContext.Stage, url.PathEscape(workspaceID), url.PathEscape(sourceID))
}

func parseJSONBody(event events.APIGatewayProxyRequest, target any) error {
	body := event.Body
	if event.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			return err
		}
		body = string(decoded)
	}
	if strings.TrimSpace(body) == "" {
		body = "{}"
	}
	return json.Unmarshal([]byte(body), target)
}

func validateCreateUploadRequest(input importcontracts.CreateUploadRequest) error {
	switch {
	case strings.TrimSpace(input.WorkspaceID) == "":
		return errors.New("workspaceId is required")
	case strings.TrimSpace(input.UserID) == "":
		return errors.New("userId is required")
	case strings.TrimSpace(input.FileName) == "":
		return errors.New("fileName is required")
	case strings.TrimSpace(input.MimeType) == "":
		return errors.New("mimeType is required")
	case input.FileSize <= 0:
		return errors.New("fileSize must be positive")
	case strings.TrimSpace(input.Checksum) == "":
		return errors.New("checksum is required")
	default:
		return nil
	}
}

func validateQueueImportRequest(input importcontracts.QueueImportRequest) error {
	switch {
	case strings.TrimSpace(input.WorkspaceID) == "":
		return errors.New("workspaceId is required")
	case strings.TrimSpace(input.UserID) == "":
		return errors.New("userId is required")
	case strings.TrimSpace(input.SourceID) == "":
		return errors.New("sourceId is required")
	default:
		return nil
	}
}

func validateIngestMarkdownRequest(input importcontracts.IngestMarkdownRequest) error {
	switch {
	case strings.TrimSpace(input.WorkspaceID) == "":
		return errors.New("workspaceId is required")
	case strings.TrimSpace(input.UserID) == "":
		return errors.New("userId is required")
	case strings.TrimSpace(input.Title) == "":
		return errors.New("title is required")
	case strings.TrimSpace(input.Markdown) == "":
		return errors.New("markdown is required")
	default:
		return nil
	}
}

func fallbackString(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func stringPtr(value string) *string {
	return &value
}
